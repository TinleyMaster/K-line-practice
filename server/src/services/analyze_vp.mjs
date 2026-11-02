// 摆动高/低点的 VP（成交量分布 / 筹码）分析 + S/R 实战检验：
// 1) 对每个 MACD 锚定的摆动高/低点，取前后 W 根 K 线，把成交量按价格分箱，
//    以「该拐点价位 ±0.5% / ±1% 内的筹码占比」衡量其强度（高量=强 S/R，低量=薄弱）。
// 2) 前向检验：拐点后 FW 根内若价格回踩到该水平(±0.5%)，看是守住(未创新低/高)还是跌破/突破。
//    比较「强量水平」与「弱量水平」的守住率，判断 VP 强度能否预测 S/R 有效性。
// 用途：若强量拐点明显更"撑得住"，即可设计"回踩强支撑做多 / 反抽强阻力做空"策略。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { midPoints } from './backtestService.js';

const SYMBOL = 'BTCUSDT', MARKET = 'perp', INTERVAL = '1h', LIMIT = 5000;
const W = 50;    // 拐点前后窗口（根），覆盖该水平的形成 + 早期回踩
const NB = 60;   // 价格分箱数
const FW = 100;  // 前向检验窗口（根）

const url = `http://127.0.0.1:8787/api/klines?symbol=${SYMBOL}&market=${MARKET}&interval=${INTERVAL}&limit=${LIMIT}`;
const j = await (await fetch(url)).json();
const bars = (j.bars || j.bars1h || []).map((b) => ({
  time: b.time, high: b.high, low: b.low, close: b.close, volume: b.volume || 0,
}));
const n = bars.length;
console.log(`bars=${n}  range ${new Date(bars[0].time)} → ${new Date(bars[n - 1].time)}`);

const mp = midPoints(bars, 12, 26, 9);
const sw = [];
for (let i = 0; i < n; i++) {
  if (mp.highs[i] != null) sw.push({ i, type: 'H', price: mp.highs[i] });
  else if (mp.lows[i] != null) sw.push({ i, type: 'L', price: mp.lows[i] });
}
console.log(`摆动点合计=${sw.length}（高${sw.filter((s) => s.type === 'H').length}/低${sw.filter((s) => s.type === 'L').length}）`);

function vpAt(idx, price) {
  const a = Math.max(0, idx - W), b = Math.min(n - 1, idx + W);
  let pMin = Infinity, pMax = -Infinity;
  for (let k = a; k <= b; k++) { pMin = Math.min(pMin, bars[k].low); pMax = Math.max(pMax, bars[k].high); }
  if (!(pMax > pMin)) return null;
  const binSize = (pMax - pMin) / NB;
  const bins = new Array(NB).fill(0);
  for (let k = a; k <= b; k++) {
    const hl2 = (bars[k].high + bars[k].low) / 2;
    let bi = Math.floor((hl2 - pMin) / binSize);
    if (bi < 0) bi = 0; if (bi >= NB) bi = NB - 1;
    bins[bi] += bars[k].volume;
  }
  const total = bins.reduce((s, v) => s + v, 0);
  let c05 = 0, c10 = 0;
  for (let t = 0; t < NB; t++) {
    const bp = pMin + (t + 0.5) * binSize;
    if (bp >= price * 0.995 && bp <= price * 1.005) c05 += bins[t];
    if (bp >= price * 0.99 && bp <= price * 1.01) c10 += bins[t];
  }
  return { share05: c05 / total, share10: c10 / total };
}

// 前向 S/R 检验：拐点后 FW 根内是否回踩到该水平，回踩后是守住还是跌破
function forwardTest(idx, price, type) {
  const end = Math.min(n - 1, idx + FW);
  let retested = false, broke = false;
  for (let k = idx + 1; k <= end; k++) {
    const near = bars[k].low <= price * 1.005 && bars[k].high >= price * 0.995;
    if (near) {
      retested = true;
      if (type === 'L') { if (bars[k].low < price) broke = true; }   // 支撑被跌破
      else { if (bars[k].high > price) broke = true; }               // 阻力被突破
    }
  }
  return { retested, broke };
}

const rows = sw.map((s) => {
  const vp = vpAt(s.i, s.price) || { share05: 0, share10: 0 };
  const ft = forwardTest(s.i, s.price, s.type);
  return {
    type: s.type,
    price: s.price,
    ts: new Date(bars[s.i].time).toISOString(),
    share05: vp.share05, share10: vp.share10,
    retested: ft.retested, broke: ft.broke,
  };
});

// 按 share10 分位把同类型拐点分强/弱（上 30% = 强量水平，下 30% = 薄弱水平）
function tagStrength(arr) {
  const vals = arr.map((r) => r.share10).sort((x, y) => x - y);
  const q = (p) => vals[Math.floor(p * (vals.length - 1))];
  const lo = q(0.3), hi = q(0.7);
  for (const r of arr) r.strength = r.share10 >= hi ? 'strong' : (r.share10 <= lo ? 'weak' : 'mid');
}
tagStrength(rows.filter((r) => r.type === 'H'));
tagStrength(rows.filter((r) => r.type === 'L'));

function summarize(arr, label) {
  if (!arr.length) { console.log(`\n[${label}] 无样本`); return; }
  const avg = (k) => arr.reduce((a, r) => a + (r[k] ?? 0), 0) / arr.length;
  console.log(`\n[${label}] n=${arr.length}`);
  console.log(`  ±0.5% 筹码占比 均值=${(avg('share05') * 100).toFixed(1)}%   ±1% 均值=${(avg('share10') * 100).toFixed(1)}%`);
  for (const st of ['strong', 'mid', 'weak']) {
    const sub = arr.filter((r) => r.strength === st);
    const ret = sub.filter((r) => r.retested);
    const hold = ret.filter((r) => !r.broke).length;
    const holdRate = ret.length ? (hold / ret.length * 100).toFixed(0) : '—';
    console.log(`  ${st.padEnd(6)} 量水平: n=${sub.length}  回踩被检验=${ret.length}  守住率=${holdRate}%`);
  }
}
summarize(rows.filter((r) => r.type === 'L'), '摆动低点（支撑侧）');
summarize(rows.filter((r) => r.type === 'H'), '摆动高点（阻力侧）');

const outPath = fileURLToPath(new URL('./trend_vp_record.json', import.meta.url));
writeFileSync(outPath, JSON.stringify(rows, null, 2));
console.log(`\n已记录 ${rows.length} 个摆动点的 VP 强度 + 前向 S/R 检验 → ${outPath}`);
process.exit(0);
