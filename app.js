import * as G from './geo.js';
const { dist, clamp, project, idxAt, pointAt, cumul } = G;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('ekimap.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('ekimap.' + k, JSON.stringify(v)); } catch (e) {} },
};
const fmtD = m => (m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km');
const hhmm = t => { const d = new Date(t); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };

/* ---------- キャッシュ（Service Worker） ---------- */
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));

/* ---------- 路線データの版（data/meta.json が無ければ Overpass を直接使う） ---------- */
const metaReady = fetch('data/meta.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
  .then(m => { S.meta = m; S.mode = m ? 'static' : 'live'; });

/* ---------- 状態 ---------- */
const S = {
  pos: null, src: 'gps', routes: new Map(), groups: new Map(), stations: new Map(), byName: new Map(),
  nearKeys: new Set(), nearCenter: null, showFar: LS.get('far', false), style: LS.get('mapStyle', 'pale'),
  ride: null, follow: true, hist: new Map(), demo: null, demoMult: LS.get('mult', 5), speeds: [], loading: 0, lastSug: '',
  mode: 'static', meta: null,
};

/* ---------- 地図 ---------- */
const startView = LS.get('view', null);
const map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 5, maxZoom: 19 })
  .setView(startView ? startView.c : [35.6812, 139.7671], startView ? startView.z : 14);
map.attributionControl.setPrefix(false);
map.createPane('lines').style.zIndex = 410;
map.createPane('ride').style.zIndex = 420;
const rLines = L.canvas({ pane: 'lines', padding: 0.5 }), rRide = L.canvas({ pane: 'ride', padding: 0.5 });
const ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a> | 路線・駅 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const TILES = { std: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', pale: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', photo: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg' };
let base = null;
function setStyle(k) {
  if (!TILES[k]) k = 'pale'; S.style = k; LS.set('mapStyle', k);
  if (base) map.removeLayer(base);
  base = L.tileLayer(TILES[k], { maxNativeZoom: 18, maxZoom: 19, attribution: ATTR, crossOrigin: 'anonymous' }).addTo(map);
  document.querySelectorAll('#segStyle button').forEach(b => b.setAttribute('aria-pressed', b.dataset.style === k));
}
setStyle(S.style);

/* ---------- データ：路線・駅の登録 ---------- */
function stationFor(sid, name, lat, lon) {
  if (sid) {
    let st = S.stations.get(sid);
    if (!st) { st = { key: sid, name, lat, lon, keys: new Set(), routes: new Set() }; S.stations.set(sid, st); }
    return st;
  }
  for (const st of S.byName.get(name) || []) if (dist([st.lat, st.lon], [lat, lon]) < 800) return st;
  const st = { key: 'L' + S.stations.size, name, lat, lon, keys: new Set(), routes: new Set() };
  S.stations.set(st.key, st); (S.byName.get(name) || S.byName.set(name, []).get(name)).push(st);
  return st;
}
function addRoute(r) {
  if (S.routes.has(r.id)) return S.routes.get(r.id);
  r.cum = cumul(r.chain); r.len = r.cum[r.cum.length - 1];
  const lats = r.chain.map(p => p[0]), lons = r.chain.map(p => p[1]);
  r.bbox = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  let g = S.groups.get(r.key);
  if (!g) { g = { key: r.key, name: r.lineName, colour: r.colour || G.hashColour(r.key), routes: [], layer: null }; S.groups.set(r.key, g); }
  if (!r.colour) r.colour = g.colour;
  g.routes.push(r); if (g.layer) { g.layer.remove(); g.layer = null; }
  for (const s of r.stops) { const st = stationFor(s.sid, s.name, s.lat, s.lon); st.keys.add(r.key); st.routes.add(r.id); s.st = st; }
  S.routes.set(r.id, r);
  return r;
}

/* ---------- データ：事前生成した静的ファイル ---------- */
const jsonCache = new Map();
function getJSON(url) {
  if (!jsonCache.has(url)) jsonCache.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null));
  return jsonCache.get(url);
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); }
const tileKeys = (s, w, n, e) => {
  const T = S.meta.tile, out = [];
  for (let x = Math.floor(w / T); x <= Math.floor(e / T); x++) for (let y = Math.floor(s / T); y <= Math.floor(n / T); y++) out.push(x + '_' + y);
  return out;
};
const seenTiles = new Set();
async function loadTiles(keys) {
  const ids = new Set();
  await pool(keys, 8, async k => {
    const t = await getJSON(`data/t/${k}.json`); if (!t) return;
    if (!seenTiles.has(k)) { seenTiles.add(k); for (const [sid, name, lat, lon] of t.st) stationFor(sid, name, lat, lon); }
    t.r.forEach(id => ids.add(id));
  });
  const todo = [...ids].filter(id => !S.routes.has(id));
  await pool(todo, 8, async id => {
    const m = await getJSON(`data/r/${id}.json`); if (!m || S.routes.has(id)) return;
    const sh = await getJSON(`data/s/${m.sh}.json`); if (!sh) return;
    addRoute({
      id: m.id, name: m.n, lineName: m.l, key: m.k, colour: m.c, svc: m.svc, to: m.to, kind: m.kind, loop: m.loop, shape: m.sh,
      chain: G.decodeShape(sh), stops: m.st.map(([sid, name, lat, lon, s]) => ({ sid, name, lat, lon, s })),
    });
  });
  return [...ids];
}
async function loadNearStatic(lat, lon, radius) {
  const dLat = radius / 111000, dLon = radius / (111000 * Math.cos(lat * G.rad));
  const ids = await loadTiles(tileKeys(lat - dLat, lon - dLon, lat + dLat, lon + dLon));
  const near = new Set();
  for (const id of ids) { const r = S.routes.get(id); if (r && project(r.chain, r.cum, [lat, lon]).d <= radius) near.add(r.key); }
  return near;
}

/* ---------- データ：Overpass を直接使う（data/ が無いときの代替） ---------- */
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const railQuery = area => `[out:json][timeout:90];
way${area}[railway~"^(rail|subway|light_rail|monorail|narrow_gauge|tram)$"]->.w0;
rel(bw.w0)[type=route][route~"^(train|subway|light_rail|monorail|tram)$"]->.r;
.r out body qt;
rel(br.r)[type=route_master];out tags qt;
way(r.r)->.w;.w out skel geom qt;
node(r.r)->.n;.n out body qt;`;
async function overpass(q) {
  let last;
  for (const u of OVERPASS) {
    try {
      const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(q) });
      if (res.ok) return await res.json();
      last = new Error('HTTP ' + res.status);
    } catch (e) { last = e; }
  }
  throw last;
}
const live = { nodes: new Map(), ways: new Map(), masterOf: new Map() };
function ingestLive(j) {
  const rels = [], got = [];
  for (const e of j.elements || []) {
    if (e.type === 'node') live.nodes.set(e.id, { lat: e.lat, lon: e.lon, tags: e.tags || {} });
    else if (e.type === 'way' && e.geometry) live.ways.set(e.id, e.geometry.filter(Boolean).map(p => [p.lat, p.lon]));
    else if (e.type === 'relation') {
      if (e.tags && e.tags.type === 'route_master') (e.members || []).forEach(m => { if (m.type === 'relation') live.masterOf.set(m.ref, e); });
      else rels.push(e);
    }
  }
  const nameNear = G.makeNameNear(live.nodes);
  for (const r of rels) {
    if (S.routes.has(r.id)) { got.push(r.id); continue; }
    try { const b = G.buildRoute(r, { ...live, nameNear }); if (b) { addRoute(b); got.push(r.id); } } catch (e) { console.warn('route', r.id, e); }
  }
  return got;
}
async function loadNearLive(lat, lon, radius) {
  const got = ingestLive(await overpass(railQuery(`(around:${radius},${lat.toFixed(5)},${lon.toFixed(5)})`)));
  return new Set(got.map(id => S.routes.get(id).key));
}

/* ---------- 近くの路線・遠くの路線の読み込み ---------- */
let nearBusy = false;
async function loadNear(lat, lon) {
  if (nearBusy) return; nearBusy = true; S.loading++; renderTop();
  try {
    await metaReady;
    const fn = S.mode === 'static' ? loadNearStatic : loadNearLive;
    let near = await fn(lat, lon, 1500);
    if (!near.size) near = await fn(lat, lon, 6000);
    S.nearKeys = near; S.nearCenter = [lat, lon];
    afterData();
  } catch (e) {
    console.warn(e); toast('路線データを取得できませんでした', { label: '再試行', fn: () => loadNear(lat, lon) });
  } finally { nearBusy = false; S.loading = Math.max(0, S.loading - 1); renderTop(); }
}
let farBusy = false; const farBoxes = [];
async function loadFar() {
  if (!S.showFar || farBusy) return;
  const minZ = S.mode === 'static' ? 11 : 12;
  if (map.getZoom() < minZ) { toast('遠くの路線は、もう少し拡大すると読み込みます'); return; }
  const b = map.getBounds();
  if (farBoxes.some(x => x.contains(b))) return;
  const big = b.pad(S.mode === 'static' ? 0.15 : 0.3);
  farBusy = true; S.loading++; renderTop();
  try {
    await metaReady;
    if (S.mode === 'static') {
      const keys = tileKeys(big.getSouth(), big.getWest(), big.getNorth(), big.getEast());
      if (keys.length > 120) { toast('範囲が広すぎます。もう少し拡大してください'); return; }
      await loadTiles(keys);
    } else {
      ingestLive(await overpass(railQuery(`(${big.getSouth().toFixed(4)},${big.getWest().toFixed(4)},${big.getNorth().toFixed(4)},${big.getEast().toFixed(4)})`)));
    }
    farBoxes.push(big); afterData();
  } catch (e) { console.warn(e); toast('遠くの路線を取得できませんでした', { label: '再試行', fn: loadFar }); }
  finally { farBusy = false; S.loading = Math.max(0, S.loading - 1); renderTop(); }
}

/* ---------- 線と駅の描画 ---------- */
const groupVisible = g => !!g && (S.ride ? (S.ride.route.key === g.key || S.showFar) : (S.showFar || S.nearKeys.has(g.key)));
let rideLayer = null, rideAhead = null, rideBehind = null;
function drawLines() {
  const rideKey = S.ride && S.ride.route.key;
  for (const g of S.groups.values()) {
    const vis = groupVisible(g);
    if (vis && !g.layer) {
      const seen = new Set(), lines = [];
      for (const r of g.routes) { const k = r.shape || r.id; if (!seen.has(k)) { seen.add(k); lines.push(r.chain); } }
      g.casing = L.polyline(lines, { renderer: rLines, color: '#fff', weight: 8, opacity: 0.95, interactive: false, lineCap: 'round' });
      g.main = L.polyline(lines, { renderer: rLines, color: g.colour, weight: 4.5, opacity: 1, interactive: false, lineCap: 'round' });
      g.layer = L.layerGroup([g.casing, g.main]);
    }
    if (!g.layer) continue;
    if (vis && !map.hasLayer(g.layer)) g.layer.addTo(map);
    if (!vis && map.hasLayer(g.layer)) g.layer.remove();
    const dim = S.ride && g.key !== rideKey;
    g.main.setStyle({ opacity: dim ? 0.12 : 1, weight: dim ? 3 : 4.5 }); g.casing.setStyle({ opacity: dim ? 0 : 0.95 });
  }
  if (rideLayer) { rideLayer.remove(); rideLayer = null; }
  if (S.ride) {
    const r = S.ride.route;
    rideLayer = L.layerGroup([
      L.polyline(r.chain, { renderer: rRide, color: '#fff', weight: 13, opacity: 1, interactive: false }),
      (rideBehind = L.polyline([], { renderer: rRide, color: '#9aa3ad', weight: 8, interactive: false })),
      (rideAhead = L.polyline(r.chain, { renderer: rRide, color: r.colour, weight: 8, interactive: false })),
    ]).addTo(map);
    updateRideLine();
  }
}
function updateRideLine() {
  if (!S.ride || !rideAhead) return;
  const r = S.ride.route, s = S.ride.s, i = idxAt(r.cum, s), p = pointAt(r.chain, r.cum, s);
  rideBehind.setLatLngs(r.chain.slice(0, i + 1).concat([p])); rideAhead.setLatLngs([p].concat(r.chain.slice(i + 1)));
}
const stMarks = new Map();
function textW(s, fs) { let w = 0; for (const c of s) w += c.charCodeAt(0) > 255 ? fs : fs * 0.6; return w; }
const stColour = st => { for (const k of st.keys) { const g = S.groups.get(k); if (g && groupVisible(g)) return g.colour; } const g = S.groups.get([...st.keys][0]); return g ? g.colour : '#555'; };
function updateLabels() {
  const z = map.getZoom(), b = map.getBounds().pad(0.15), R = S.ride;
  const rideSt = new Map();
  if (R) { const nx = nextInfo(R); R.route.stops.forEach((st, i) => rideSt.set(st.st, { i, past: i < (nx.k ?? Infinity) && nx.at !== i, next: nx.at === i || (nx.at == null && i === nx.k) })); }
  const me = S.pos ? [S.pos.lat, S.pos.lon] : [map.getCenter().lat, map.getCenter().lng];
  let cand = [];
  for (const st of S.stations.values()) {
    if (!b.contains([st.lat, st.lon])) continue;
    if (rideSt.has(st) || (z >= 11 && [...st.keys].some(k => groupVisible(S.groups.get(k))))) cand.push(st);
  }
  cand.forEach(st => { st.pr = (rideSt.has(st) ? 0 : 1e7) + dist(me, [st.lat, st.lon]) - st.keys.size * 400 - (rideSt.get(st)?.next ? 1e8 : 0); });
  cand.sort((a, b) => a.pr - b.pr);
  if (cand.length > 500) cand = cand.slice(0, 500);
  const keep = new Set(cand), boxes = [];
  for (const [st, m] of stMarks) if (!keep.has(st)) { m.remove(); stMarks.delete(st); }
  for (const st of cand) {
    const rs = rideSt.get(st), c = rs ? R.route.colour : stColour(st);
    let m = stMarks.get(st);
    if (!m) {
      m = L.marker([st.lat, st.lon], { icon: L.divIcon({ className: 'st', html: `<div class="in"><i></i><b>${esc(st.name)}</b></div>`, iconSize: null }), keyboard: false, riseOnHover: true });
      m.on('click', () => onStationTap(st)); m.addTo(map); stMarks.set(st, m);
    }
    const el = m.getElement(); if (!el) continue;
    el.querySelector('.in').style.setProperty('--c', c);
    const fs = rs && rs.next ? 17 : rs ? 15 : 13.5;
    const pt = map.latLngToContainerPoint([st.lat, st.lon]), w = textW(st.name, fs) + 26, h = fs + 12;
    let side = null;
    if (z >= 12 || rs) {
      const R1 = { x: pt.x - 7, y: pt.y - h / 2, w, h }, R2 = { x: pt.x - w + 7, y: pt.y - h / 2, w, h };
      const hit = r => boxes.some(o => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
      if (!hit(R1)) { side = 'R'; boxes.push(R1); } else if (!hit(R2)) { side = 'L'; boxes.push(R2); }
    }
    el.classList.toggle('nolab', !side); el.classList.toggle('L', side === 'L');
    el.classList.toggle('on', !!rs); el.classList.toggle('past', !!(rs && rs.past)); el.classList.toggle('next', !!(rs && rs.next));
    m.setZIndexOffset(rs && rs.next ? 900 : rs ? 500 : side ? 100 : 0);
  }
}
let meMark = null, accCirc = null;
function drawMe() {
  let p = S.pos ? [S.pos.lat, S.pos.lon] : null;
  if (S.ride) p = pointAt(S.ride.route.chain, S.ride.route.cum, S.ride.s);
  if (!p) return;
  if (!meMark) {
    meMark = L.marker(p, { icon: L.divIcon({ className: 'me', html: '<i></i>', iconSize: null }), interactive: false, zIndexOffset: 2000 }).addTo(map);
    accCirc = L.circle(p, { radius: 10, color: '#1a73e8', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
  }
  meMark.setLatLng(p);
  meMark.getElement() && meMark.getElement().classList.toggle('est', !!(S.ride && S.ride.mode === 'est'));
  if (S.pos && !S.ride) { accCirc.setLatLng([S.pos.lat, S.pos.lon]).setRadius(Math.min(S.pos.acc || 10, 2000)); accCirc.setStyle({ opacity: 1, fillOpacity: 0.08 }); }
  else accCirc.setStyle({ opacity: 0, fillOpacity: 0 });
  if (S.follow) followTo(p);
}
function followTo(p, force) {
  const z = map.getZoom(), pt = map.project(p, z), wide = window.innerWidth >= 900;
  const top = $('#now').offsetHeight + 10, sh = wide ? 0 : $('#sheet').offsetHeight;
  pt.y += (sh - top) / 2; if (wide) pt.x -= 230;
  const tgt = map.unproject(pt, z);
  if (force || map.latLngToContainerPoint(p).distanceTo(map.latLngToContainerPoint(map.getCenter())) > 4) map.panTo(tgt, { animate: true, duration: 0.6 });
}

/* ---------- 走行モデル ---------- */
const VMAX = { shin: 70, sub: 20, tram: 10, mono: 15, train: 24 }, PEN = { shin: 150, sub: 40, tram: 20, mono: 35, train: 40 }, DWELL = { shin: 60, sub: 30, tram: 20, mono: 30, train: 30 };
const segT = (r, d) => d / ((r.kind === 'train' && /特急|快速|急行|ライナー/.test(r.svc)) ? 28 : VMAX[r.kind]) + PEN[r.kind] * Math.min(1, d / 800);
function avgSpeed(sec) { const now = Date.now(), a = S.speeds.filter(x => now - x.t < sec * 1000); return a.length ? a.reduce((s, x) => s + x.v, 0) / a.length : 0; }
const nextIdx = (r, s) => { for (let i = 0; i < r.stops.length; i++) if (r.stops[i].s > s + 15) return i; return null; };
function nextInfo(R) {
  const r = R.route, now = Date.now();
  const at = R.atK != null && (R.mode === 'gps' || R.dwellUntil > now) ? R.atK : null;
  const k = at != null ? at + 1 : nextIdx(r, R.s);
  const out = { at, k: k != null && k < r.stops.length ? k : null, eta: [] };
  if (out.k == null) return out;
  let t = 0;
  if (at != null) t += Math.max(0, (R.dwellUntil - now) / 1000);
  const prevS = r.stops[out.k - 1] ? r.stops[out.k - 1].s : 0, d = Math.max(1, r.stops[out.k].s - prevS), rem = Math.max(0, r.stops[out.k].s - Math.max(R.s, prevS));
  let base = segT(r, d) * rem / d; const v = avgSpeed(10);
  if (R.mode === 'gps' && v > 3 && at == null) base = 0.5 * base + 0.5 * (rem / v + PEN[r.kind] * 0.3 * rem / d);
  t += base; out.eta[out.k] = t;
  for (let j = out.k + 1; j < r.stops.length; j++) { t += DWELL[r.kind] + segT(r, r.stops[j].s - r.stops[j - 1].s); out.eta[j] = t; }
  return out;
}
function startRide(r, k) {
  const now = Date.now(); let s = r.stops[0].s;
  if (k != null) s = r.stops[k].s;
  else if (S.pos) { const p = project(r.chain, r.cum, [S.pos.lat, S.pos.lon]); if (p.d < 400) s = p.s; }
  S.ride = { route: r, s, t: now, mode: 'est', atK: k != null ? k : null, dwellUntil: k != null ? now + DWELL[r.kind] * 1000 : 0, sel: null };
  map.closePopup(); S.follow = true; $('#bLoc').classList.add('on'); $('#sheet').classList.remove('min');
  drawLines(); renderSheet(true); rideStep();
  if (map.getZoom() < 14) map.setZoom(14);
}
function endRide() { S.ride = null; stopDemo(); drawLines(); renderSheet(true); renderTop(); updateLabels(); drawMe(); }
function rideStep() {
  const R = S.ride; if (!R) return;
  const r = R.route, now = Date.now(), dt = Math.min(10, (now - R.t) / 1000); R.t = now;
  const p = S.pos; let gps = false;
  if (p && S.src !== 'manual' && now - p.t < 12000 && (p.acc || 0) < 200) {
    const pr = project(r.chain, r.cum, [p.lat, p.lon]);
    if (pr.d < Math.max(250, p.acc || 0)) { gps = true; R.s = pr.s; }
  }
  R.mode = gps ? 'gps' : 'est';
  if (gps) {
    const v = avgSpeed(8); let near = null, nd = 80;
    r.stops.forEach((st, i) => { const d = Math.abs(st.s - R.s); if (d < nd) { nd = d; near = i; } });
    if (near != null && v < 1.5) { if (R.atK !== near) { R.atK = near; R.dwellUntil = now + DWELL[r.kind] * 1000; } }
    else if (v > 3) { R.atK = null; R.dwellUntil = 0; }
  } else if (R.dwellUntil > now) { /* 停車中 */ }
  else {
    if (R.atK != null) { R.s = Math.max(R.s, r.stops[R.atK].s + 16); R.atK = null; }
    const k = nextIdx(r, R.s);
    if (k != null) {
      const prevS = r.stops[k - 1] ? r.stops[k - 1].s : 0, d = Math.max(1, r.stops[k].s - prevS), v = d / segT(r, d);
      let ns = R.s + v * dt;
      if (ns >= r.stops[k].s) { ns = r.stops[k].s; R.atK = k; R.dwellUntil = now + DWELL[r.kind] * 1000; }
      R.s = ns;
    }
  }
  updateRideLine(); drawMe(); renderTop(); renderRide();
}

/* ---------- 乗っている路線の候補 ---------- */
function candidates() {
  if (!S.pos) return [];
  const p = [S.pos.lat, S.pos.lon], thr = clamp((S.pos.acc || 30) * 1.5 + 40, 80, 400), now = Date.now(), out = [];
  const pad = thr / 111000;
  for (const r of S.routes.values()) {
    const b = r.bbox; if (p[0] < b[0] - pad || p[0] > b[2] + pad || p[1] < b[1] - pad * 1.3 || p[1] > b[3] + pad * 1.3) continue;
    const pr = project(r.chain, r.cum, p); if (pr.d > thr) continue;
    const h = S.hist.get(r.id) || []; h.push({ t: now, s: pr.s }); while (h.length && now - h[0].t > 45000) h.shift(); S.hist.set(r.id, h);
    let ds = h.length > 1 ? h[h.length - 1].s - h[0].s : 0; if (r.loop && Math.abs(ds) > r.len / 2) ds -= Math.sign(ds) * r.len;
    const k = nextIdx(r, pr.s); if (k == null) continue;
    if (ds < -40) continue; // 逆方向に進んでいる系統は除外
    out.push({ r, d: pr.d, s: pr.s, k, score: pr.d - (ds > 40 ? 30 : 0), moving: ds > 40 });
  }
  out.sort((a, b) => a.score - b.score);
  // 同じ路線で次の駅も同じ＝同じ向き。行き先違いはまとめて「A・B方面」にする
  const merged = new Map();
  for (const c of out) {
    const sig = c.r.key + '|' + c.r.svc + '|' + c.r.stops[c.k].name;
    const m = merged.get(sig);
    if (m) { m.tos.add(c.r.to); m.moving = m.moving || c.moving; } else merged.set(sig, { ...c, tos: new Set([c.r.to]) });
  }
  return [...merged.values()].slice(0, 8);
}
function nearbyStations(n) {
  const p = S.pos ? [S.pos.lat, S.pos.lon] : [map.getCenter().lat, map.getCenter().lng], out = [];
  for (const st of S.stations.values()) if ([...st.keys].some(k => groupVisible(S.groups.get(k)))) out.push({ st, d: dist(p, [st.lat, st.lon]) });
  return out.sort((a, b) => a.d - b.d).slice(0, n);
}
const dotsOf = st => `<span class="dots">${[...st.keys].slice(0, 6).map(k => `<i style="--c:${esc(S.groups.get(k).colour)}"></i>`).join('')}</span>`;
const linesOf = st => [...new Set([...st.keys].map(k => S.groups.get(k).name))].slice(0, 3).map(esc).join('・');
const dirText = r => `${r.svc ? r.svc + '・' : ''}${r.to}${r.loop ? 'まで' : '方面'}`;
function pickHTML(c, top) {
  const r = c.r;
  return `<button class="pick${top ? ' top' : ''}" style="--c:${esc(r.colour)}" data-act="ride" data-r="${r.id}"><span class="bar"></span>
    <span class="tx"><b>${esc(r.lineName)}</b><span class="sub">${esc((r.svc ? r.svc + '・' : '') + [...c.tos].slice(0, 3).join('・') + (r.loop ? 'まで' : '方面'))}・次は${esc(r.stops[c.k].name)}</span></span>
    <span class="r">${c.moving ? '進行方向' : ''}</span></button>`;
}

/* ---------- 画面 ---------- */
function renderTop() {
  const R = S.ride, nL = $('#nLine'), nB = $('#nBadge'), nLead = $('#nLead'), nName = $('#nName'), nEta = $('#nEta'), nFoot = $('#nFoot'), card = $('#now');
  if (R) {
    const r = R.route, nx = nextInfo(R), now = Date.now();
    card.style.setProperty('--lc', r.colour);
    nL.textContent = `${r.lineName}　${dirText(r)}`;
    nB.className = 'badge ' + (S.demo ? 'est' : R.mode); nB.textContent = S.demo ? 'デモ' : R.mode === 'gps' ? 'GPS' : '推定';
    if (nx.k == null) { nLead.textContent = '終点'; nName.textContent = r.stops[r.stops.length - 1].name; nEta.innerHTML = '<span class="sub">到着</span>'; nFoot.textContent = '「降りる」で終了します'; return; }
    const t = nx.eta[nx.k], st = r.stops[nx.k];
    nLead.textContent = nx.at != null ? `ただいま ${r.stops[nx.at].name} に停車中・次は` : '次は';
    nName.textContent = st.name;
    nEta.innerHTML = t < 45
      ? `<span class="t" style="font-size:clamp(24px,7vw,32px)">まもなく</span><span class="when">${hhmm(now + t * 1000)} 着見込み</span>`
      : `<span class="sub" style="font-size:13px">あと</span><span class="t">${Math.ceil(t / 60)}</span><small class="lab">分</small><span class="when">${hhmm(now + t * 1000)} 着見込み</span>`;
    nFoot.innerHTML = `<span>${nx.at != null ? '停車中' : '駅まで ' + fmtD(Math.max(0, st.s - R.s))}</span>${dotsOf(st.st)}`;
    return;
  }
  card.style.setProperty('--lc', 'var(--faint)');
  nB.className = 'badge' + (S.pos && S.src === 'gps' ? ' gps' : '');
  nB.textContent = S.src === 'manual' ? '手動' : S.pos ? `±${Math.round(S.pos.acc || 0)}m` : 'GPS';
  nL.textContent = S.loading ? '路線データを読み込み中…' : S.pos ? '現在地付近' : '現在地を確認しています（地図の中心を表示中）';
  const ns = nearbyStations(1)[0];
  nEta.innerHTML = '';
  if (ns) {
    nLead.textContent = '最寄り駅'; nName.textContent = ns.st.name;
    nEta.innerHTML = `<span class="t" style="font-size:26px">${fmtD(ns.d).replace(/ (m|km)/, '<small class="lab"> $1</small>')}</span>`;
    nFoot.innerHTML = `${dotsOf(ns.st)}<span>${linesOf(ns.st)}</span>`;
  } else { nLead.textContent = ''; nName.textContent = S.loading ? '…' : '駅が見つかりません'; nFoot.textContent = S.loading ? '' : '地図を動かすか「遠くの路線」をオンにしてください'; }
}
function renderSheet(force) {
  const B = $('#sbody');
  if (S.ride) { if (force || !B.querySelector('.strip')) buildRide(); renderRide(); return; }
  const cs = candidates();
  const sig = cs.map(c => c.r.id + ':' + c.k).join(',') + '|' + S.stations.size + '|' + S.nearKeys.size + '|' + S.showFar + '|' + (S.pos ? Math.round(S.pos.lat * 2000) + ',' + Math.round(S.pos.lon * 2000) : '');
  if (!force && sig === S.lastSug) return; S.lastSug = sig;
  const ns = nearbyStations(6);
  B.innerHTML = `
    <div class="hd"><h2>乗っている路線は？</h2><span class="sub">${S.pos ? '線路の近さと進む向きで推定' : ''}</span></div>
    ${cs.length ? `<div class="list">${cs.map((c, i) => pickHTML(c, i === 0)).join('')}</div>`
      : `<p class="empty">${S.pos ? '線路の上にいないようです。電車に乗ると候補が出ます。<br>地下でGPSが届かないときは、乗った駅を地図でタップして路線を選べます。' : '位置情報を許可すると、乗っている路線の候補が出ます。駅を地図でタップして選ぶこともできます。'}</p>`}
    <div class="hd" style="margin-top:10px"><h2>近くの駅</h2><span class="sub">タップで地図へ</span></div>
    <div class="list">${ns.map(({ st, d }) => `<button class="pick" style="--c:${esc(stColour(st))}" data-act="st" data-s="${st.key}"><span class="bar"></span><span class="tx"><b>${esc(st.name)}</b><span class="sub">${dotsOf(st)} ${linesOf(st)}</span></span><span class="r t">${fmtD(d)}</span></button>`).join('') || '<p class="empty">路線データを読み込み中です…</p>'}</div>`;
}
function buildRide() {
  const r = S.ride.route;
  $('#sbody').innerHTML = `<div class="hd" style="position:sticky;top:0;background:var(--card);z-index:3;padding-bottom:4px">
      <div><h2 style="margin-bottom:0">${esc(r.lineName)}</h2><span class="sub" style="font-size:12px">${esc(dirText(r))}・${r.stops.length}駅</span></div>
      <button class="btn" data-act="end">降りる</button></div>
    <ul class="strip" style="--c:${esc(r.colour)}">${r.stops.map((st, i) => `<li data-k="${i}"><span class="dot"></span><span class="nm d">${esc(st.name)}</span><button class="here" data-act="here" data-k="${i}">ここにいる</button><span class="tm"></span></li>`).join('')}
    <div class="train" id="train"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2l2-2h4l2 2h2v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4ZM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM18 10H6V6h12v4Z"/></svg></div></ul>`;
  S.ride.lastK = null;
}
function renderRide() {
  const R = S.ride; if (!R) return; const r = R.route, nx = nextInfo(R), now = Date.now(), ul = $('#sbody .strip'); if (!ul) return;
  const lis = ul.querySelectorAll('li'), cur = nx.at != null ? nx.at : nx.k;
  lis.forEach((li, i) => {
    const past = nx.k == null ? true : nx.at != null ? i < nx.at : i < nx.k;
    li.classList.toggle('past', past); li.classList.toggle('next', i === cur);
    li.classList.toggle('half', nx.at == null && nx.k != null && i === nx.k - 1);
    li.classList.toggle('sel', R.sel === i);
    const t = nx.eta[i], tm = li.querySelector('.tm');
    tm.innerHTML = t != null ? `<span class="t">${hhmm(now + t * 1000)}</span><small>${t < 45 ? 'まもなく' : 'あと' + Math.ceil(t / 60) + '分'}</small>` : i === nx.at ? '<small>停車中</small>' : '';
  });
  const tr = $('#train');
  if (tr && lis.length) {
    let a, f = 0;
    if (nx.k == null) a = lis.length - 1;
    else if (nx.at != null) a = nx.at;
    else { a = Math.max(0, nx.k - 1); const s0 = r.stops[a].s, s1 = r.stops[nx.k].s; f = nx.k === 0 ? 0 : clamp((R.s - s0) / ((s1 - s0) || 1), 0, 1); }
    const li = lis[a], li2 = lis[Math.min(a + 1, lis.length - 1)];
    const y0 = li.offsetTop + li.offsetHeight / 2, y1 = li2.offsetTop + li2.offsetHeight / 2;
    tr.style.top = (y0 + (y1 - y0) * f) + 'px';
    if (R.lastK !== cur && S.follow) { R.lastK = cur; $('#sbody').scrollTo({ top: Math.max(0, y0 - 90), behavior: 'smooth' }); }
  }
  updateLabels();
}

/* ---------- 地図・リストの連動 ---------- */
function onStationTap(st) {
  const R = S.ride;
  if (R) {
    const i = R.route.stops.findIndex(x => x.st === st);
    if (i >= 0) { R.sel = i; $('#sheet').classList.remove('min'); renderRide(); const li = $(`#sbody .strip li[data-k="${i}"]`); li && li.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
  }
  const rs = [...st.routes].map(id => S.routes.get(id)).filter(r => r && r.stops.findIndex(x => x.st === st) < r.stops.length - 1);
  const seen = new Set(), items = rs.filter(r => { const s = r.key + r.svc + r.to; if (seen.has(s)) return false; seen.add(s); return true; }).slice(0, 10);
  L.popup({ maxWidth: 300, autoPanPaddingTopLeft: [10, $('#now').offsetHeight + 20] }).setLatLng([st.lat, st.lon]).setContent(
    `<div class="pop"><h3>${esc(st.name)}</h3><div class="sub" style="font-size:12px;margin-bottom:4px">この駅から乗る（方面を選択）</div>${items.map(r => {
      const k = r.stops.findIndex(x => x.st === st);
      return `<button class="pick" style="--c:${esc(r.colour)}" data-act="ride" data-r="${r.id}" data-k="${k}"><span class="bar"></span><span class="tx"><b>${esc(r.lineName)}</b><span class="sub">${esc(dirText(r))}・次は${esc(r.stops[k + 1].name)}</span></span></button>`;
    }).join('') || '<p class="empty">この駅から先の路線データがありません</p>'}</div>`).openOn(map);
}
function flash(st) { const m = stMarks.get(st), el = m && m.getElement(); if (!el) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
const unfollow = () => { S.follow = false; $('#bLoc').classList.remove('on'); };
function flyToStation(st, z = 15) { unfollow(); map.flyTo([st.lat, st.lon], Math.max(map.getZoom(), z), { duration: 0.7 }); setTimeout(() => flash(st), 750); }
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) {
    const li = e.target.closest('.strip li');
    if (li && S.ride) { const i = +li.dataset.k; S.ride.sel = S.ride.sel === i ? null : i; flyToStation(S.ride.route.stops[i].st); renderRide(); }
    return;
  }
  const a = b.dataset.act;
  if (a === 'ride') { const r = S.routes.get(+b.dataset.r); if (r) startRide(r, b.dataset.k != null ? +b.dataset.k : null); }
  else if (a === 'end') endRide();
  else if (a === 'here') {
    e.stopPropagation(); const R = S.ride, i = +b.dataset.k;
    R.s = R.route.stops[i].s; R.atK = i; R.dwellUntil = Date.now() + DWELL[R.route.kind] * 1000; R.sel = null;
    S.follow = true; $('#bLoc').classList.add('on');
    if (S.demo) { S.demo.s = R.s; S.demo.hold = Date.now() + DWELL[R.route.kind] * 1000 / S.demoMult; }
    rideStep();
  }
  else if (a === 'st') { const st = S.stations.get(b.dataset.s); if (st) { flyToStation(st); setTimeout(() => onStationTap(st), 800); } }
  else if (a === 'close') $('#dlg').hidden = true;
  else if (a === 'demo') { startDemo(); $('#dlg').hidden = true; }
  else if (a === 'demostop') { stopDemo(); $('#dlg').hidden = true; }
  else if (a === 'clearcache') clearCache();
});
$('#now').addEventListener('click', () => {
  if (S.ride) { const nx = nextInfo(S.ride); if (nx.k != null) flyToStation(S.ride.route.stops[nx.k].st); }
  else { const ns = nearbyStations(1)[0]; if (ns) flyToStation(ns.st, 16); }
});
$('#bLoc').addEventListener('click', () => {
  S.follow = true; $('#bLoc').classList.add('on');
  const p = S.ride ? pointAt(S.ride.route.chain, S.ride.route.cum, S.ride.s) : S.pos ? [S.pos.lat, S.pos.lon] : null;
  if (p) { if (map.getZoom() < 14) map.setZoom(15, { animate: false }); followTo(p, true); } else { toast('現在地がまだわかりません'); startGps(); }
});
$('#bFar').addEventListener('click', () => { S.showFar = !S.showFar; LS.set('far', S.showFar); $('#bFar').setAttribute('aria-pressed', S.showFar); drawLines(); updateLabels(); renderSheet(true); if (S.showFar) loadFar(); });
$('#bFar').setAttribute('aria-pressed', S.showFar);
$('#bSet').addEventListener('click', () => { $('#dlg').hidden = false; });
$('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg') $('#dlg').hidden = true; });
$('#grab').addEventListener('click', () => { $('#sheet').classList.toggle('min'); setTimeout(sheetH, 260); });
$('#segStyle').addEventListener('click', e => { const b = e.target.closest('button'); b && setStyle(b.dataset.style); });
function setFont(f) {
  LS.set('font', f); document.documentElement.classList.toggle('jl', f !== 'plex'); document.documentElement.classList.toggle('fj-plex', f === 'plex');
  document.querySelectorAll('#segFont button').forEach(b => b.setAttribute('aria-pressed', b.dataset.font === f));
}
setFont(LS.get('font', 'line'));
$('#segFont').addEventListener('click', e => { const b = e.target.closest('button'); b && setFont(b.dataset.font); });
function setSrc(s) {
  S.src = s; document.querySelectorAll('#segSrc button').forEach(b => b.setAttribute('aria-pressed', b.dataset.src === s)); document.body.classList.toggle('picking', s === 'manual');
  if (s === 'manual') toast('地図をタップすると、そこを現在地にします'); else startGps();
}
$('#segSrc').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { setSrc(b.dataset.src); $('#dlg').hidden = true; } });
function setMult(m) { S.demoMult = m; LS.set('mult', m); document.querySelectorAll('#segDemo button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.mult === m)); }
setMult(S.demoMult);
$('#segDemo').addEventListener('click', e => { const b = e.target.closest('button'); b && setMult(+b.dataset.mult); });
map.on('click', e => { if (S.src !== 'manual') return; onPos({ lat: e.latlng.lat, lon: e.latlng.lng, acc: 15, speed: 0, t: Date.now() }, true); });
map.on('dragstart', unfollow);
let mvT = null;
map.on('moveend zoomend', () => {
  updateLabels(); LS.set('view', { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() });
  clearTimeout(mvT); mvT = setTimeout(() => { if (S.showFar) loadFar(); if (!S.pos && !S.nearCenter) loadNear(map.getCenter().lat, map.getCenter().lng); }, 600);
});
function sheetH() { document.documentElement.style.setProperty('--sheetH', (window.innerWidth >= 900 ? 0 : $('#sheet').offsetHeight) + 'px'); }
new ResizeObserver(sheetH).observe($('#sheet'));
let toastT = null;
function toast(msg, act) {
  const t = $('#toast'); t.innerHTML = `<span>${esc(msg)}</span>${act ? `<button>${esc(act.label)}</button>` : ''}`; t.hidden = false;
  if (act) t.querySelector('button').onclick = () => { t.hidden = true; act.fn(); };
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), act ? 9000 : 4000);
}
async function clearCache() {
  try { for (const k of await caches.keys()) await caches.delete(k); } catch (e) {}
  toast('保存データを削除しました。再読み込みします'); setTimeout(() => location.reload(), 900);
}

/* ---------- 位置 ---------- */
function onPos(p, fromManual) {
  if (S.src === 'manual' && !fromManual) return;
  if (S.demo && !p.demo) return;
  const prev = S.pos;
  if (p.speed == null && prev) { const dt = (p.t - prev.t) / 1000; if (dt > 0.5 && dt < 30) p.speed = dist([prev.lat, prev.lon], [p.lat, p.lon]) / dt; }
  S.pos = p; S.speeds.push({ t: p.t, v: p.speed || 0 }); while (S.speeds.length > 60) S.speeds.shift();
  if (!S.nearCenter || dist(S.nearCenter, [p.lat, p.lon]) > 1200) loadNear(p.lat, p.lon);
  if (S.ride) rideStep(); else { drawMe(); renderSheet(); renderTop(); }
}
let watchId = null;
function startGps() {
  if (!('geolocation' in navigator)) { toast('この端末では位置情報が使えません'); return; }
  if (!window.isSecureContext) { toast('位置情報は https でアクセスしたときだけ使えます'); return; }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(
    g => onPos({ lat: g.coords.latitude, lon: g.coords.longitude, acc: g.coords.accuracy, speed: g.coords.speed, t: Date.now() }),
    err => { if (err.code === 1) { watchId = null; toast('位置情報が許可されていません。設定から「地図をタップして指定」も使えます'); } },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}

/* ---------- デモ走行 ---------- */
function startDemo() {
  let r = S.ride && S.ride.route;
  if (!r) { const c = candidates()[0]; r = c && c.r; }
  if (!r) { const g = [...S.groups.values()].find(groupVisible); r = g && g.routes[0]; }
  if (!r) { toast('路線データがまだありません'); return; }
  if (!S.ride) startRide(r);
  S.demo = { s: S.ride.s, hold: 0, last: Date.now() };
  if (S.src === 'manual') setSrc('gps');
  toast(`デモ走行：${r.lineName}（${S.demoMult === 1 ? '等速' : S.demoMult + '倍速'}）`);
}
function stopDemo() { S.demo = null; if (S.ride) S.ride.atK = null; }
function demoStep() {
  const D = S.demo, R = S.ride; if (!D || !R) { S.demo = null; return; }
  const r = R.route, now = Date.now(), dt = (now - D.last) / 1000 * S.demoMult; D.last = now;
  let v = 0;
  if (now >= D.hold) {
    const k = nextIdx(r, D.s);
    if (k == null) { stopDemo(); toast('デモ走行：終点に着きました'); return; }
    const prevS = r.stops[k - 1] ? r.stops[k - 1].s : 0, d = Math.max(1, r.stops[k].s - prevS); v = d / segT(r, d);
    const f = clamp((D.s - prevS) / d, 0, 1), prof = clamp(Math.min(f, 1 - f) * 6, 0.25, 1.35);
    D.s += v * prof * dt;
    if (D.s >= r.stops[k].s) { D.s = r.stops[k].s; D.hold = now + DWELL[r.kind] * 1000 / S.demoMult; v = 0; } else v *= prof;
  }
  const p = pointAt(r.chain, r.cum, D.s);
  onPos({ lat: p[0] + (Math.random() - 0.5) * 0.00008, lon: p[1] + (Math.random() - 0.5) * 0.0001, acc: 12, speed: v, t: now, demo: true });
}

/* ---------- 起動 ---------- */
function afterData() { drawLines(); updateLabels(); renderSheet(true); renderTop(); }
setInterval(() => { if (S.demo) demoStep(); if (S.ride) rideStep(); }, 1000);
renderTop(); renderSheet(true); sheetH();
startGps();
await metaReady;
$('#dataInfo').textContent = S.meta
  ? `路線データ：${new Date(S.meta.v).toLocaleDateString('ja-JP')} 作成（${S.meta.routes.toLocaleString()}系統・${S.meta.stations.toLocaleString()}駅）。一度見た地域は端末に保存され、次回から通信なしで表示します。`
  : '路線データ：事前生成データが見つからないため、OpenStreetMap（Overpass API）から直接取得しています（時間がかかります）。';
setTimeout(() => { if (!S.nearCenter && !nearBusy) { const c = map.getCenter(); loadNear(c.lat, c.lng); } }, S.pos ? 0 : 4000);
window.__S = S;
