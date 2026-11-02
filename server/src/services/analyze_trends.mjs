// 趋势行情特征分析：从 MACD 锚定的摆动点出发，识别"趋势行情"（连续 HH+HL 的上涨段 / LH+LL 的下跌段），
// 抽取每段的共同特征（起点 RSI、MACD 零轴位置、量能比、EMA 斜率、ATR%、回撤深度、时长、幅度），用于归纳趋势共性。
// 额外把每段趋势的「高低点」(起点摆动点 / 终点摆动点) 与关键特征写入 trend_moves_record.json，方便后续人工提取共性、定制策略。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { midPoints } from './backtestService.js';

const url = 'http://127.0.0.1:8787/api/klines?symbol=BTCUSDT&market=perp&interval=1h&limit=5000';
const j = await (await fetch(url)).json();
const bars = (j.bars || j.bars1h || []).map((b) => ({
  time: b.time, high: b.high, low: b.low, close: b.close, volume: b.volume || 0,
}));
const n = bars.length;
console.log(`bars=${n}  range ${new Date(bars[0].time)} → ${new Date(bars[n-1].time)}`);

// ---- 辅助序列 ----
const emaOf = (vals, p) => {
  const out = new Array(n).fill(null); let ema = null, sum = 0, c = 0;
  for (let i = 0; i < n; i++) { const v = vals[i]; if (!Number.isFinite(v)) continue;
    if (c < p - 1) { sum += v; c++; } else if (c === p - 1) { sum += v; ema = sum / p; out[i] = ema; c++; }
    else { ema = (2 * v + (p - 1) * ema) / (p + 1); out[i] = ema; c++; } }
  return out;
};
const closes = bars.map((b) => b.close);
const ema21 = emaOf(closes, 21);
const macd = (() => { const f = emaOf(closes, 12), s = emaOf(closes, 26), m = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (f[i] != null && s[i] != null) m[i] = f[i] - s[i]; return m; })();
const signal = emaOf(macd, 9);
// RSI(14) Wilder
const rsi = (() => { const out = new Array(n).fill(null); let g = 0, l = 0;
  for (let i = 1; i <= 14; i++) { const d = closes[i] - closes[i-1]; if (d >= 0) g += d; else l -= d; }
  let ag = g/14, al = l/14; out[14] = al === 0 ? 100 : 100 - 100/(1+ag/al);
  for (let i = 15; i < n; i++) { const d = closes[i]-closes[i-1]; const gg = d>=0?d:0, ll = d<0?-d:0;
    ag = (ag*13+gg)/14; al = (al*13+ll)/14; out[i] = al===0?100:100-100/(1+ag/al); } return out; })();
// ATR(14)
const atr = (() => { const tr = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { const pc = i ? closes[i-1] : closes[i];
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)); }
  return emaOf(tr, 14); })();
// 量能 20 均线比
const volSma = emaOf(bars.map((b) => b.volume), 20);

// ---- 摆动序列（已强制 H-L 交替） ----
const mp = midPoints(bars, 12, 26, 9);
const seq = [];
for (let i = 0; i < n; i++) {
  if (mp.highs[i] != null) seq.push({ i, type: 'H', price: mp.highs[i] });
  else if (mp.lows[i] != null) seq.push({ i, type: 'L', price: mp.lows[i] });
}
console.log(`摆动点合计=${seq.length}（高${seq.filter(s=>s.type==='H').length}/低${seq.filter(s=>s.type==='L').length}）`);

// ---- 识别趋势行情 ----
// 上涨段：相邻 Low→High 满足 HH（更高高）且 HL（更高低）；下跌段：High→Low 满足 LH 且 LL。
function detectMoves(seq) {
  // 用"结构破坏"判定趋势行情：
  //   上涨行情 = 一连串摆动，只要低点持续抬高（HL）就延续；直到出现更低低（LL）才结束。
  //   下跌行情 = 高点持续降低（LH）就延续；直到出现更高高（HH）才结束。
  //   （中途的更低高/更高低只是回调，不破坏趋势）
  const out = [];
  let cur = null;
  let lastHigh = null, lastLow = null;
  for (const s of seq) {
    if (s.type === 'H') {
      if (cur && cur.dir === 'up') {
        if (lastHigh && s.price > lastHigh.price) { cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true; }
        // 更低高：上涨途中回调，忽略，趋势不破
      } else if (cur && cur.dir === 'down') {
        if (lastHigh && s.price < lastHigh.price) { cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true; }
        else { out.push(cur); cur = null; } // 更高高 → 下跌结束
      }
      if (!cur && lastHigh && lastLow && s.price < lastHigh.price) {
        // 出现更低高且之前低点更低 → 启动下跌行情（起点取上一个高点）
        cur = { dir: 'down', startIdx: lastHigh.i, startPrice: lastHigh.price, endIdx: s.i, endPrice: s.price, legs: 1, ext: false };
      }
      lastHigh = s;
    } else {
      if (cur && cur.dir === 'up') {
        if (lastLow && s.price > lastLow.price) { cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true; }
        else { out.push(cur); cur = null; } // 更低低 → 上涨结束
      } else if (cur && cur.dir === 'down') {
        if (lastLow && s.price < lastLow.price) { cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true; }
        // 更高低：下跌途中反弹，忽略
      }
      if (!cur && lastHigh && lastLow && s.price > lastLow.price) {
        // 出现更高低且之前高点更高 → 启动上涨行情（起点取上一个低点）
        cur = { dir: 'up', startIdx: lastLow.i, startPrice: lastLow.price, endIdx: s.i, endPrice: s.price, legs: 1, ext: false };
      }
      lastLow = s;
    }
  }
  if (cur) out.push(cur);
  // 只保留"真正展开"的行情：至少延伸过一次（有更高高/更低低），且幅度 > 1%
  return out.filter((m) => m.ext && Math.abs(m.endPrice - m.startPrice) / m.startPrice > 0.01);
}
const trendMoves = detectMoves(seq);
console.log(`趋势行情段数=${trendMoves.length}（涨${trendMoves.filter(m=>m.dir==='up').length}/跌${trendMoves.filter(m=>m.dir==='down').length}）`);

// ---- 抽取特征 ----
const feats = trendMoves.map(features);

// ---- 记录每段趋势的高低点 + 特征，写入 JSON 供后续分析 ----
const records = trendMoves.map((m, i) => {
  const s = m.startIdx, e = m.endIdx;
  const sb = bars[s], eb = bars[e];
  return {
    dir: m.dir,
    start: { ts: new Date(sb.time).toISOString(), low: sb.low, high: sb.high, close: sb.close, price: m.startPrice },
    end: { ts: new Date(eb.time).toISOString(), low: eb.low, high: eb.high, close: eb.close, price: m.endPrice },
    legs: m.legs,
    durationBars: e - s,
    ...feats[i],
  };
});
const outPath = fileURLToPath(new URL('./trend_moves_record.json', import.meta.url));
writeFileSync(outPath, JSON.stringify(records, null, 2));
console.log(`已记录 ${records.length} 段趋势的高低点 → ${outPath}`);

function features(m) {
  const s = m.startIdx, e = m.endIdx;
  const dir = m.dir;
  const startPrice = bars[s].close, endPrice = bars[e].close;
  const magnitude = dir === 'up' ? (endPrice - startPrice) / startPrice : (startPrice - endPrice) / startPrice;
  const duration = e - s;
  // 段内最大不利回撤（从运行峰值/谷值算）
  let adverse = 0, peak = bars[s].close, trough = bars[s].close;
  for (let i = s; i <= e; i++) {
    if (dir === 'up') { peak = Math.max(peak, bars[i].high); adverse = Math.max(adverse, (peak - bars[i].low) / peak); }
    else { trough = Math.min(trough, bars[i].low); adverse = Math.max(adverse, (bars[i].high - trough) / trough); }
  }
  return {
    dir, duration, magnitude: magnitude * 100,
    rsiStart: rsi[s], macdAbove0: (macd[s] != null && macd[s] > 0),
    volRatio: volSma[s] ? bars[s].volume / volSma[s] : null,
    atrPct: atr[s] != null ? atr[s] / bars[s].close * 100 : null,
    emaSlope: (ema21[s] != null && ema21[s-5] != null) ? (ema21[s]-ema21[s-5])/ema21[s-5]*100/5 : null,
    adversePct: adverse * 100,
    legs: m.legs,
  };
}
function summarize(rows, label) {
  if (!rows.length) { console.log(`\n[${label}] 无样本`); return; }
  const avg = (f, k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0) / rows.length;
  const pct = (f, k) => rows.filter((r) => r[k]).length / rows.length * 100;
  console.log(`\n[${label}] n=${rows.length}`);
  console.log(`  平均时长=${avg(null,'duration').toFixed(0)} 根  平均幅度=${avg(null,'magnitude').toFixed(2)}%  平均腿数=${avg(null,'legs').toFixed(1)}`);
  console.log(`  起点 RSI 均值=${avg(null,'rsiStart').toFixed(1)}  起点 ATR%=${avg(null,'atrPct').toFixed(2)}  起点 EMA21斜率%/根=${avg(null,'emaSlope').toFixed(3)}`);
  console.log(`  段内最大回撤均值=${avg(null,'adversePct').toFixed(2)}%`);
  console.log(`  起点 MACD>0 占比=${pct(null,'macdAbove0').toFixed(0)}%  起点量能比均值=${(rows.reduce((a,r)=>a+(r.volRatio??0),0)/rows.length).toFixed(2)}`);
}
summarize(feats.filter((f) => f.dir === 'up'), '上涨趋势');
summarize(feats.filter((f) => f.dir === 'down'), '下跌趋势');
process.exit(0);
