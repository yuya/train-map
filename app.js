import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs';
import * as G from './geo.js?v=__V__';
import * as ODPT from './odpt.js?v=__V__';
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
  nearKeys: new Set(), nearCenter: null, showFar: LS.get('far', false), style: LS.get('mapStyle', 'pale'), popup: null,
  ride: null, follow: true, hist: new Map(), demo: null, demoMult: LS.get('mult', 5), speeds: [], loading: 0, lastSug: '',
  mode: 'static', meta: null,
};

/* ---------- 地図（MapLibre GL ＋ 国土地理院最適化ベクトルタイル） ---------- */
// ベースマップの PMTiles。置き場所を変えるときはここ1か所を書き換える
const BASE_PMTILES = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles';
const BASE_STYLE = 'https://gsi-cyberjapan.github.io/optimal_bvmap/style/std.json';
const PHOTO_TILES = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
const VT_ATTR = '<a href="https://github.com/gsi-cyberjapan/optimal_bvmap" target="_blank" rel="noopener">国土地理院最適化ベクトルタイル</a>';
const PHOTO_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル（写真）</a>';
const RAIL_ATTR = '路線・駅 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const EMPTY = { type: 'FeatureCollection', features: [] };
const BLANK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f2f1ed' } }] };
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// 表示位置。旧版（Leaflet）のズームはベクタ地図より1大きいので変換する
const startView = LS.get('view2', null) || (v => (v ? { c: v.c, z: v.z - 1 } : null))(LS.get('view', null));
const map = new maplibregl.Map({
  container: 'map', style: BLANK_STYLE,
  center: startView ? [startView.c[1], startView.c[0]] : [139.7671, 35.6812], zoom: startView ? startView.z : 13,
  minZoom: 4, maxZoom: 18.5, dragRotate: true, pitchWithRotate: false, touchPitch: false, maxPitch: 0, attributionControl: false,
  localIdeographFontFamily: "'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic',sans-serif",
});
// 二本指で回転できる。回転したら方位ボタンを出し、押すと北が上に戻る
const compass = () => { const b = $('#bNorth'), r = map.getBearing(); b.hidden = Math.abs(r) < 0.5; b.querySelector('svg').style.transform = `rotate(${-r}deg)`; };
map.on('rotate', compass);
$('#bNorth').addEventListener('click', () => map.easeTo({ bearing: 0, duration: 400 }));
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: RAIL_ATTR }), 'bottom-left');
const LZ = () => map.getZoom() + 1;
map.once('load', () => { const a = document.querySelector('.maplibregl-ctrl-attrib'); a && a.classList.remove('maplibregl-compact-show'); }); // 旧版と同じ感覚のズーム値（しきい値の判定用）

/* 淡色化：スタイルの色を彩度を落として明るくする（文字は読める濃さに） */
function parseColor(c) {
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/i.exec(c))) {
    let h = m[1]; if (h.length <= 4) h = [...h].map(x => x + x).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(c))) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}
function paleColor(c, text) {
  const p = parseColor(c); if (!p) return c;
  const r = p.r / 255, g = p.g / 255, b = p.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, sat = 0, l = (mx + mn) / 2;
  if (mx !== mn) { const d = mx - mn; sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
  if (text) { sat *= 0.25; l = Math.min(l, 0.42); } else { sat *= 0.35; l = l + (1 - l) * 0.55; }
  const f = n => { const k = (n + h * 12) % 12, a = sat * Math.min(l, 1 - l); return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255); };
  return `rgba(${f(0)},${f(8)},${f(4)},${+p.a.toFixed(3)})`;
}
const mapColors = (v, fn) => (typeof v === 'string' ? fn(v) : Array.isArray(v) ? v.map(x => mapColors(x, fn)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapColors(x, fn)])) : v);
function paleize(style) {
  for (const l of style.layers) {
    if (!l.paint) continue;
    for (const k of Object.keys(l.paint)) if (/color$/.test(k)) l.paint[k] = mapColors(l.paint[k], c => paleColor(c, k === 'text-color'));
  }
}
let baseStyle = null;
async function getBaseStyle() {
  if (!baseStyle) { const r = await fetch(BASE_STYLE); if (!r.ok) throw new Error('style ' + r.status); baseStyle = await r.json(); }
  return baseStyle;
}
async function styleFor(k) {
  if (k === 'photo') return { version: 8, sources: { photo: { type: 'raster', tiles: [PHOTO_TILES], tileSize: 256, maxzoom: 18, attribution: PHOTO_ATTR } }, layers: [{ id: 'photo', type: 'raster', source: 'photo' }] };
  const s = structuredClone(await getBaseStyle());
  for (const src of Object.values(s.sources)) if (src.type === 'vector') { src.tiles = [`pmtiles://${BASE_PMTILES}/{z}/{x}/{y}`]; delete src.url; src.attribution = VT_ATTR; }
  if (k === 'pale') paleize(s);
  return s;
}
let styleSeq = 0;
async function setStyle(k) {
  if (!['std', 'pale', 'photo'].includes(k)) k = 'pale';
  if (k === 'photo' && !navigator.onLine) { toast('写真の地図はオフラインでは選べません'); return; }
  S.style = k; LS.set('mapStyle', k);
  document.querySelectorAll('#segStyle button').forEach(b => b.setAttribute('aria-pressed', b.dataset.style === k));
  const seq = ++styleSeq;
  try { const st = await styleFor(k); if (seq === styleSeq) { map.setStyle(st, { diff: false }); baseReady = true; } }
  catch (e) { console.warn(e); toast('地図のスタイルを読み込めませんでした', { label: '再試行', fn: () => setStyle(k) }); banner.fail(); }
}
let baseReady = false;
function updatePhotoAvail() {
  const b = document.querySelector('#segStyle button[data-style="photo"]'); if (!b) return;
  b.disabled = !navigator.onLine; $('#photoNote').textContent = navigator.onLine ? '' : '　写真はオフライン中は選べません';
}
addEventListener('online', updatePhotoAvail); addEventListener('offline', updatePhotoAvail);

/* 自前の線（路線・乗車中の路線・現在地の精度円）。スタイルを替えるたびに載せ直す */
function addOverlays() {
  if (map.getSource('lines')) return;
  map.addSource('acc', { type: 'geojson', data: EMPTY });
  map.addSource('lines', { type: 'geojson', data: EMPTY });
  map.addSource('ride', { type: 'geojson', data: EMPTY });
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  // 都府県界をはっきり描く（元の細い破線は隠す）
  if (map.getSource('v')) {
    for (const l of map.getStyle().layers) if (/都府県界|地方界/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
    const pref = (id, filter, opt) => {
      map.addLayer({ id: id + '-c', type: 'line', source: 'v', 'source-layer': 'AdmBdry', filter, ...opt, paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 10, 5.5] } });
      map.addLayer({ id, type: 'line', source: 'v', 'source-layer': 'AdmBdry', filter, ...opt, paint: { 'line-color': S.style === 'std' ? '#5b3a8c' : '#7b6a96', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 10, 2.4], 'line-dasharray': [5, 2, 1, 2] } });
    };
    pref('pref-lo', ['==', ['get', 'vt_code'], 1212], { maxzoom: 8 });
    pref('pref-hi', ['==', ['get', 'vt_code'], 1211], { minzoom: 8 });
  }
  // 乗車中はベースマップ全体に白い膜をかけて、道路などを薄くする（自前の線はその上に描く）
  map.addLayer({ id: 'veil', type: 'background', paint: { 'background-color': '#ffffff', 'background-opacity': veilOpacity(), 'background-opacity-transition': { duration: 400 } } });
  map.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.08 } });
  map.addLayer({ id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': '#1a73e8', 'line-width': 1, 'line-opacity': 0.5 } });
  map.addLayer({ id: 'lines-approx', type: 'line', source: 'lines', filter: ['get', 'ap'], paint: { 'line-color': ['get', 'colour'], 'line-width': 2.5, 'line-dasharray': [2, 2], 'line-opacity': ['case', ['get', 'dim'], 0.12, 0.8] } });
  map.addLayer({ id: 'lines-casing', type: 'line', source: 'lines', filter: ['!', ['get', 'ap']], layout: round, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': ['case', ['get', 'dim'], 0, 0.95] } });
  map.addLayer({ id: 'lines-main', type: 'line', source: 'lines', filter: ['!', ['get', 'ap']], layout: round, paint: { 'line-color': ['get', 'colour'], 'line-width': ['case', ['get', 'dim'], 3, 4.5], 'line-opacity': ['case', ['get', 'dim'], 0.12, 1] } });
  map.addLayer({ id: 'ride-casing', type: 'line', source: 'ride', filter: ['==', ['get', 'part'], 'all'], layout: round, paint: { 'line-color': '#ffffff', 'line-width': 13 } });
  map.addLayer({ id: 'ride-behind', type: 'line', source: 'ride', filter: ['==', ['get', 'part'], 'behind'], layout: round, paint: { 'line-color': '#9aa3ad', 'line-width': 8 } });
  map.addLayer({ id: 'ride-ahead', type: 'line', source: 'ride', filter: ['==', ['get', 'part'], 'ahead'], layout: round, paint: { 'line-color': ['get', 'colour'], 'line-width': 8 } });
  drawLines(); drawMe();
}
map.on('style.load', addOverlays);

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
  if (!g) { g = { key: r.key, name: r.lineName, colour: r.colour || G.hashColour(r.key), routes: [], ll: null }; S.groups.set(r.key, g); }
  if (!r.colour) r.colour = g.colour;
  g.routes.push(r); g.ll = null;
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
      id: m.id, name: m.n, lineName: m.l, key: m.k, colour: m.c, svc: m.svc, to: m.to, kind: m.kind, loop: m.loop, shape: m.sh, approx: !!m.ap,
      chain: G.decodeShape(sh), stops: m.st.map(([sid, name, lat, lon, s]) => ({ sid, name, lat, lon, s })),
    });
  });
  return [...ids];
}
// 近くを通るだけで乗れない路線（例：駅のない区間を通過する新幹線）は「近くの路線」に入れない
const hasStopNear = (r, lat, lon, m = 3000) => r.stops.some(st => dist([lat, lon], [st.lat, st.lon]) <= m);
async function loadNearStatic(lat, lon, radius) {
  const dLat = radius / 111000, dLon = radius / (111000 * Math.cos(lat * G.rad));
  const ids = await loadTiles(tileKeys(lat - dLat, lon - dLon, lat + dLat, lon + dLon));
  const near = new Set();
  for (const id of ids) { const r = S.routes.get(id); if (r && project(r.chain, r.cum, [lat, lon]).d <= radius && hasStopNear(r, lat, lon)) near.add(r.key); }
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
  return new Set(got.map(id => S.routes.get(id)).filter(r => hasStopNear(r, lat, lon, Math.max(3000, radius))).map(r => r.key));
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
  if (LZ() < minZ) { toast('遠くの路線は、もう少し拡大すると読み込みます'); return; }
  const mb = map.getBounds(), b = { s: mb.getSouth(), w: mb.getWest(), n: mb.getNorth(), e: mb.getEast() };
  if (farBoxes.some(x => x.s <= b.s && x.w <= b.w && x.n >= b.n && x.e >= b.e)) return;
  const pf = S.mode === 'static' ? 0.15 : 0.3, dy = (b.n - b.s) * pf, dx = (b.e - b.w) * pf;
  const big = { s: b.s - dy, w: b.w - dx, n: b.n + dy, e: b.e + dx, getSouth() { return this.s; }, getWest() { return this.w; }, getNorth() { return this.n; }, getEast() { return this.e; } };
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
const toLL = ch => ch.map(p => [p[1], p[0]]);
const veilOpacity = () => (S.ride ? (S.style === 'photo' ? 0.35 : 0.55) : 0);
function drawLines() {
  const src = map.getSource('lines'); if (!src) return;
  if (map.getLayer('veil')) map.setPaintProperty('veil', 'background-opacity', veilOpacity());
  const rideKey = S.ride && S.ride.route.key, feats = [];
  for (const g of S.groups.values()) {
    if (!groupVisible(g)) continue;
    if (!g.ll) {
      // 線形が壊れていて駅を直線で結んだだけの系統は、ちゃんとした線形がある限り描かない
      const good = g.routes.filter(r => !r.approx), use = good.length ? good : g.routes, seen = new Set();
      g.ap = !good.length; g.ll = [];
      for (const r of use) { const k = r.shape || r.id; if (!seen.has(k)) { seen.add(k); g.ll.push(toLL(r.chain)); } }
    }
    feats.push({ type: 'Feature', properties: { colour: g.colour, dim: !!(S.ride && g.key !== rideKey), ap: g.ap }, geometry: { type: 'MultiLineString', coordinates: g.ll } });
  }
  feats.sort((a, b) => b.properties.dim - a.properties.dim); // 薄い線を下に
  src.setData({ type: 'FeatureCollection', features: feats });
  updateRideLine();
}
function updateRideLine() {
  const src = map.getSource('ride'); if (!src) return;
  if (!S.ride) { src.setData(EMPTY); return; }
  const r = S.ride.route, s = S.ride.s, i = idxAt(r.cum, s), p = pointAt(r.chain, r.cum, s);
  if (!r.ll) r.ll = toLL(r.chain);
  const P = [p[1], p[0]], line = (part, coords) => ({ type: 'Feature', properties: { part, colour: r.colour }, geometry: { type: 'LineString', coordinates: coords.length > 1 ? coords : [P, P] } });
  src.setData({ type: 'FeatureCollection', features: [line('all', r.ll), line('behind', r.ll.slice(0, i + 1).concat([P])), line('ahead', [P].concat(r.ll.slice(i + 1)))] });
}
const stMarks = new Map();
function textW(s, fs) { let w = 0; for (const c of s) w += c.charCodeAt(0) > 255 ? fs : fs * 0.6; return w; }
const stColour = st => { for (const k of st.keys) { const g = S.groups.get(k); if (g && groupVisible(g)) return g.colour; } const g = S.groups.get([...st.keys][0]); return g ? g.colour : '#555'; };
function updateLabels() {
  const z = LZ(), R = S.ride, cv = map.getContainer(), W = cv.clientWidth, H = cv.clientHeight, pad = 0.15 * Math.max(W, H);
  const rideSt = new Map();
  if (R) { const nx = nextInfo(R); R.route.stops.forEach((st, i) => rideSt.set(st.st, { i, past: i < (nx.k ?? Infinity) && nx.at !== i, next: nx.at === i || (nx.at == null && i === nx.k) })); }
  const me = S.pos ? [S.pos.lat, S.pos.lon] : [map.getCenter().lat, map.getCenter().lng];
  let cand = [];
  for (const st of S.stations.values()) {
    if (!(rideSt.has(st) || (z >= 11 && [...st.keys].some(k => groupVisible(S.groups.get(k)))))) continue;
    const pt = map.project([st.lon, st.lat]);
    if (pt.x < -pad || pt.x > W + pad || pt.y < -pad || pt.y > H + pad) continue;
    st.pt = pt; cand.push(st);
  }
  cand.forEach(st => { st.pr = (rideSt.has(st) ? 0 : 1e7) + dist(me, [st.lat, st.lon]) - st.keys.size * 400 - (rideSt.get(st)?.next ? 1e8 : 0); });
  cand.sort((a, b) => a.pr - b.pr);
  if (cand.length > 400) cand = cand.slice(0, 400);
  const keep = new Set(cand), boxes = [];
  for (const [st, m] of stMarks) if (!keep.has(st)) { m.remove(); stMarks.delete(st); }
  for (const st of cand) {
    const rs = rideSt.get(st), c = rs ? R.route.colour : stColour(st);
    let m = stMarks.get(st);
    if (!m) {
      const el = document.createElement('div'); el.className = 'st';
      el.innerHTML = `<div class="in"><i></i><b>${esc(st.name)}</b></div>`;
      el.addEventListener('click', e => { e.stopPropagation(); onStationTap(st); });
      m = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([st.lon, st.lat]).addTo(map); stMarks.set(st, m);
    }
    const el = m.getElement();
    el.querySelector('.in').style.setProperty('--c', c);
    const fs = rs && rs.next ? 17 : rs ? 15 : 13.5;
    const pt = st.pt, w = textW(st.name, fs) + 26, h = fs + 12;
    let side = null;
    if (z >= 12 || rs) {
      const R1 = { x: pt.x - 7, y: pt.y - h / 2, w, h }, R2 = { x: pt.x - w + 7, y: pt.y - h / 2, w, h };
      const hit = r => boxes.some(o => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
      if (!hit(R1)) { side = 'R'; boxes.push(R1); } else if (!hit(R2)) { side = 'L'; boxes.push(R2); }
    }
    el.classList.toggle('nolab', !side); el.classList.toggle('L', side === 'L');
    el.classList.toggle('on', !!rs); el.classList.toggle('past', !!(rs && rs.past)); el.classList.toggle('next', !!(rs && rs.next));
    el.style.zIndex = rs && rs.next ? 4 : rs ? 3 : side ? 2 : 1;
  }
}
let meMark = null;
function circlePoly(lat, lon, r) {
  const pts = [], kx = 111320 * Math.cos(lat * G.rad);
  for (let i = 0; i <= 48; i++) { const a = (i / 48) * 2 * Math.PI; pts.push([lon + (r * Math.cos(a)) / kx, lat + (r * Math.sin(a)) / 110540]); }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } };
}
function drawMe() {
  let p = S.pos ? [S.pos.lat, S.pos.lon] : null;
  if (S.ride) p = pointAt(S.ride.route.chain, S.ride.route.cum, S.ride.s);
  if (!p) return;
  if (!meMark) { const el = document.createElement('div'); el.className = 'me'; el.innerHTML = '<i></i>'; el.style.zIndex = 5; meMark = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p[1], p[0]]).addTo(map); }
  meMark.setLngLat([p[1], p[0]]);
  meMark.getElement().classList.toggle('est', !!(S.ride && S.ride.mode === 'est'));
  const acc = map.getSource('acc');
  if (acc) acc.setData(S.pos && !S.ride ? { type: 'FeatureCollection', features: [circlePoly(S.pos.lat, S.pos.lon, Math.min(S.pos.acc || 10, 2000))] } : EMPTY);
  if (S.follow) followTo(p);
}
function viewPadding() {
  const wide = window.innerWidth >= 900;
  return { top: $('#now').offsetHeight + 10, bottom: wide ? 0 : $('#sheet').offsetHeight, left: wide ? 460 : 0, right: 0 };
}
function followTo(p, force) {
  const pad = viewPadding(), cv = map.getContainer(), W = cv.clientWidth, H = cv.clientHeight;
  const cx = pad.left + (W - pad.left - pad.right) / 2, cy = pad.top + (H - pad.top - pad.bottom) / 2, pt = map.project([p[1], p[0]]);
  if (force || Math.hypot(pt.x - cx, pt.y - cy) > 4) map.easeTo({ center: [p[1], p[0]], padding: pad, duration: 600 });
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
  t += base;
  const tt = R.tt && R.tt.times;
  if (tt && tt.has(out.k)) t = Math.max(0, (tt.get(out.k) - now) / 1000);
  out.eta[out.k] = t;
  for (let j = out.k + 1; j < r.stops.length; j++) {
    t = tt && tt.has(j) ? Math.max(t, (tt.get(j) - now) / 1000) : t + DWELL[r.kind] + segT(r, r.stops[j].s - r.stops[j - 1].s);
    out.eta[j] = t;
  }
  return out;
}
function startRide(r, k) {
  const now = Date.now(); let s = r.stops[0].s;
  if (k != null) s = r.stops[k].s;
  else if (S.pos) { const p = project(r.chain, r.cum, [S.pos.lat, S.pos.lon]); if (p.d < 400) s = p.s; }
  S.ride = { route: r, s, t: now, mode: 'est', atK: k != null ? k : null, dwellUntil: k != null ? now + DWELL[r.kind] * 1000 : 0, sel: null };
  closePopup(); S.follow = true; $('#bLoc').classList.add('on'); $('#sheet').classList.add('min');
  drawLines(); renderSheet(true); rideStep();
  if (LZ() < 14) map.setZoom(13);
  attachTimetable();
}
function endRide() { S.ride = null; stopDemo(); drawLines(); renderSheet(true); renderTop(); updateLabels(); drawMe(); }
/* 時刻表で、いる駅の発車時刻がまだ来ていなければ停車を続ける */
function ttHold(R, now) {
  const tt = R.tt && R.tt.times, c = R.tt && R.tt.c; if (!tt || R.atK == null || !tt.has(R.atK)) return false;
  const dep = tt.get(R.atK) + (c && R.atK === c.k ? 0 : 30e3);
  if (dep > now) { R.dwellUntil = Math.max(R.dwellUntil, dep); return true; }
  return false;
}
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
  } else if (R.dwellUntil > now || ttHold(R, now)) { /* 停車中（時刻表があれば発車時刻まで） */ }
  else {
    if (R.atK != null) { R.s = Math.max(R.s, r.stops[R.atK].s + 16); R.atK = null; }
    const k = nextIdx(r, R.s);
    if (k != null) {
      const prevS = r.stops[k - 1] ? r.stops[k - 1].s : 0, d = Math.max(1, r.stops[k].s - prevS), tt = R.tt && R.tt.times;
      // 時刻表があれば、次の駅に時刻どおり着く速さで進める
      const v = tt && tt.has(k) && tt.get(k) > now + 5e3 ? Math.max(0.5, (r.stops[k].s - R.s) / ((tt.get(k) - now) / 1000)) : d / segT(r, d);
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
  const R = S.ride, nL = $('#nLine'), nB = $('#nBadge'), nLead = $('#nLead'), nName = $('#nName'), nEta = $('#nEta'), card = $('#now');
  if (R) {
    const r = R.route, nx = nextInfo(R), now = Date.now();
    card.style.setProperty('--lc', r.colour);
    nL.textContent = `${r.lineName}・${dirText(r)}`;
    const dia = R.tt && R.tt.times && R.tt.times.size > 1;
    nB.className = 'badge ' + (S.demo ? 'est' : dia ? 'gps' : R.mode); nB.textContent = S.demo ? 'デモ' : dia ? 'ダイヤ' : R.mode === 'gps' ? 'GPS' : '推定';
    if (nx.k == null) { nLead.textContent = '終点'; nName.textContent = r.stops[r.stops.length - 1].name; nEta.innerHTML = '<span class="sub">到着</span>'; return; }
    const t = nx.eta[nx.k], st = r.stops[nx.k], when = hhmm(now + t * 1000);
    if (nx.at != null) { nLead.textContent = '停車中'; nName.textContent = r.stops[nx.at].name; }
    else { nLead.textContent = '次は'; nName.textContent = st.name; }
    const sub = nx.at != null ? `次は${esc(st.name)} ${when}着` : `${when}着・${fmtD(Math.max(0, st.s - R.s))}`;
    nEta.innerHTML = t < 45
      ? `<span class="t" style="font-size:clamp(20px,6vw,26px)">まもなく</span><span class="when">${sub}</span>`
      : `<span class="sub" style="font-size:12px">あと</span><span class="t">${Math.ceil(t / 60)}</span><small class="lab">分</small><span class="when">${sub}</span>`;
    return;
  }
  card.style.setProperty('--lc', 'var(--faint)');
  nB.className = 'badge' + (S.pos && S.src === 'gps' ? ' gps' : '');
  nB.textContent = S.src === 'manual' ? '手動' : S.pos ? `±${Math.round(S.pos.acc || 0)}m` : 'GPS';
  const ns = nearbyStations(1)[0];
  nEta.innerHTML = '';
  if (ns) {
    nL.innerHTML = S.loading ? '路線データを読み込み中…' : `${dotsOf(ns.st)} ${linesOf(ns.st)}`;
    nLead.textContent = '最寄り駅'; nName.textContent = ns.st.name;
    nEta.innerHTML = `<span class="t">${fmtD(ns.d).replace(/ (m|km)/, '<small class="lab"> $1</small>')}</span>`;
  } else {
    nL.textContent = S.loading ? '路線データを読み込み中…' : S.pos ? '地図を動かすか「遠くの路線」をオンにしてください' : '現在地を確認しています（地図の中心を表示中）';
    nLead.textContent = ''; nName.textContent = S.loading ? '…' : '駅が見つかりません';
  }
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
    <div class="ttbar" id="ttbar"></div>
    <ul class="strip" style="--c:${esc(r.colour)}">${r.stops.map((st, i) => `<li data-k="${i}"><span class="dot"></span><span class="nm d">${esc(st.name)}</span><button class="here" data-act="here" data-k="${i}">ここにいる</button><span class="tm"></span></li>`).join('')}
    <div class="train" id="train"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2l2-2h4l2 2h2v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4ZM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM18 10H6V6h12v4Z"/></svg></div></ul>`;
  S.ride.lastK = null;
  renderTT();
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

/* ---------- 時刻表（ODPT） ---------- */
function renderTT() {
  const el = $('#ttbar'), R = S.ride; if (!el || !R) return;
  const T = R.tt;
  if (!ODPT.configured()) { el.innerHTML = '<span class="sub">時刻表を使うには、設定で ODPT のアクセストークンを入れてください</span>'; return; }
  if (!T || T.loading) { el.innerHTML = '<span class="sub">時刻表を取得中…</span>'; return; }
  if (T.msg) { el.innerHTML = `<span class="sub">${esc(T.msg)}（到着時刻は推定）</span>`; return; }
  el.innerHTML = `<span class="sub">乗っている列車：</span>${T.cands.map((c, i) => `<button class="chip2${c === T.sel ? ' on' : ''}" data-act="tt" data-i="${i}">${esc(c.label)}</button>`).join('')}${T.src ? `<span class="sub" style="font-size:11px">${esc(T.src)}より</span>` : ''}`;
}
async function attachTimetable() {
  const R = S.ride; if (!R || !ODPT.configured()) { renderTT(); return; }
  R.tt = { loading: true }; renderTT();
  const r = R.route, k = R.atK != null ? R.atK : (nextIdx(r, R.s) ?? r.stops.length) - 1;
  const atStation = R.atK != null || (avgSpeed(8) < 1.5 && r.stops.some(st => Math.abs(st.s - R.s) < 120));
  try {
    const c = await ODPT.candidates(r, Math.max(0, k), atStation);
    if (S.ride !== R) return;
    if (!c.m || !c.cands) { R.tt = { msg: c.reason }; renderTT(); return; }
    R.tt = { c, cands: c.cands, sel: c.auto }; renderTT();
    await chooseTrain(c.auto);
  } catch (e) {
    console.warn('odpt', e); if (S.ride !== R) return;
    R.tt = { msg: ODPT.isAuthError(e) ? 'ODPT のアクセストークンが使えませんでした' : '時刻表を取得できませんでした' }; renderTT();
  }
}
async function chooseTrain(dep) {
  const R = S.ride; if (!R || !R.tt || !R.tt.c) return;
  R.tt.sel = dep; R.tt.times = null; R.tt.src = ''; renderTT();
  try {
    const res = await ODPT.trainTimes(R.route, R.tt.c, dep);
    if (S.ride !== R || R.tt.sel !== dep) return;
    R.tt.times = res.times; R.tt.src = res.src; renderTT(); renderTop(); renderRide();
  } catch (e) { console.warn('odpt', e); }
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
  closePopup(); $('#sheet').classList.add('min');
  S.popup = new maplibregl.Popup({ maxWidth: '300px', offset: 14 }).setLngLat([st.lon, st.lat]).setHTML(
    `<div class="pop"><h3>${esc(st.name)}</h3><div class="sub" style="font-size:12px;margin-bottom:4px">この駅から乗る（方面を選択）</div>${items.map(r => {
      const k = r.stops.findIndex(x => x.st === st);
      return `<button class="pick" style="--c:${esc(r.colour)}" data-act="ride" data-r="${r.id}" data-k="${k}"><span class="bar"></span><span class="tx"><b>${esc(r.lineName)}</b><span class="sub">${esc(dirText(r))}・次は${esc(r.stops[k + 1].name)}</span></span></button>`;
    }).join('') || '<p class="empty">この駅から先の路線データがありません</p>'}</div>`).addTo(map);
}
function closePopup() { if (S.popup) { S.popup.remove(); S.popup = null; } }
function flash(st) { const m = stMarks.get(st), el = m && m.getElement(); if (!el) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
const unfollow = () => { S.follow = false; $('#bLoc').classList.remove('on'); };
function flyToStation(st, z = 15) { unfollow(); map.flyTo({ center: [st.lon, st.lat], zoom: Math.max(map.getZoom(), z - 1), padding: viewPadding(), duration: 700 }); setTimeout(() => flash(st), 750); }
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
  else if (a === 'tt') { const T = S.ride && S.ride.tt; if (T && T.cands) chooseTrain(T.cands[+b.dataset.i]); }
  else if (a === 'odptsave') { ODPT.setKeys($('#odptKey').value, $('#odptKeyCh').value); toast('ODPT のトークンを保存しました'); if (S.ride) attachTimetable(); }
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
  if (p) { if (LZ() < 14) map.setZoom(14); followTo(p, true); } else { toast('現在地がまだわかりません'); startGps(); }
});
$('#bFar').addEventListener('click', () => { S.showFar = !S.showFar; LS.set('far', S.showFar); $('#bFar').setAttribute('aria-pressed', S.showFar); drawLines(); updateLabels(); renderSheet(true); if (S.showFar) loadFar(); });
$('#bFar').setAttribute('aria-pressed', S.showFar);
$('#bSet').addEventListener('click', () => { const k = ODPT.keys(); $('#odptKey').value = k.std; $('#odptKeyCh').value = k.ch; $('#dlg').hidden = false; });
$('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg') $('#dlg').hidden = true; });
/* シートの開閉：つまみ・見出しのタップで切り替え、上下のスワイプで開く／閉じる（指に追従）
   iPhone の Safari では Pointer Events の縦スワイプがブラウザに取られることがあるので、指はタッチイベントで扱う */
let sheetDrag = null, dragJustEnded = 0;
const sheetEl = $('#sheet');
const isHandle = t => !!t.closest('#grab') || (!!t.closest('#sbody .hd') && !t.closest('button'));
function dragStart(y) { sheetDrag = { y, last: y, h: sheetEl.offsetHeight, moved: false }; }
function dragMove(y) {
  const d = sheetDrag; if (!d) return false;
  d.last = y; const dy = y - d.y;
  if (!d.moved && Math.abs(dy) < 6) return false;
  if (!d.moved) { d.moved = true; sheetEl.style.transition = 'none'; }
  const max = Math.min(window.innerHeight * 0.52, 560), min = 84;
  sheetEl.style.maxHeight = Math.max(min, Math.min(max, d.h - dy)) + 'px';
  return true;
}
function dragEnd(y) {
  const d = sheetDrag; if (!d) return; sheetDrag = null;
  if (!d.moved) return; // ただのタップは click で処理
  const dy = (y ?? d.last) - d.y;
  sheetEl.style.transition = ''; sheetEl.style.maxHeight = '';
  if (dy < -30) sheetEl.classList.remove('min'); else if (dy > 30) sheetEl.classList.add('min');
  dragJustEnded = Date.now(); setTimeout(sheetH, 260);
}
sheetEl.addEventListener('touchstart', e => { if (e.touches.length === 1 && isHandle(e.target)) dragStart(e.touches[0].clientY); }, { passive: true });
sheetEl.addEventListener('touchmove', e => { if (sheetDrag) { dragMove(e.touches[0].clientY); e.preventDefault(); } }, { passive: false });
sheetEl.addEventListener('touchend', e => dragEnd(e.changedTouches[0] && e.changedTouches[0].clientY));
sheetEl.addEventListener('touchcancel', () => dragEnd(null));
// マウス（PC）はポインタイベントで
sheetEl.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button === 0 && isHandle(e.target)) { dragStart(e.clientY); sheetDrag.mouse = true; } });
addEventListener('pointermove', e => { if (sheetDrag && sheetDrag.mouse && dragMove(e.clientY)) e.preventDefault(); });
addEventListener('pointerup', e => { if (sheetDrag && sheetDrag.mouse) dragEnd(e.clientY); });
const toggleSheet = () => { if (Date.now() - dragJustEnded < 400) return; sheetEl.classList.toggle('min'); setTimeout(sheetH, 260); };
$('#sbody').addEventListener('click', e => { if (e.target.closest('.hd') && !e.target.closest('button')) toggleSheet(); });
$('#grab').addEventListener('click', toggleSheet);
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
map.on('click', e => { if (S.src !== 'manual') { $('#sheet').classList.add('min'); return; } onPos({ lat: e.lngLat.lat, lon: e.lngLat.lng, acc: 15, speed: 0, t: Date.now() }, true); });
map.on('dragstart', unfollow);
let mvT = null;
map.on('moveend', () => {
  updateLabels(); LS.set('view2', { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() });
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

/* ---------- 初回だけの案内（地図データの読み込み） ---------- */
const banner = (() => {
  const el = $('#banner'), tx = $('#bnTx'), bar = $('#bnBar');
  let active = !LS.get('firstRunDone', false), req = 0, got = 0, failed = false, doneT = null;
  const finish = () => { LS.set('firstRunDone', true); active = false; el.hidden = true; };
  const upd = () => { if (!active || failed) return; bar.style.width = (req ? Math.min(100, (got / req) * 100) : 5) + '%'; tx.textContent = '地図データを読み込み中です…'; };
  if (active) el.hidden = false;
  $('#bnX').addEventListener('click', finish);
  map.on('dataloading', e => { if (active && e.dataType === 'source' && e.tile) { req++; upd(); } });
  map.on('data', e => { if (active && e.dataType === 'source' && e.tile) { got++; upd(); } });
  map.on('idle', () => {
    if (!active || failed || !baseReady || !got) return;
    bar.style.width = '100%'; tx.textContent = '読み込みが完了しました';
    clearTimeout(doneT); doneT = setTimeout(finish, 2500);
  });
  const fail = () => { if (!active) return; failed = true; clearTimeout(doneT); tx.textContent = '読み込みに失敗しました。通信環境の良い場所で再読み込みしてください'; bar.style.width = '0'; };
  map.on('error', e => { if (active && e.sourceId && e.sourceId !== 'lines' && e.sourceId !== 'ride' && e.sourceId !== 'acc') fail(); });
  return { fail };
})();

/* ---------- 起動 ---------- */
function afterData() { drawLines(); updateLabels(); renderSheet(true); renderTop(); }
setInterval(() => { if (S.demo) demoStep(); if (S.ride) rideStep(); }, 1000);
renderTop(); renderSheet(true); sheetH(); updatePhotoAvail(); setStyle(S.style);
startGps();
await metaReady;
$('#dataInfo').textContent = S.meta
  ? `路線データ：${new Date(S.meta.v).toLocaleDateString('ja-JP')} 作成（${S.meta.routes.toLocaleString()}系統・${S.meta.stations.toLocaleString()}駅）。一度見た地域は端末に保存され、次回から通信なしで表示します。`
  : '路線データ：事前生成データが見つからないため、OpenStreetMap（Overpass API）から直接取得しています（時間がかかります）。';
setTimeout(() => { if (!S.nearCenter && !nearBusy) { const c = map.getCenter(); loadNear(c.lat, c.lng); } }, S.pos ? 0 : 4000);
window.__S = S; window.__map = map;
