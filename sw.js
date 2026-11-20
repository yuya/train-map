// オフライン用キャッシュ
//  - アプリ本体：ネット優先（更新をすぐ反映、圏外では保存版）
//  - 路線データ data/：保存版を優先。meta.json の版が変わったら作り直す
//  - 地図タイル・ライブラリ・フォント：保存版を優先
const SHELL = 'shell-v2', DATA = 'data', TILES = 'tiles', LIBS = 'libs';
const TILE_MAX = 4000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', 'index.html', 'app.js', 'geo.js']).catch(() => {})).then(() => caches.open(DATA)).then(c => c.add('data/meta.json').catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => ![SHELL, DATA, TILES, LIBS].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
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
  if (res.ok && (res.type === 'basic' || res.type === 'cors')) { await c.put(req, res.clone()); if (trim && Math.random() < 0.02) trimCache(c, trim); }
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
      if (oldV && oldV !== fresh.v) { await caches.delete(DATA); }
      await (await caches.open(DATA)).put(req, res.clone());
    }
    return res;
  } catch (e) { const hit = await c.match(req, { ignoreSearch: true }); if (hit) return hit; throw e; }
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === self.location.origin) {
    if (u.pathname.endsWith('/data/meta.json')) return e.respondWith(meta(req));
    if (u.pathname.includes('/data/')) return e.respondWith(cacheFirst(req, DATA));
    return e.respondWith(networkFirst(req, SHELL));
  }
  if (u.hostname === 'cyberjapandata.gsi.go.jp') return e.respondWith(cacheFirst(req, TILES, TILE_MAX));
  if (/^(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(u.hostname)) return e.respondWith(cacheFirst(req, LIBS));
});
