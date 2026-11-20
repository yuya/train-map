// 路線データの幾何処理（ブラウザとデータ生成スクリプトで共用）
export const rad = Math.PI / 180, ER = 6371000;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const dist = (a, b) => {
  const x = (b[1] - a[1]) * rad * Math.cos(((a[0] + b[0]) / 2) * rad), y = (b[0] - a[0]) * rad;
  return Math.hypot(x, y) * ER;
};
export function cumul(ch) { const c = [0]; for (let i = 1; i < ch.length; i++) c.push(c[i - 1] + dist(ch[i - 1], ch[i])); return c; }
export function project(ch, cum, p) {
  if (ch.length < 2) return ch.length ? { d: dist(ch[0], p), s: 0, i: 0 } : { d: Infinity, s: 0, i: 0 };
  const kx = Math.cos(p[0] * rad) * rad * ER, ky = rad * ER; let best = { d: Infinity, s: 0, i: 0 };
  for (let i = 0; i < ch.length - 1; i++) {
    const ax = (ch[i][1] - p[1]) * kx, ay = (ch[i][0] - p[0]) * ky, bx = (ch[i + 1][1] - p[1]) * kx, by = (ch[i + 1][0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.d) best = { d, i, s: cum[i] + t * (cum[i + 1] - cum[i]) };
  }
  return best;
}
export function idxAt(cum, s) { let lo = 0, hi = cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; } return lo; }
export function pointAt(ch, cum, s) {
  if (!ch.length) return null; s = clamp(s, 0, cum[cum.length - 1]); const i = idxAt(cum, s);
  if (i >= ch.length - 1) return ch[ch.length - 1]; const f = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
  return [ch[i][0] + (ch[i + 1][0] - ch[i][0]) * f, ch[i][1] + (ch[i + 1][1] - ch[i][1]) * f];
}

/* ---- OSM のタグ解釈 ---- */
export const ROUTE_RE = /^(train|subway|light_rail|monorail|tram)$/;
export const isStopTags = t => t && (/^(station|halt|stop|tram_stop)$/.test(t.railway || '') || /^(stop_position|station)$/.test(t.public_transport || ''));
export const hasJa = s => /[\u3040-\u30ff\u3400-\u9fff]/.test(s || '');
/* 日本語の名前を優先（name:ja → name） */
export const jaName = t => (t && (t['name:ja'] || t.name)) || '';
export const cleanName = n => (n || '').replace(/[\s　]*[（(][^）)]*[）)]\s*$/, '').replace(/[\s　]*\d+番(線|のりば).*$/, '').replace(/駅$/, '').trim();
export const baseLine = n => (n || '')
  .replace(/[\s　]*[（(].*$/, '')
  .replace(/[\s　]*[:：].*(→|↔|⇔|<=>|=>|->|～|〜).*$/, '')
  .replace(/[\s　]+\S+[\s　]*(→|↔|⇔|<=>|=>|->)[\s　]*\S+.*$/, '')
  .replace(/[\s　]+(上り|下り|内回り|外回り|.*方面).*$/, '').trim();
export const SERVICE = /(臨時|快速特急|通勤特急|特急|快速急行|通勤急行|区間急行|急行|通勤準急|準急|特別快速|通勤快速|区間快速|新快速|快速|区間準急|各駅停車|各停|普通|ライナー|のぞみ|ひかり|こだま|はやぶさ|やまびこ|なすの|とき|たにがわ|かがやき|はくたか|あさま|つばさ|こまち|みずほ|さくら|つばめ)/;
export function hashColour(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 60% 42%)`; }
export function lineKind(t, name) {
  if (/新幹線/.test(name)) return 'shin';
  if (t.route === 'subway') return 'sub';
  if (t.route === 'tram' || t.route === 'light_rail') return 'tram';
  if (t.route === 'monorail') return 'mono';
  return 'train';
}

/* ---- ウェイを1本の線につなぐ ---- */
export function assemble(ways, ids) {
  const segs = ids.map(id => ways.get(id)).filter(a => a && a.length > 1).map(a => a.slice());
  if (!segs.length) return [];
  const touch = (a, b) => dist(a, b) < 5;
  let out = segs[0];
  if (segs.length > 1) {
    const s1 = segs[1], e0 = out[out.length - 1];
    if (!(touch(e0, s1[0]) || touch(e0, s1[s1.length - 1])) && (touch(out[0], s1[0]) || touch(out[0], s1[s1.length - 1]))) out.reverse();
  }
  for (let i = 1; i < segs.length; i++) {
    const g = segs[i], e = out[out.length - 1];
    if (touch(e, g[0])) out = out.concat(g.slice(1));
    else if (touch(e, g[g.length - 1])) out = out.concat(g.reverse().slice(1));
    else { if (dist(e, g[g.length - 1]) < dist(e, g[0])) g.reverse(); out = out.concat(g); }
  }
  return out;
}

/* 名前のない停車位置に、近くの駅名を当てる（格子で検索） */
export function makeNameNear(nodes) {
  const grid = new Map(), K = 0.005;
  for (const n of nodes.values()) {
    if (!n.tags || !jaName(n.tags) || !isStopTags(n.tags)) continue;
    const k = Math.floor(n.lat / K) + ',' + Math.floor(n.lon / K);
    (grid.get(k) || grid.set(k, []).get(k)).push(n);
  }
  return n => {
    let best = null, bd = 350; const y = Math.floor(n.lat / K), x = Math.floor(n.lon / K);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const m of grid.get((y + dy) + ',' + (x + dx)) || []) {
      const d = dist([n.lat, n.lon], [m.lat, m.lon]); if (d < bd) { bd = d; best = jaName(m.tags); }
    }
    return best;
  };
}

/* 停車駅を線上に並べる（向きの確認、壊れた線は駅を結んだ線で代用） */
export function placeStops(chain, stops) {
  let cum = cumul(chain);
  const place = () => { for (const st of stops) { const p = project(chain, cum, [st.lat, st.lon]); st.s = p.s; st.d = p.d; } };
  const mono = () => { let up = 0, dn = 0; for (let i = 1; i < stops.length; i++) { if (stops[i].s > stops[i - 1].s) up++; else dn++; } return [up, dn]; };
  if (chain.length > 1) {
    place(); let [up, dn] = mono();
    if (dn > up) { chain.reverse(); cum = cumul(chain); place(); [up, dn] = mono(); }
    if (up / (stops.length - 1) < 0.8 || stops.some(st => st.d > 600)) chain = [];
  }
  if (chain.length < 2) { chain = stops.map(st => [st.lat, st.lon]); cum = cumul(chain); place(); }
  return { chain, cum };
}

/* OSM の route リレーション1本 → 路線オブジェクト */
export function buildRoute(r, { nodes, ways, masterOf, nameNear }) {
  const t = r.tags || {}, m = masterOf.get(r.id), mt = m ? m.tags || {} : {};
  const name = jaName(t) || t.ref || '路線';
  let lineName = baseLine(jaName(mt)) || baseLine(name) || name;
  const key = m ? 'm' + m.id : (t.operator || '') + '|' + lineName;
  const wayIds = r.members.filter(x => x.type === 'way' && !/platform/.test(x.role)).map(x => x.ref);
  let sIds = r.members.filter(x => x.type === 'node' && /^stop/.test(x.role)).map(x => x.ref);
  if (!sIds.length) sIds = r.members.filter(x => x.type === 'node' && isStopTags((nodes.get(x.ref) || {}).tags)).map(x => x.ref);
  if (!sIds.length) sIds = r.members.filter(x => x.type === 'node' && /platform/.test(x.role)).map(x => x.ref);
  const stops = [];
  for (const id of sIds) {
    const n = nodes.get(id); if (!n) continue;
    const nm = cleanName(jaName(n.tags) || nameNear(n) || ''); if (!nm) continue;
    if (stops.length && stops[stops.length - 1].name === nm) continue;
    stops.push({ name: nm, lat: n.lat, lon: n.lon, s: 0 });
  }
  if (stops.length < 2) return null;
  // 英語だけの名前は、日本語の事業者名＋始点〜終点に置き換える
  if (!hasJa(lineName)) {
    const op = [t['operator:ja'], t.operator, mt['operator:ja'], mt.operator, t['network:ja'], t.network].find(hasJa);
    if (op) lineName = `${op}（${stops[0].name}〜${stops[stops.length - 1].name}）`;
  }
  const { chain } = placeStops(assemble(ways, wayIds), stops);
  return {
    id: r.id, name, lineName, key, colour: t.colour || mt.colour || null,
    svc: t.service || (name.match(SERVICE) || [])[0] || '',
    to: cleanName(hasJa(t['to:ja']) ? t['to:ja'] : hasJa(t.to) ? t.to : '') || stops[stops.length - 1].name,
    kind: lineKind(t, name), loop: stops[0].name === stops[stops.length - 1].name,
    chain, stops, wayIds,
  };
}

/* ---- 線の間引き（Douglas–Peucker、メートル単位） ---- */
export function simplify(ch, tol = 4) {
  if (ch.length < 3) return ch.slice();
  const lat0 = ch[0][0], kx = Math.cos(lat0 * rad) * rad * ER, ky = rad * ER;
  const P = ch.map(p => [p[1] * kx, p[0] * ky]), keep = new Uint8Array(ch.length);
  keep[0] = keep[ch.length - 1] = 1; const stack = [[0, ch.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let md = 0, mi = -1;
    const [ax, ay] = P[a], [bx, by] = P[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let t = L2 ? ((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / L2 : 0; t = clamp(t, 0, 1);
      const d = Math.hypot(P[i][0] - ax - t * dx, P[i][1] - ay - t * dy); if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return ch.filter((_, i) => keep[i]);
}
/* 座標列 ⇄ 1e5 倍整数の差分列 */
export function encodeShape(ch) {
  const out = []; let pa = 0, po = 0;
  for (const [a, o] of ch) { const A = Math.round(a * 1e5), O = Math.round(o * 1e5); out.push(A - pa, O - po); pa = A; po = O; }
  return out;
}
export function decodeShape(arr) {
  const out = []; let a = 0, o = 0;
  for (let i = 0; i < arr.length; i += 2) { a += arr[i]; o += arr[i + 1]; out.push([a / 1e5, o / 1e5]); }
  return out;
}
