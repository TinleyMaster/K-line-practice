// 按"VP 位置地图"框架重做：对每段趋势行情算完整成交量分布剖面，
// 提取 POC / 价值区 VA(70%) / HVN(高量节点=客观S/R) / LVN(低量真空带=加速区)，
// 看每段趋势的起(摆动低)/终(摆动高)落在 VA 的什么位置、POC 在哪、中间是否穿越 LVN。
// 目的：归纳"趋势行情的共性 VP 结构"，为定制策略提供特征（而非退化地量单点量）。
import { midPoints } from './backtestService.js';

const SYMBOL = 'BTCUSDT', MARKET = 'perp', INTERVAL = '1h', LIMIT = 5000;
const NB = 80;

const url = `http://127.0.0.1:8787/api/klines?symbol=${SYMBOL}&market=${MARKET}&interval=${INTERVAL}&limit=${LIMIT}`;
const j = await (await fetch(url)).json();
const bars = (j.bars || j.bars1h || []).map((b) => ({
  time: b.time, high: b.high, low: b.low, close: b.close, volume: b.volume || 0,
}));
const n = bars.length;

// ---- 摆动序列 + 趋势段（与记录同一套定义） ----
const mp = midPoints(bars, 12, 26, 9);
const seq = [];
for (let i = 0; i < n; i++) {
  if (mp.highs[i] != null) seq.push({ i, type: 'H', price: mp.highs[i] });
  else if (mp.lows[i] != null) seq.push({ i, type: 'L', price: mp.lows[i] });
}
function detectMoves(seq) {
  const out = []; let cur = null, lastHigh = null, lastLow = null;
  for (const s of seq) {
    if (s.type === 'H') {
      if (cur && cur.dir === 'up') { if (lastHigh && s.price > lastHigh.price) { cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true; } }
      else if (cur && cur.dir === 'down') { if (lastHigh && s.price < lastHigh.price) { cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true; } else { out.push(cur); cur = null; } }
      if (!cur && lastHigh && lastLow && s.price < lastHigh.price) cur = { dir: 'down', startIdx: lastHigh.i, startPrice: lastHigh.price, endIdx: s.i, endPrice: s.price, legs: 1, ext: false };
      lastHigh = s;
    } else {
      if (cur && cur.dir === 'up') { if (lastLow && s.price > lastLow.price) { cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true; } else { out.push(cur); cur = null; } }
      else if (cur && cur.dir === 'down') { if (lastLow && s.price < lastLow.price) { cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true; } }
      if (!cur && lastHigh && lastLow && s.price > lastLow.price) cur = { dir: 'up', startIdx: lastLow.i, startPrice: lastLow.price, endIdx: s.i, endPrice: s.price, legs: 1, ext: false };
      lastLow = s;
    }
  }
  if (cur) out.push(cur);
  return out.filter((m) => m.ext && Math.abs(m.endPrice - m.startPrice) / m.startPrice > 0.01);
}
const moves = detectMoves(seq);

// ---- 完整 VP 剖面 ----
function profile(a, b) {
  let pMin = Infinity, pMax = -Infinity;
  for (let k = a; k <= b; k++) { pMin = Math.min(pMin, bars[k].low); pMax = Math.max(pMax, bars[k].high); }
  const binSize = (pMax - pMin) / NB;
  const bins = new Array(NB).fill(0);
  for (let k = a; k <= b; k++) {
    const lo = bars[k].low, hi = bars[k].high, v = bars[k].volume;
    let b0 = Math.floor((lo - pMin) / binSize), b1 = Math.floor((hi - pMin) / binSize);
    if (b0 < 0) b0 = 0; if (b1 >= NB) b1 = NB - 1; if (b1 < b0) b1 = b0;
    const cnt = b1 - b0 + 1;
    for (let t = b0; t <= b1; t++) bins[t] += v / cnt;
  }
  const total = bins.reduce((s, x) => s + x, 0);
  let pocI = 0; for (let t = 1; t < NB; t++) if (bins[t] > bins[pocI]) pocI = t;
  const pocPrice = pMin + (pocI + 0.5) * binSize;
  // VA(70%) 自 POC 向两侧按量扩张
  const order = [...Array(NB).keys()].sort((x, y) => bins[y] - bins[x]);
  const set = new Set([pocI]); let cum = bins[pocI];
  for (const t of order) { if (t === pocI) continue; if (cum / total >= 0.7) break; set.add(t); cum += bins[t]; }
  let loT = pocI, hiT = pocI;
  for (const t of set) { loT = Math.min(loT, t); hiT = Math.max(hiT, t); }
  const vaLow = pMin + loT * binSize, vaHigh = pMin + (hiT + 1) * binSize;
  const avg = total / NB;
  const hvn = [];
  for (let t = 1; t < NB - 1; t++) if (bins[t] >= 1.5 * avg && bins[t] >= bins[t - 1] && bins[t] >= bins[t + 1]) hvn.push(pMin + (t + 0.5) * binSize);
  const lvn = [];
  for (let t = 0; t < NB; t++) if (bins[t] <= 0.4 * avg) lvn.push(pMin + (t + 0.5) * binSize);
  return { pocPrice, vaLow, vaHigh, hvn, lvn, pMin, pMax };
}

const recs = moves.map((m) => {
  const p = profile(m.startIdx, m.endIdx);
  // 用窗口实际极值：上涨段终点=最高、下跌段终点=最低（detectMoves 记的 endPrice 对下跌段是"终结更高高"，非真低点）
  let lowExt = Infinity, highExt = -Infinity;
  for (let k = m.startIdx; k <= m.endIdx; k++) { lowExt = Math.min(lowExt, bars[k].low); highExt = Math.max(highExt, bars[k].high); }
  const startPivot = m.startPrice;                       // 上涨=摆动低 / 下跌=摆动高（正确的起点）
  const endPivot = m.dir === 'up' ? highExt : lowExt;    // 终点取窗口真实极值
  const lo = Math.min(lowExt, highExt), hi = Math.max(lowExt, highExt);
  const pos = (price) => (price < p.vaLow ? 'below_VA' : (price > p.vaHigh ? 'above_VA' : 'in_VA'));
  const crossedLVN = p.lvn.filter((x) => x >= lo && x <= hi).length > 0;
  const pocThird = p.pocPrice < p.vaLow + (p.vaHigh - p.vaLow) / 3 ? 'low' : (p.pocPrice > p.vaLow + 2 * (p.vaHigh - p.vaLow) / 3 ? 'high' : 'mid');
  return {
    dir: m.dir, startPrice: startPivot, endPrice: endPivot,
    startPos: pos(startPivot), endPos: pos(endPivot),
    pocThird, hvnCount: p.hvn.length, crossedLVN,
    pocPrice: p.pocPrice, vaLow: p.vaLow, vaHigh: p.vaHigh,
  };
});

function pct(arr, f) { return (arr.filter(f).length / arr.length * 100).toFixed(0); }
const up = recs.filter((r) => r.dir === 'up'), down = recs.filter((r) => r.dir === 'down');
console.log(`趋势段=${recs.length}（涨${up.length}/跌${down.length}）\n`);
console.log('【上涨段 VP 结构共性】');
console.log(`  起点(摆动低) 位置: below_VA=${pct(up, r => r.startPos === 'below_VA')}%  in_VA=${pct(up, r => r.startPos === 'in_VA')}%  above_VA=${pct(up, r => r.startPos === 'above_VA')}%`);
console.log(`  终点(摆动高) 位置: below_VA=${pct(up, r => r.endPos === 'below_VA')}%  in_VA=${pct(up, r => r.endPos === 'in_VA')}%  above_VA=${pct(up, r => r.endPos === 'above_VA')}%`);
console.log(`  POC 位于: low=${pct(up, r => r.pocThird === 'low')}%  mid=${pct(up, r => r.pocThird === 'mid')}%  high=${pct(up, r => r.pocThird === 'high')}%`);
console.log(`  中段穿越 LVN(加速带)=${pct(up, r => r.crossedLVN)}%  平均 HVN 节点数=${(up.reduce((a, r) => a + r.hvnCount, 0) / up.length).toFixed(1)}`);
console.log('\n【下跌段 VP 结构共性】');
console.log(`  起点(摆动高) 位置: below_VA=${pct(down, r => r.startPos === 'below_VA')}%  in_VA=${pct(down, r => r.startPos === 'in_VA')}%  above_VA=${pct(down, r => r.startPos === 'above_VA')}%`);
console.log(`  终点(摆动低) 位置: below_VA=${pct(down, r => r.startPos === 'below_VA')}%  in_VA=${pct(down, r => r.endPos === 'in_VA')}%  above_VA=${pct(down, r => r.endPos === 'above_VA')}%`);
console.log(`  POC 位于: low=${pct(down, r => r.pocThird === 'low')}%  mid=${pct(down, r => r.pocThird === 'mid')}%  high=${pct(down, r => r.pocThird === 'high')}%`);
console.log(`  中段穿越 LVN(加速带)=${pct(down, r => r.crossedLVN)}%  平均 HVN 节点数=${(down.reduce((a, r) => a + r.hvnCount, 0) / down.length).toFixed(1)}`);

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
writeFileSync(fileURLToPath(new URL('./trend_vp_profile.json', import.meta.url)), JSON.stringify(recs, null, 2));
console.log(`\n已记录每段趋势的 VP 剖面特征 → trend_vp_profile.json`);
process.exit(0);
