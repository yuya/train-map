// オフライン用キャッシュ
//  - アプリ本体：ネット優先（更新をすぐ反映、圏外では保存版）
//  - 路線データ data/：保存版を優先。meta.json の版が変わったら作り直す
//  - ベースマップ PMTiles：Range リクエストを範囲ごとに保存（Cache API は 206 を保存できないため 200 に包む）
//  - 写真タイル・ライブラリ・フォント・地図スタイル：保存版を優先
const SHELL = 'shell-v4', DATA = 'data', PMT = 'pmtiles-v1', TILES = 'tiles-v2', LIBS = 'libs-v2';
const KEEP = [SHELL, DATA, PMT, TILES, LIBS];
const TILE_MAX = 3000, PMT_MAX = 8000;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    await caches.open(SHELL).then(c => c.addAll(['./', 'index.html', 'app.js', 'geo.js', 'odpt.js']).catch(() => {}));
    await caches.open(DATA).then(c => c.add('data/meta.json').catch(() => {}));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }
  catch (e) { const hit = await c.match(req, { ignoreSearch: true }); if (hit) return hit; throw e; }
}
async function cacheFirst(req, cacheName, trim) {
  const c = await caches.open(cacheName), hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200 && (res.type === 'basic' || res.type === 'cors')) { await c.put(req, res.clone()); if (trim && Math.random() < 0.02) trimCache(c, trim); }
  return res;
}
async function trimCache(c, max) { const ks = await c.keys(); if (ks.length > max) for (const k of ks.slice(0, ks.length - max + 200)) await c.delete(k); }
async function meta(req) {
  const c = await caches.open(DATA);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) {
      const fresh = await res.clone().json(), old = await c.match(req, { ignoreSearch: true });
      const oldV = old ? (await old.json()).v : null;
      if (oldV && oldV !== fresh.v) await caches.delete(DATA);
      await (await caches.open(DATA)).put(req, res.clone());
    }
    return res;
  } catch (e) { const hit = await c.match(req, { ignoreSearch: true }); if (hit) return hit; throw e; }
}

/* PMTiles の Range リクエスト
   - 先頭（ヘッダ）はネット優先。ファイルの版（ETag）が変わっていたら保存済みの範囲を全部捨てる
   - それ以外の範囲は保存版を優先。圏外では保存済みの範囲だけで地図を出す */
const rangeKey = (url, range) => url + (url.includes('?') ? '&' : '?') + '__range=' + encodeURIComponent(range);
function partial(buf, m) {
  const h = new Headers({ 'Content-Range': m.cr, 'Content-Length': String(buf.byteLength), 'Content-Type': 'application/octet-stream' });
  if (m.etag) h.set('ETag', m.etag);
  return new Response(buf, { status: 206, statusText: 'Partial Content', headers: h });
}
async function storeRange(c, key, res) {
  const buf = await res.arrayBuffer();
  const m = { cr: res.headers.get('Content-Range') || `bytes 0-${buf.byteLength - 1}/${buf.byteLength}`, etag: res.headers.get('ETag') };
  await c.put(key, new Response(buf.slice(0), { status: 200, headers: { 'x-range-meta': JSON.stringify(m) } }));
  return [buf, m];
}
async function readStored(hit) { return [await hit.arrayBuffer(), JSON.parse(hit.headers.get('x-range-meta'))]; }
async function pmtiles(req) {
  const range = req.headers.get('Range'), url = req.url.split('#')[0], key = rangeKey(url, range);
  const isHeader = /^bytes=0-/.test(range);
  let c = await caches.open(PMT);
  if (isHeader) {
    try {
      const res = await fetch(url, { headers: { Range: range }, mode: 'cors', cache: 'no-store' });
      if (res.status !== 206) return res;
      const old = await c.match(key), oldEtag = old ? JSON.parse(old.headers.get('x-range-meta')).etag : null;
      if (old && oldEtag !== res.headers.get('ETag')) { await caches.delete(PMT); c = await caches.open(PMT); }
      const [buf, m] = await storeRange(c, key, res);
      return partial(buf, m);
    } catch (e) {
      const hit = await c.match(key); if (hit) return partial(...(await readStored(hit))); throw e;
    }
  }
  const hit = await c.match(key);
  if (hit) return partial(...(await readStored(hit)));
  const res = await fetch(url, { headers: { Range: range }, mode: 'cors' });
  if (res.status !== 206) return res;
  const [buf, m] = await storeRange(c, key, res);
  if (Math.random() < 0.01) trimCache(c, PMT_MAX);
  return partial(buf, m);
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.pathname.endsWith('.pmtiles') && req.headers.has('Range')) return e.respondWith(pmtiles(req));
  if (u.origin === self.location.origin) {
    if (u.pathname.endsWith('/data/meta.json')) return e.respondWith(meta(req));
    if (u.pathname.includes('/data/')) return e.respondWith(cacheFirst(req, DATA));
    return e.respondWith(networkFirst(req, SHELL));
  }
  if (u.hostname === 'cyberjapandata.gsi.go.jp') return e.respondWith(cacheFirst(req, TILES, TILE_MAX));
  if (u.hostname === 'gsi-cyberjapan.github.io' && /\/style\/[^/]+\.json$/.test(u.pathname)) return e.respondWith(networkFirst(req, LIBS));
  if (/^(cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|gsi-cyberjapan\.github\.io)$/.test(u.hostname)) return e.respondWith(cacheFirst(req, LIBS));
});
