// 基于 VP 强度的拐点回踩策略回测（决策级，非 app 集成）：
// 方向1（按判断优先测）：低量摆动低点回踩做多 / 低量摆动高点反抽做空。
// 对照：高量拐点回踩（验证"高量反而弱"是否在 P&L 上成立）。
// 防前视：VP 强度用拐点 ±W 窗口（含未来 50 根），信号只在 拐点Idx+W 之后触发。
// 出场：固定 R 止盈(tpR) 或 ATR 式追踪(trailR)；止损放拐点外 stopPct。
import { midPoints } from './backtestService.js';

const SYMBOL = 'BTCUSDT', MARKET = 'perp', INTERVAL = '1h', LIMIT = 5000;
const W = 50, NB = 60;

const url = `http://127.0.0.1:8787/api/klines?symbol=${SYMBOL}&market=${MARKET}&interval=${INTERVAL}&limit=${LIMIT}`;
const j = await (await fetch(url)).json();
const bars = (j.bars || j.bars1h || []).map((b) => ({
  time: b.time, high: b.high, low: b.low, close: b.close, volume: b.volume || 0,
}));
const n = bars.length;

function vpShare(idx, price) {
  const a = Math.max(0, idx - W), b = Math.min(n - 1, idx + W);
  let pMin = Infinity, pMax = -Infinity;
  for (let k = a; k <= b; k++) { pMin = Math.min(pMin, bars[k].low); pMax = Math.max(pMax, bars[k].high); }
  if (!(pMax > pMin)) return 0;
  const binSize = (pMax - pMin) / NB, bins = new Array(NB).fill(0);
  for (let k = a; k <= b; k++) {
    const hl2 = (bars[k].high + bars[k].low) / 2;
    let bi = Math.floor((hl2 - pMin) / binSize);
    if (bi < 0) bi = 0; if (bi >= NB) bi = NB - 1;
    bins[bi] += bars[k].volume;
  }
  const total = bins.reduce((s, v) => s + v, 0);
  let c = 0;
  for (let t = 0; t < NB; t++) { const bp = pMin + (t + 0.5) * binSize; if (bp >= price * 0.99 && bp <= price * 1.01) c += bins[t]; }
  return c / total;
}

const mp = midPoints(bars, 12, 26, 9);
const pivots = [];
for (let i = 0; i < n; i++) {
  if (mp.highs[i] != null) pivots.push({ i, type: 'H', price: mp.highs[i], share: vpShare(i, mp.highs[i]) });
  else if (mp.lows[i] != null) pivots.push({ i, type: 'L', price: mp.lows[i], share: vpShare(i, mp.lows[i]) });
}
// 按类型分强/弱（上30%=strong 高量，下30%=weak 低量）
for (const type of ['H', 'L']) {
  const arr = pivots.filter((p) => p.type === type).sort((x, y) => x.share - y.share);
  arr.forEach((p, k) => { p.strength = k < arr.length * 0.3 ? 'weak' : (k > arr.length * 0.7 ? 'strong' : 'mid'); });
}

function run(strFilter, { stopPct = 0.6, tpR = 2, trailR = 0, maxBars = 300 }) {
  const trades = [];
  for (const p of pivots) {
    if (!strFilter(p)) continue;
    const side = p.type === 'L' ? 'long' : 'short';
    const p0 = p.i + W; // 防前视：窗口闭合后才允许信号
    if (p0 >= n) continue;
    // 找回踩：之后第一根触到 ±0.5% 区间且"守住"(收盘回到拐点外/上) 的 K 线
    let entryBar = -1;
    for (let k = p0; k < n; k++) {
      const near = bars[k].low <= p.price * 1.005 && bars[k].high >= p.price * 0.995;
      if (!near) continue;
      const held = side === 'long' ? bars[k].close >= p.price : bars[k].close <= p.price;
      if (held) { entryBar = k; break; }
      else continue; // 触及但收在拐点另一侧 = 跌破/突破，不算"回踩守住"
    }
    if (entryBar < 0) continue;
    const entry = bars[entryBar].close;
    const stop = side === 'long' ? p.price * (1 - stopPct / 100) : p.price * (1 + stopPct / 100);
    const risk = Math.abs(entry - stop);
    if (risk <= 0) continue;
    const trailPct = trailR * risk / entry;
    let exit = null, highest = bars[entryBar].high, lowest = bars[entryBar].low, trailed = false;
    for (let k = entryBar + 1; k <= Math.min(n - 1, entryBar + maxBars); k++) {
      const hi = bars[k].high, lo = bars[k].low;
      highest = Math.max(highest, hi); lowest = Math.min(lowest, lo);
      if (side === 'long') {
        if (lo <= stop) { exit = { price: stop, k }; break; }
        if (trailR > 0) {
          if (highest >= entry + trailR * risk) trailed = true;
          if (trailed && lo <= highest * (1 - trailPct)) { exit = { price: highest * (1 - trailPct), k }; break; }
          if (hi >= entry + risk * tpR && trailR === 0) { exit = { price: entry + risk * tpR, k }; break; }
        } else if (hi >= entry + risk * tpR) { exit = { price: entry + risk * tpR, k }; break; }
      } else {
        if (hi >= stop) { exit = { price: stop, k }; break; }
        if (trailR > 0) {
          if (lowest <= entry - trailR * risk) trailed = true;
          if (trailed && hi >= lowest * (1 + trailPct)) { exit = { price: lowest * (1 + trailPct), k }; break; }
          if (lo <= entry - risk * tpR && trailR === 0) { exit = { price: entry - risk * tpR, k }; break; }
        } else if (lo <= entry - risk * tpR) { exit = { price: entry - risk * tpR, k }; break; }
      }
    }
    if (!exit) exit = { price: bars[Math.min(n - 1, entryBar + maxBars)].close, k: Math.min(n - 1, entryBar + maxBars) };
    const r = side === 'long' ? (exit.price - entry) / risk : (entry - exit.price) / risk;
    trades.push({ side, r, hold: exit.k - entryBar });
  }
  const wins = trades.filter((t) => t.r > 0).length;
  const totalR = trades.reduce((a, t) => a + t.r, 0);
  const pf = (() => { const w = trades.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0); const l = -trades.filter((t) => t.r <= 0).reduce((a, t) => a + t.r, 0); return l > 0 ? w / l : (w > 0 ? Infinity : 0); })();
  return { n: trades.length, win: wins, winRate: trades.length ? wins / trades.length * 100 : 0, totalR, pf, avgR: trades.length ? totalR / trades.length : 0 };
}

const weak = (p) => p.strength === 'weak';
const strong = (p) => p.strength === 'strong';

console.log('=== 方向1：低量拐点回踩（做多低点 / 做空高点）===');
for (const ex of [{ tpR: 2, trailR: 0 }, { tpR: 100, trailR: 2 }]) {
  const r = run(weak, ex);
  console.log(`  出场=${ex.trailR > 0 ? '追踪2R' : '固定2R'}  笔数=${r.n} 胜率=${r.winRate.toFixed(0)}% PF=${isFinite(r.pf) ? r.pf.toFixed(2) : '∞'} 总R=${r.totalR.toFixed(1)} 均R=${r.avgR.toFixed(2)}`);
}
console.log('=== 对照：高量拐点回踩（验证"高量反而弱"）===');
for (const ex of [{ tpR: 2, trailR: 0 }, { tpR: 100, trailR: 2 }]) {
  const r = run(strong, ex);
  console.log(`  出场=${ex.trailR > 0 ? '追踪2R' : '固定2R'}  笔数=${r.n} 胜率=${r.winRate.toFixed(0)}% PF=${isFinite(r.pf) ? r.pf.toFixed(2) : '∞'} 总R=${r.totalR.toFixed(1)} 均R=${r.avgR.toFixed(2)}`);
}
console.log('=== 中量拐点回踩（基线）===');
for (const ex of [{ tpR: 2, trailR: 0 }, { tpR: 100, trailR: 2 }]) {
  const r = run((p) => p.strength === 'mid', ex);
  console.log(`  出场=${ex.trailR > 0 ? '追踪2R' : '固定2R'}  笔数=${r.n} 胜率=${r.winRate.toFixed(0)}% PF=${isFinite(r.pf) ? r.pf.toFixed(2) : '∞'} 总R=${r.totalR.toFixed(1)} 均R=${r.avgR.toFixed(2)}`);
}
process.exit(0);
