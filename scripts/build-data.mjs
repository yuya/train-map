#!/usr/bin/env node
// 全国の鉄道路線データを OpenStreetMap（Overpass API）から取得し、
// アプリが読む静的ファイル（data/）に変換する。GitHub Actions で月1回実行。
//
//   node scripts/build-data.mjs --out _site/data            全国
//   node scripts/build-data.mjs --out _site/data --prefs 13 東京都だけ（試験用）
//   node scripts/build-data.mjs --out data --mock mock.json  手元のJSONで試す
//
// 出力:
//   meta.json          生成日時・件数・タイル寸法
//   t/{x}_{y}.json     0.05°格子ごとの {r:[路線ID], st:[[駅ID,駅名,緯度,経度,[路線ID]]]}
//   r/{id}.json        路線（系統）ごとのメタ情報と停車駅
//   s/{hash}.json      線形（差分符号化した座標列。同じ線形は共有）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as G from '../geo.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.concat([[v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const OUT = args.out || 'data';
const TILE = 0.05;
const BATCH = +args.batch || 40;
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const ROUTES = 'train|subway|light_rail|monorail|tram';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function overpass(q) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(400_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'train-map data builder (github.com/yuya/train-map)' },
        body: 'data=' + encodeURIComponent(q),
      });
      if (res.ok) return await res.json();
      last = new Error(`${url} HTTP ${res.status}`);
    } catch (e) { last = e; }
    log('retry', attempt + 1, String(last.message || last));
    await sleep(15_000 * (attempt + 1));
  }
  throw last;
}

const mock = args.mock ? JSON.parse(fs.readFileSync(args.mock, 'utf8')) : null;

async function listRouteIds() {
  if (mock) return mock.elements.filter(e => e.type === 'relation' && e.tags && e.tags.type === 'route').map(e => e.id);
  const prefs = args.prefs ? String(args.prefs).split(',').map(Number) : Array.from({ length: 47 }, (_, i) => i + 1);
  const ids = new Set();
  for (const p of prefs) {
    const code = 'JP-' + String(p).padStart(2, '0');
    const j = await overpass(`[out:json][timeout:300];area["ISO3166-2"="${code}"]->.a;rel(area.a)[type=route][route~"^(${ROUTES})$"];out ids;`);
    const before = ids.size; for (const e of j.elements) ids.add(e.id);
    log(code, 'routes', ids.size - before, 'total', ids.size);
    await sleep(3000);
  }
  return [...ids].sort((a, b) => a - b);
}
async function fetchBatch(ids) {
  if (mock) return mock;
  return overpass(`[out:json][timeout:600];rel(id:${ids.join(',')})->.r;.r out body qt;rel(br.r)[type=route_master];out tags qt;way(r.r)->.w;.w out skel geom qt;node(r.r)->.n;.n out body qt;`);
}

/* ---- 取得と変換 ---- */
const routes = [];
const ids = await listRouteIds();
log('route relations:', ids.length);
for (let i = 0; i < ids.length; i += BATCH) {
  const want = new Set(ids.slice(i, i + BATCH));
  const j = await fetchBatch([...want]);
  const nodes = new Map(), ways = new Map(), masterOf = new Map(), rels = [];
  for (const e of j.elements || []) {
    if (e.type === 'node') nodes.set(e.id, { lat: e.lat, lon: e.lon, tags: e.tags || {} });
    else if (e.type === 'way' && e.geometry) ways.set(e.id, e.geometry.filter(Boolean).map(p => [p.lat, p.lon]));
    else if (e.type === 'relation') {
      if (e.tags && e.tags.type === 'route_master') (e.members || []).forEach(m => { if (m.type === 'relation') masterOf.set(m.ref, e); });
      else if (want.has(e.id) && e.tags && G.ROUTE_RE.test(e.tags.route || '')) rels.push(e);
    }
  }
  const nameNear = G.makeNameNear(nodes);
  for (const r of rels) {
    try {
      const b = G.buildRoute(r, { nodes, ways, masterOf, nameNear });
      if (!b) continue;
      const chain = G.simplify(b.chain, 4);
      G.placeStops(chain, b.stops);
      b.chain = chain; delete b.wayIds;
      routes.push(b);
    } catch (e) { log('skip', r.id, e.message); }
  }
  log(`batch ${i / BATCH + 1}/${Math.ceil(ids.length / BATCH)} → routes ${routes.length}`);
  if (mock) break;
  await sleep(2000);
}
if (!routes.length) { console.error('路線が1本も作れませんでした'); process.exit(1); }

/* ---- 路線（系統グループ）の色をそろえる ---- */
const groupColour = new Map();
for (const r of routes) if (r.colour && !groupColour.has(r.key)) groupColour.set(r.key, r.colour);
for (const r of routes) r.colour = groupColour.get(r.key) || G.hashColour(r.key);

/* ---- 駅をまとめる（同名で800m以内） ---- */
const stations = [], sGrid = new Map(), SK = 0.01;
function stationFor(name, lat, lon) {
  const y = Math.floor(lat / SK), x = Math.floor(lon / SK);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const st of sGrid.get((y + dy) + ',' + (x + dx)) || [])
    if (st.name === name && G.dist([st.lat, st.lon], [lat, lon]) < 800) return st;
  const st = { id: 's' + stations.length.toString(36), name, lat, lon, routes: new Set() };
  stations.push(st); const k = y + ',' + x; (sGrid.get(k) || sGrid.set(k, []).get(k)).push(st);
  return st;
}
for (const r of routes) for (const s of r.stops) { const st = stationFor(s.name, s.lat, s.lon); st.routes.add(r.id); s.sid = st.id; }

/* ---- 書き出し ---- */
fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['t', 'r', 's']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
const r5 = v => Math.round(v * 1e5) / 1e5;
const tiles = new Map();
const tileOf = (lat, lon) => Math.floor(lon / TILE) + '_' + Math.floor(lat / TILE);
const tileGet = k => tiles.get(k) || tiles.set(k, { r: new Set(), st: [] }).get(k);
const shapes = new Set();
for (const r of routes) {
  const enc = G.encodeShape(r.chain), sh = crypto.createHash('sha1').update(enc.join(',')).digest('hex').slice(0, 12);
  if (!shapes.has(sh)) { shapes.add(sh); fs.writeFileSync(path.join(OUT, 's', sh + '.json'), JSON.stringify(enc)); }
  fs.writeFileSync(path.join(OUT, 'r', r.id + '.json'), JSON.stringify({
    id: r.id, n: r.name, l: r.lineName, k: r.key, c: r.colour, svc: r.svc, to: r.to, kind: r.kind, loop: r.loop, sh,
    st: r.stops.map(s => [s.sid, s.name, r5(s.lat), r5(s.lon), Math.round(s.s)]),
  }));
  // 線が通る格子に路線IDを登録（約300mおきに標本）
  const ch = r.chain;
  for (let i = 0; i < ch.length; i++) {
    tileGet(tileOf(ch[i][0], ch[i][1])).r.add(r.id);
    if (i < ch.length - 1) {
      const n = Math.floor(G.dist(ch[i], ch[i + 1]) / 300);
      for (let k = 1; k <= n; k++) { const f = k / (n + 1); tileGet(tileOf(ch[i][0] + (ch[i + 1][0] - ch[i][0]) * f, ch[i][1] + (ch[i + 1][1] - ch[i][1]) * f)).r.add(r.id); }
    }
  }
}
for (const st of stations) tileGet(tileOf(st.lat, st.lon)).st.push([st.id, st.name, r5(st.lat), r5(st.lon), [...st.routes]]);
for (const [k, t] of tiles) fs.writeFileSync(path.join(OUT, 't', k + '.json'), JSON.stringify({ r: [...t.r], st: t.st }));
const meta = { v: new Date().toISOString(), tile: TILE, routes: routes.length, stations: stations.length, shapes: shapes.size, tiles: tiles.size, source: 'OpenStreetMap contributors (ODbL)' };
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta));
log('done', meta);
