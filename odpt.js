// 公共交通オープンデータセンター（ODPT）の時刻表を使って、乗っている列車の各駅の時刻を求める
//  - 通常の API（api.odpt.org）と、チャレンジ限定データ（api-challenge.odpt.org）の両方に対応
//  - 列車時刻表（TrainTimetable）があればそれを使い、無ければ各駅の駅時刻表（StationTimetable）をつないで推定する
const ENDPOINTS = { std: 'https://api.odpt.org/api/v4/', ch: 'https://api-challenge.odpt.org/api/v4/' };
const LSK = 'ekimap.odpt.';
const ls = {
  get(k, d) { try { const v = localStorage.getItem(LSK + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(LSK + k, JSON.stringify(v)); } catch (e) {} },
};
export const keys = () => ({ std: ls.get('key', ''), ch: ls.get('keyCh', '') });
export const setKeys = (std, ch) => { ls.set('key', (std || '').trim()); ls.set('keyCh', (ch || '').trim()); ls.set('railways', null); railwaysP = null; };
export const configured = () => { const k = keys(); return !!(k.std || k.ch); };

class OdptError extends Error {}
async function api(ep, type, params = {}) {
  const key = keys()[ep]; if (!key) throw new OdptError('no key');
  const q = new URLSearchParams({ ...params, 'acl:consumerKey': key });
  const res = await fetch(`${ENDPOINTS[ep]}${type}?${q}`);
  if (res.status === 401 || res.status === 403) throw new OdptError('auth');
  if (!res.ok) throw new OdptError('HTTP ' + res.status);
  return res.json();
}

/* ---- 日付（日本時間・祝日・運行日） ---- */
const JST = 9 * 3600e3;
function jstParts(t) { const d = new Date(t + JST); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay(), h: d.getUTCHours() }; }
function nthMonday(y, m, n) { const w = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return 1 + ((8 - w) % 7) + (n - 1) * 7; }
function holidaysOf(y) {
  const H = new Set(), add = (m, d) => H.add(m * 100 + d);
  add(1, 1); add(2, 11); add(2, 23); add(4, 29); add(5, 3); add(5, 4); add(5, 5); add(8, 11); add(11, 3); add(11, 23);
  add(1, nthMonday(y, 1, 2)); add(7, nthMonday(y, 7, 3)); add(9, nthMonday(y, 9, 3)); add(10, nthMonday(y, 10, 2));
  add(3, Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)));
  add(9, Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)));
  // 振替休日・国民の休日
  for (const md of [...H]) { const m = Math.floor(md / 100), d = md % 100; if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0) { let n = d + 1; while (H.has(m * 100 + n)) n++; add(m, n); } }
  for (let d = 2; d <= 30; d++) if (H.has(900 + d - 1) && H.has(900 + d + 1) && new Date(Date.UTC(y, 8, d)).getUTCDay() !== 0) add(9, d);
  return H;
}
/* 運行日：深夜3時までは前日のダイヤ */
function serviceDay(now) {
  let p = jstParts(now);
  if (p.h < 3) p = jstParts(now - 24 * 3600e3);
  const midnight = Date.UTC(p.y, p.m - 1, p.d) - JST;
  const hol = holidaysOf(p.y).has(p.m * 100 + p.d) || (p.m === 1 && p.d <= 3) || (p.m === 12 && p.d >= 30);
  const kind = hol || p.w === 0 ? 'holiday' : p.w === 6 ? 'saturday' : 'weekday';
  return { midnight, kind };
}
const CAL_PREF = {
  weekday: ['Weekday'],
  saturday: ['Saturday', 'SaturdayHoliday', 'Holiday'],
  holiday: ['Holiday', 'SundayHoliday', 'Sunday', 'SaturdayHoliday', 'Saturday'],
};
function pickCalendar(items, kind) {
  for (const c of CAL_PREF[kind]) { const hit = items.filter(x => String(x['odpt:calendar'] || '').endsWith(':' + c)); if (hit.length) return hit; }
  return items.filter(x => !x['odpt:calendar']);
}
const toMs = (hhmm, midnight) => { if (!hhmm) return null; const [h, m] = hhmm.split(':').map(Number); return midnight + ((h < 3 ? h + 24 : h) * 60 + m) * 60e3; };

/* ---- 路線（Railway）一覧と照合 ---- */
let railwaysP = null;
async function railways() {
  const cached = ls.get('railways', null);
  if (cached && Date.now() - cached.t < 7 * 864e5) return cached.list;
  const list = [];
  for (const ep of ['std', 'ch']) {
    if (!keys()[ep]) continue;
    try { for (const r of await api(ep, 'odpt:Railway')) list.push({ ep, id: r['owl:sameAs'], title: (r['odpt:railwayTitle'] || {}).ja || r['dc:title'], asc: r['odpt:ascendingRailDirection'], desc: r['odpt:descendingRailDirection'], order: (r['odpt:stationOrder'] || []).map(o => ({ id: o['odpt:station'], name: norm((o['odpt:stationTitle'] || {}).ja || ''), idx: o['odpt:index'] })) }); }
    catch (e) { if (e.message === 'auth') throw e; console.warn('odpt railway', ep, e); }
  }
  ls.set('railways', { t: Date.now(), list });
  return list;
}
const norm = s => String(s || '').replace(/[\s　]/g, '').replace(/駅$/, '').replace(/[ヶヵ]/g, 'ケ').replace(/[（(].*$/, '');
function matchRailway(list, route) {
  let best = null;
  for (const rw of list) {
    const pos = new Map(rw.order.map(o => [o.name, o]));
    const hits = route.stops.map((st, i) => ({ i, o: pos.get(norm(st.name)) })).filter(x => x.o);
    if (hits.length < 3 || (best && hits.length <= best.hits.length)) continue;
    best = { rw, hits };
  }
  if (!best || best.hits.length < Math.min(3, route.stops.length)) return null;
  const h = best.hits, up = h.slice(1).filter((x, k) => x.o.idx > h[k].o.idx).length;
  return { ...best, dir: up >= (h.length - 1) / 2 ? best.rw.asc : best.rw.desc, byStop: new Map(h.map(x => [x.i, x.o])) };
}

/* ---- 時刻表 ---- */
const stCache = new Map();
async function stationTimetable(m, stationId, sd) {
  const k = [m.rw.id, stationId, m.dir, sd.kind].join('|');
  if (!stCache.has(k)) stCache.set(k, (async () => {
    const items = await api(m.rw.ep, 'odpt:StationTimetable', { 'odpt:station': stationId, 'odpt:railway': m.rw.id, 'odpt:railDirection': m.dir });
    const objs = pickCalendar(items, sd.kind).flatMap(x => x['odpt:stationTimetableObject'] || []);
    return objs.map(o => ({ t: toMs(o['odpt:departureTime'] || o['odpt:arrivalTime'], sd.midnight), dest: [].concat(o['odpt:destinationStation'] || []).join(','), type: o['odpt:trainType'] || '', train: o['odpt:train'] || '', no: o['odpt:trainNumber'] || '' })).filter(o => o.t).sort((a, b) => a.t - b.t);
  })().catch(e => { stCache.delete(k); throw e; }));
  return stCache.get(k);
}
let typeNames = null;
async function trainTypeName(ep, id) {
  if (!id) return '';
  if (!typeNames) { typeNames = new Map(); for (const e of ['std', 'ch']) { if (!keys()[e]) continue; try { for (const t of await api(e, 'odpt:TrainType')) typeNames.set(t['owl:sameAs'], (t['odpt:trainTypeTitle'] || {}).ja || t['dc:title']); } catch (er) {} } }
  return typeNames.get(id) || id.split('.').pop();
}
function stationName(list, id) { for (const rw of list) { const o = rw.order.find(x => x.id === id); if (o) return o.name; } return String(id || '').split('.').pop(); }

/* 乗っている列車の候補（基準駅の発車時刻の前後） */
export async function candidates(route, refIdx, atStation, now = Date.now()) {
  const list = await railways(), m = matchRailway(list, route);
  if (!m) return { m: null, reason: 'この路線の時刻表データが見つかりません' };
  let k = refIdx; while (k >= 0 && !m.byStop.has(k)) k--;
  if (k < 0) { k = [...m.byStop.keys()].sort((a, b) => a - b)[0]; }
  const sd = serviceDay(now), deps = await stationTimetable(m, m.byStop.get(k).id, sd);
  if (!deps.length) return { m, reason: '時刻表が空でした' };
  let i = deps.findIndex(d => d.t >= now - (atStation ? 60e3 : 0));
  if (i < 0) i = deps.length;
  const from = Math.max(0, i - (atStation ? 1 : 2)), cands = deps.slice(from, from + 4);
  const auto = atStation ? deps[i] || deps[deps.length - 1] : deps[Math.max(0, i - 1)];
  for (const c of cands) c.label = `${hhmm(c.t)}発 ${await trainTypeName(m.rw.ep, c.type)}${c.dest ? ' ' + stationName(list, c.dest.split(',')[0]) + '行' : ''}`;
  return { m, k, sd, cands, auto };
}
const hhmm = t => { const p = new Date(t + JST); return p.getUTCHours() + ':' + String(p.getUTCMinutes()).padStart(2, '0'); };

/* 選んだ列車の各駅の時刻（停車駅の添字 → 到着見込みの時刻ms） */
export async function trainTimes(route, c, dep, horizon = 10) {
  const { m, k, sd } = c, out = new Map([[k, dep.t]]);
  // 1) 列車時刻表があれば、それで全駅が決まる
  try {
    const params = dep.train ? { 'odpt:train': dep.train } : dep.no ? { 'odpt:trainNumber': dep.no, 'odpt:railway': m.rw.id } : null;
    if (params) {
      const tts = pickCalendar(await api(m.rw.ep, 'odpt:TrainTimetable', params), sd.kind);
      const objs = tts.flatMap(x => x['odpt:trainTimetableObject'] || []);
      if (objs.length) {
        const at = new Map();
        for (const o of objs) { const id = o['odpt:arrivalStation'] || o['odpt:departureStation'], t = toMs(o['odpt:arrivalTime'] || o['odpt:departureTime'], sd.midnight); if (id && t && !at.has(id)) at.set(id, t); }
        for (const [i, o] of m.byStop) if (i > k && at.has(o.id)) out.set(i, at.get(o.id));
        if (out.size > 1) return { times: out, src: '列車時刻表' };
      }
    }
  } catch (e) { if (e.message === 'auth') throw e; }
  // 2) 各駅の駅時刻表をつなぐ：前の駅の発車から45秒以上あとの、行き先が同じ最初の列車
  let prev = dep.t, n = 0;
  const idxs = [...m.byStop.keys()].filter(i => i > k).sort((a, b) => a - b);
  for (const i of idxs) {
    if (++n > horizon) break;
    let deps;
    try { deps = await stationTimetable(m, m.byStop.get(i).id, sd); } catch (e) { if (e.message === 'auth') throw e; break; }
    const hit = deps.find(d => d.t >= prev + 45e3 && (!dep.dest || !d.dest || d.dest === dep.dest) && (!dep.type || !d.type || d.type === dep.type))
      || deps.find(d => d.t >= prev + 45e3 && (!dep.dest || !d.dest || d.dest === dep.dest));
    if (!hit) break; // 終点など、その方向の発車が無い駅
    if (hit.t - prev > 30 * 60e3) break; // 繋がらない（別の列車を拾っている）
    out.set(i, hit.t - 30e3); // 発車時刻の30秒前を到着とみなす
    prev = hit.t;
  }
  return { times: out, src: '駅時刻表' };
}
export const isAuthError = e => e instanceof OdptError && e.message === 'auth';
