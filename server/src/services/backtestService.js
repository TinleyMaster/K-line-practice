import { queryRows, queryOne } from '../db.js';
import { PRAC } from '../config.js';

function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { sum += closes[i]; }
    else if (i === period - 1) { sum += closes[i]; out[i] = sum / period; }
    else { out[i] = (2 * closes[i] + (period - 1) * out[i - 1]) / (period + 1); }
  }
  return out;
}

function isTrendK(bar, minBody, maxShadow) {
  const range = bar.high - bar.low;
  if (range <= 0) return { bull: false, bear: false };
  const body = Math.abs(bar.close - bar.open);
  const bodyPct = (body / range) * 100;
  const shadowPct = ((range - body) / range) * 100;
  const bull = bar.close > bar.open && bodyPct >= minBody && shadowPct <= maxShadow;
  const bear = bar.close < bar.open && bodyPct >= minBody && shadowPct <= maxShadow;
  return { bull, bear };
}

// 摆动高低点：锚定 MACD 结构 —— 零轴上方死叉前一段的极高=高点，零轴下方金叉前一段的极低=低点。
// 与 web/src/engine/trendIndicator.ts 的 TRENDSTRUCT 计算保持一致，确保"图上看到的 = 回测用的"。
export function midPoints(bars, mFast = 12, mSlow = 26, mSig = 9) {
  const n = bars.length;
  const emaOf = (vals, period) => {
    const out = new Array(n).fill(null);
    let ema = null;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (v == null || !Number.isFinite(v)) continue;
      if (count < period - 1) { sum += v; count++; }
      else if (count === period - 1) { sum += v; ema = sum / period; out[i] = ema; count++; }
      else { ema = (2 * v + (period - 1) * ema) / (period + 1); out[i] = ema; count++; }
    }
    return out;
  };
  const closes = bars.map((b) => b.close);
  const emaMF = emaOf(closes, mFast);
  const emaMS = emaOf(closes, mSlow);
  const macd = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (emaMF[i] != null && emaMS[i] != null) macd[i] = emaMF[i] - emaMS[i];
  }
  const signal = emaOf(macd, mSig);
  const highs = new Array(n).fill(null);
  const lows = new Array(n).fill(null);
  let prevCross = -1;
  for (let i = 1; i < n; i++) {
    const m0 = macd[i - 1], m1 = macd[i], s0 = signal[i - 1], s1 = signal[i];
    if (m0 == null || m1 == null || s0 == null || s1 == null) continue; // warmup
    const golden = m0 <= s0 && m1 > s1; // 金叉
    const death = m0 >= s0 && m1 < s1; // 死叉
    if (golden || death) {
      const start = Math.max(0, prevCross + 1);
      if (death && m1 > 0) {
        // 零轴上方死叉：前一段（上一交叉 → 本死叉）的极高记为高点
        let best = start;
        let bestH = -Infinity;
        for (let j = start; j <= i; j++) {
          if (bars[j].high > bestH) { bestH = bars[j].high; best = j; }
        }
        highs[best] = bars[best].high;
      }
      if (golden && m1 < 0) {
        // 零轴下方金叉：前一段的极低记为低点
        let best = start;
        let bestL = Infinity;
        for (let j = start; j <= i; j++) {
          if (bars[j].low < bestL) { bestL = bars[j].low; best = j; }
        }
        lows[best] = bars[best].low;
      }
      prevCross = i;
    }
  }
  // 合并连续同类型点：保证高/低严格交替（连续低点/高点只保留最极端的那个）
  return enforceAlternation(highs, lows);
}

// 合并连续同类型摆动点：保证高/低严格交替。连续两个低点只保留更低的，高点同理。
function enforceAlternation(highsIn, lowsIn) {
  const n = highsIn.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    if (highsIn[i] != null) pts.push({ i, type: 'H', v: highsIn[i] });
    else if (lowsIn[i] != null) pts.push({ i, type: 'L', v: lowsIn[i] });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k + 1 < pts.length; k++) {
      if (pts[k].type === pts[k + 1].type) {
        const a = pts[k];
        const b = pts[k + 1];
        const keep = a.type === 'H' ? (a.v >= b.v ? a : b) : (a.v <= b.v ? a : b);
        pts.splice(k, 2, keep);
        changed = true;
        break;
      }
    }
  }
  const highs = new Array(n).fill(null);
  const lows = new Array(n).fill(null);
  for (const p of pts) {
    if (p.type === 'H') highs[p.i] = p.v;
    else lows[p.i] = p.v;
  }
  return { highs, lows };
}

function atrSeries(bars, period) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return out;
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    trSum += tr;
  }
  out[period] = trSum / period;
  for (let i = period + 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    out[i] = (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

function derive4h(bars1h) {
  const buckets = new Map();
  for (const b of bars1h) {
    const bucket = Math.floor(b.time / (4 * 3600 * 1000)) * (4 * 3600 * 1000);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(b);
  }
  const out = [];
  for (const [t, members] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (members.length === 0) continue;
    out.push({
      time: t,
      open: members[0].open,
      high: Math.max(...members.map((m) => m.high)),
      low: Math.min(...members.map((m) => m.low)),
      close: members[members.length - 1].close,
    });
  }
  return out;
}

function emaSlope(emaArr, i, slopeBars) {
  if (i < slopeBars || slopeBars < 2) return 0;
  let up = true, down = true;
  for (let j = i - slopeBars + 1; j <= i; j++) {
    if (emaArr[j] == null || emaArr[j - 1] == null) { up = false; down = false; break; }
    if (!(emaArr[j] > emaArr[j - 1])) up = false;
    if (!(emaArr[j] < emaArr[j - 1])) down = false;
  }
  if (up) return 1;
  if (down) return -1;
  return 0;
}

// RSI (Wilder)。返回与数据等长的数组，前 period 根为 null。
function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// 简单移动平均（用于成交量基线）。
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

export async function loadBars(symbol, market, limit, offset, since, until) {
  const sym = String(symbol).toUpperCase();
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 100000));
  const off = Math.max(0, Number(offset) || 0);
  let where = "market = $1 AND symbol = $2 AND interval = '1h'";
  const params = [market, sym];
  if (since) { params.push(new Date(since).toISOString()); where += ' AND open_time >= $' + params.length; }
  if (until) { params.push(new Date(until).toISOString()); where += ' AND open_time <= $' + params.length; }

  // 默认取最新 N 根
  let finalOffset = off;
  if (off === 0 && !since && !until) {
    const cnt = await queryOne('SELECT count(*)::int AS c FROM ' + PRAC.schema + '.klines WHERE ' + where, params);
    finalOffset = Math.max(0, (cnt?.c ?? 0) - lim);
  }

  const rows = await queryRows(
    'SELECT open_time, open_px, high_px, low_px, close_px, base_vol FROM ' + PRAC.schema + '.klines WHERE ' + where + ' ORDER BY open_time ASC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2),
    [...params, lim, finalOffset],
  );
  return rows.map((r) => ({
    time: new Date(r.open_time).getTime(),
    open: Number(r.open_px),
    high: Number(r.high_px),
    low: Number(r.low_px),
    close: Number(r.close_px),
    volume: Number(r.base_vol) || 0,
  }));
}

// 计算一段 K 线的完整成交量分布剖面（"筹码位置地图"）：POC / 价值区 VA(vaPct) / HVN(高量节点) / LVN(低量真空带)。
// 量按每根 K 线的 [low,high] 区间平摊到分箱，得到更真实的剖面形状（HVN=客观 S/R，LVN=加速真空带）。
export function vpProfile(bars, from, to, NB = 80, vaPct = 0.7) {
  if (to - from < 20) return null;
  let pMin = Infinity, pMax = -Infinity;
  for (let k = from; k <= to; k++) { pMin = Math.min(pMin, bars[k].low); pMax = Math.max(pMax, bars[k].high); }
  if (!(pMax > pMin)) return null;
  const binSize = (pMax - pMin) / NB;
  const bins = new Array(NB).fill(0);
  for (let k = from; k <= to; k++) {
    const lo = bars[k].low, hi = bars[k].high, v = bars[k].volume || 0;
    let b0 = Math.floor((lo - pMin) / binSize), b1 = Math.floor((hi - pMin) / binSize);
    if (b0 < 0) b0 = 0; if (b1 >= NB) b1 = NB - 1; if (b1 < b0) b1 = b0;
    const cnt = b1 - b0 + 1;
    for (let t = b0; t <= b1; t++) bins[t] += v / cnt;
  }
  const total = bins.reduce((s, x) => s + x, 0);
  if (total <= 0) return null;
  let pocI = 0;
  for (let t = 1; t < NB; t++) if (bins[t] > bins[pocI]) pocI = t;
  const pocPrice = pMin + (pocI + 0.5) * binSize;
  const order = [...Array(NB).keys()].sort((x, y) => bins[y] - bins[x]);
  const set = new Set([pocI]); let cum = bins[pocI];
  for (const t of order) { if (t === pocI) continue; if (cum / total >= vaPct) break; set.add(t); cum += bins[t]; }
  let loT = pocI, hiT = pocI;
  for (const t of set) { loT = Math.min(loT, t); hiT = Math.max(hiT, t); }
  const vaLow = pMin + loT * binSize, vaHigh = pMin + (hiT + 1) * binSize;
  const avg = total / NB;
  const hvn = [];
  for (let t = 1; t < NB - 1; t++) if (bins[t] >= 1.5 * avg && bins[t] >= bins[t - 1] && bins[t] >= bins[t + 1]) hvn.push(pMin + (t + 0.5) * binSize);
  const lvn = [];
  for (let t = 0; t < NB; t++) if (bins[t] <= 0.4 * avg) lvn.push(pMin + (t + 0.5) * binSize);
  return { pocPrice, vaLow, vaHigh, hvn, lvn };
}

export function runBacktestOnBars(bars, params) {
  const {
    minBody = 10,
    maxShadow = 30,
    minConsec = 2,
    emaFast = 21,
    emaMid = 55,
    emaSlow = 144,
    stopMode = 'defense',
    stopPct = 2,
    tpR = 2,
    tpMode = 'rMultiple',
    timeStop = null,
    side = 'both',
    signalMode = 'loose',
    feeRate = 0.0004,
    slippageBps = 0,
    atrPeriod = 14,
    atrMult = 2,
    minStopPct = 0.5,
    maxStopPct = 8,
    emaSlopeBars = 3,
    cooldownBars = 3,
    use4hFilter = true,
    feeEnabled = true,
    riskPct = 1,
    trailR = 1,
    swingWin = 3,
    rsiPeriod = 14,
    rsiLongLo = 45,
    rsiLongHi = 75,
    rsiShortLo = 25,
    rsiShortHi = 55,
    volPeriod = 20,
    volMult = 1.5,
    trendEntry = 'close', // 'close' = 信号确认根收盘入场; 'swing' = 趋势起点摆动点本身(那根 low/high)入场，吃满整段
    vpWindow = 150,   // VP 剖面回看窗口（根）
    vaPct = 0.7,     // 价值区占比
    vpNB = 80,       // VP 价格分箱数
    vpStopBuf = 0.3, // 止损相对近端 HVN 的缓冲(%)
  } = params || {};

  if (bars.length < 100) throw new Error('数据不足');

  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume || 0);
  const eFast = emaSeries(closes, emaFast);
  const eMid = emaSeries(closes, emaMid);
  const eSlow = emaSeries(closes, emaSlow);
  const trendFlags = bars.map((b) => isTrendK(b, minBody, maxShadow));
  const mp = midPoints(bars, 12, 26, 9);
  const atr = atrSeries(bars, atrPeriod);
  const rsi = rsiSeries(closes, Math.max(2, rsiPeriod));
  const volSma = smaSeries(volumes, Math.max(2, volPeriod));

  // 市场结构趋势：比较最近两个摆动高低点。
  // structUp/Down 要求「更高高+更高低」(或反之)，较严；structHLup/dn 只要求核心结构特征（更高低 / 更低高），更宽松，
  // 用于结构模式：避免把趋势中正常的「更高高未创新高」也排除掉。
  const structUp = new Array(bars.length).fill(false);
  const structDown = new Array(bars.length).fill(false);
  const structHLup = new Array(bars.length).fill(false);   // 上升结构：更高的低
  const structHLdn = new Array(bars.length).fill(false);  // 下降结构：更低的高
  {
    let prevL = null, lastL = null, prevH = null, lastH = null;
    for (let i = 0; i < bars.length; i++) {
      if (mp.lows[i] != null) { prevL = lastL; lastL = i; }
      if (mp.highs[i] != null) { prevH = lastH; lastH = i; }
      const loOk = prevL != null && lastL != null && mp.lows[prevL] != null && mp.lows[lastL] != null;
      const hiOk = prevH != null && lastH != null && mp.highs[prevH] != null && mp.highs[lastH] != null;
      if (loOk && hiOk) {
        structUp[i] = mp.lows[lastL] > mp.lows[prevL] && mp.highs[lastH] > mp.highs[prevH];
        structDown[i] = mp.lows[lastL] < mp.lows[prevL] && mp.highs[lastH] < mp.highs[prevH];
        structHLup[i] = mp.lows[lastL] > mp.lows[prevL];
        structHLdn[i] = mp.highs[lastH] < mp.highs[prevH];
      }
    }
  }

  const defenseHigh = new Array(bars.length).fill(null);
  const defenseLow = new Array(bars.length).fill(null);
  let lastMH = null, lastML = null;
  for (let i = 0; i < bars.length; i++) {
    if (mp.highs[i] != null) lastMH = mp.highs[i];
    if (mp.lows[i] != null) lastML = mp.lows[i];
    defenseHigh[i] = lastMH;
    defenseLow[i] = lastML;
  }

  let h4Bull = new Array(bars.length).fill(true);
  let h4Bear = new Array(bars.length).fill(true);
  if (use4hFilter) {
    const bars4h = derive4h(bars);
    const c4 = bars4h.map((b) => b.close);
    const e4m = emaSeries(c4, emaMid);
    let idx4 = 0;
    for (let i = 0; i < bars.length; i++) {
      while (idx4 + 1 < bars4h.length && bars4h[idx4 + 1].time <= bars[i].time) idx4++;
      const cIdx = idx4 > 0 ? idx4 - 1 : -1;
      if (cIdx >= 0 && e4m[cIdx] != null) {
        h4Bull[i] = bars4h[cIdx].close > e4m[cIdx];
        h4Bear[i] = bars4h[cIdx].close < e4m[cIdx];
      }
    }
  }

  const trades = [];
  let openTrade = null;
  let consecBull = 0, consecBear = 0;
  let inPullbackLong = false, inPullbackShort = false;
  let pullbackLowLong = null, pullbackHighShort = null;
  let trendActiveLong = false, trendActiveShort = false;
  let lastEntryIdx = -Infinity;
  let prevHLup = false, prevHLdn = false; // 趋势结构信号的「上升沿」检测（仅在摆动点那一根触发）
  let pendingOrder = null; // 趋势起点'swing'模式：信号收盘后挂限价单，未来根回踩到摆动低/高才成交（无前视）

  const equity = [{ time: bars[0].time, equity: 10000 }];
  let equityVal = 10000;

  const slip = slippageBps / 10000;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const tf = trendFlags[i];
    const isTrend = signalMode === 'trend';
    const isVp = signalMode === 'vp';

    if (tf.bull) consecBull++; else consecBull = 0;
    if (tf.bear) consecBear++; else consecBear = 0;

    const emaBull = eFast[i] != null && eMid[i] != null && eSlow[i] != null && eFast[i] > eMid[i] && eMid[i] > eSlow[i];
    const emaBear = eFast[i] != null && eMid[i] != null && eSlow[i] != null && eFast[i] < eMid[i] && eMid[i] < eSlow[i];

    const slopeFast = emaSlope(eFast, i, emaSlopeBars);
    const emaBullSlope = emaBull && (emaSlopeBars < 2 || slopeFast >= 0);
    const emaBearSlope = emaBear && (emaSlopeBars < 2 || slopeFast <= 0);

    // 趋势状态机：EMA 多头排列 + 连续趋势K → 趋势确立；EMA 不再多头（反转/失序）→ 清空状态
    if (emaBull && consecBull >= minConsec && emaBullSlope) {
      trendActiveLong = true;
    }
    if (!emaBull) {
      trendActiveLong = false;
      inPullbackLong = false;
      pullbackLowLong = null;
    }
    if (trendActiveLong && !tf.bull) {
      inPullbackLong = true;
      if (pullbackLowLong == null || bar.low < pullbackLowLong) pullbackLowLong = bar.low;
    }

    if (emaBear && consecBear >= minConsec && emaBearSlope) {
      trendActiveShort = true;
    }
    if (!emaBear) {
      trendActiveShort = false;
      inPullbackShort = false;
      pullbackHighShort = null;
    }
    if (trendActiveShort && !tf.bear) {
      inPullbackShort = true;
      if (pullbackHighShort == null || bar.high > pullbackHighShort) pullbackHighShort = bar.high;
    }

    if (openTrade) {
      const t = openTrade;
      const barsHeld = i - t.entryIdx;
      // 入场风险固定为开仓时的原始风险，跟踪止损与 R 倍数都基于它，避免止损被移动后 R 失真
      const risk = t.entryRisk || 0;

      // 跟踪止损：盈利达到 trailR·R 后，止损随价格极值回撤 trailR·R 跟进（让利润奔跑、锁住盈利）
      if (trailR > 0 && risk > 0) {
        const favMove = t.side === 'long' ? (bar.high - t.entryPrice) : (t.entryPrice - bar.low);
        if (favMove >= trailR * risk) {
          const cand = t.side === 'long' ? bar.high - trailR * risk : bar.low + trailR * risk;
          if (t.side === 'long' ? cand > t.stopLoss : cand < t.stopLoss) t.stopLoss = cand;
        }
      }

      let exitPrice = null, exitReason = null;
      if (t.side === 'long') {
        if (bar.low <= t.stopLoss) { exitPrice = t.stopLoss; exitReason = 'stop'; }
        else if (tpMode === 'rMultiple' && t.takeProfit != null && bar.high >= t.takeProfit) { exitPrice = t.takeProfit; exitReason = 'target'; }
        else if (tpMode === 'trendend' && structHLdn[i]) { exitPrice = bar.close; exitReason = 'trendend'; }
        else if (timeStop != null && barsHeld >= timeStop) { exitPrice = bar.close; exitReason = 'time'; }
      } else {
        if (bar.high >= t.stopLoss) { exitPrice = t.stopLoss; exitReason = 'stop'; }
        else if (tpMode === 'rMultiple' && t.takeProfit != null && bar.low <= t.takeProfit) { exitPrice = t.takeProfit; exitReason = 'target'; }
        else if (tpMode === 'trendend' && structHLup[i]) { exitPrice = bar.close; exitReason = 'trendend'; }
        else if (timeStop != null && barsHeld >= timeStop) { exitPrice = bar.close; exitReason = 'time'; }
      }
      if (exitPrice != null) {
        const riskPerUnit = t.entryRisk || 0;
        const pricePnl = t.side === 'long' ? (exitPrice - t.entryPrice) : (t.entryPrice - exitPrice);
        const costR = (feeEnabled && riskPerUnit > 0) ? ((2 * feeRate + 2 * slip) * t.entryPrice) / riskPerUnit : 0;
        const rMult = riskPerUnit > 0 ? pricePnl / riskPerUnit - costR : 0;
        const equityAtEntry = t.equityAtEntry ?? equityVal;
        const riskAmount = equityAtEntry * (riskPct / 100);
        const qty = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
        const pnlDollar = pricePnl * qty - (feeEnabled && qty > 0 ? (2 * feeRate + 2 * slip) * t.entryPrice * qty : 0);
        t.exitTime = bar.time;
        t.exitPrice = exitPrice;
        t.exitReason = exitReason;
        t.rMultiple = rMult;
        t.pnl = pnlDollar;
        t.exitIdx = i;
        trades.push({ ...t });
        equityVal += pnlDollar;
        equity.push({ time: bar.time, equity: equityVal });
        openTrade = null;
      }
    }

    if (!openTrade && i - lastEntryIdx >= cooldownBars) {
      const wantLong = (side === 'both' || side === 'long') && h4Bull[i];
      const wantShort = (side === 'both' || side === 'short') && h4Bear[i];

      // 重写后的核心：只在「趋势确立后的回调」里入场（不追高、不追低）。
      // 趋势由 EMA 排列 + 连续趋势K 确立；回调 = 趋势中出现非趋势K 的回踩；
      // 当回调中出现趋势K 反转向上、且（strict）未跌破前低结构时，入场做多。
      const isStruct = signalMode === 'structure';
      const effTpR = isStruct ? Math.max(tpR, 3) : tpR;
      const rsiGate = isStruct || isTrend;
      const rsiOkLong = !rsiGate || (rsi[i] != null && rsi[i] >= rsiLongLo && rsi[i] <= rsiLongHi);
      const rsiOkShort = !rsiGate || (rsi[i] != null && rsi[i] >= rsiShortLo && rsi[i] <= rsiShortHi);
      const volGate = isStruct || isTrend;
      const volOk = !volGate || (volSma[i] != null && volSma[i] > 0 && bar.volume > volSma[i] * volMult);

      if (isTrend) {
        // 趋势起点策略：MACD 锚定摆动点出现「更高低」(HL) → 上涨结构确认即入场；下跌反之（更低高 LH）。
        // 配合 RSI 极值 + 量能放大。不在 EMA 多头排列要求——趋势起点本就早于 EMA 确认。
        // trendEntry='close'：信号收盘确认根以收盘即时入场（入场偏晚）。
        // trendEntry='swing'：信号收盘确认后挂「限价单」于摆动低/高，未来根回踩到该价才成交——
        //   这样既吃到底部、又不存在前视（信号在收盘才知，挂单只能在未来成交）。
        const edgeUp = structHLup[i] && !prevHLup;
        const edgeDn = structHLdn[i] && !prevHLdn;
        const longSig = trendEntry === 'swing' ? edgeUp : structHLup[i];
        const shortSig = trendEntry === 'swing' ? edgeDn : structHLdn[i];
        const limitBars = 30;

        const openTradeAt = (side, entryPrice) => {
          let stopLoss;
          if (stopMode === 'pct') stopLoss = side === 'long' ? entryPrice * (1 - stopPct / 100) : entryPrice * (1 + stopPct / 100);
          else if (stopMode === 'defense') stopLoss = side === 'long' ? Math.min(defenseLow[i] ?? bar.low, entryPrice) : Math.max(defenseHigh[i] ?? bar.high, entryPrice);
          else stopLoss = side === 'long' ? entryPrice - (atr[i] ?? entryPrice * 0.02) * atrMult : entryPrice + (atr[i] ?? entryPrice * 0.02) * atrMult;
          const stopDistPct = side === 'long' ? (entryPrice - stopLoss) / entryPrice * 100 : (stopLoss - entryPrice) / entryPrice * 100;
          if ((side === 'long' ? stopLoss < entryPrice : stopLoss > entryPrice) && stopDistPct >= minStopPct && stopDistPct <= maxStopPct) {
            const risk = side === 'long' ? entryPrice - stopLoss : stopLoss - entryPrice;
            const takeProfit = tpMode === 'rMultiple' ? (side === 'long' ? entryPrice + risk * effTpR : entryPrice - risk * effTpR) : null;
            openTrade = { side, entryTime: bar.time, entryPrice, entryIdx: i, stopLoss, takeProfit, tpR: effTpR, entryRisk: risk, equityAtEntry: equityVal };
            lastEntryIdx = i;
            return true;
          }
          return false;
        };

        if (pendingOrder && !openTrade) {
          const po = pendingOrder;
          const filled = po.side === 'long' ? (bar.low <= po.price) : (bar.high >= po.price);
          if (filled) {
            openTradeAt(po.side, po.price);
            pendingOrder = null;
          } else if (i - po.entryIdx > limitBars) {
            pendingOrder = null; // 限价单超时未成交，撤单
          }
        } else if (!openTrade && !pendingOrder) {
          if (wantLong && longSig && rsiOkLong && volOk) {
            if (trendEntry === 'swing') {
              const price = Math.min(bar.low, mp.lows[i] != null ? mp.lows[i] : bar.low);
              pendingOrder = { side: 'long', price, entryIdx: i };
            } else {
              openTradeAt('long', bar.close);
            }
          } else if (wantShort && shortSig && rsiOkShort && volOk) {
            if (trendEntry === 'swing') {
              const price = Math.max(bar.high, mp.highs[i] != null ? mp.highs[i] : bar.high);
              pendingOrder = { side: 'short', price, entryIdx: i };
            } else {
              openTradeAt('short', bar.close);
            }
          }
        }
      } else if (isVp) {
        // VP 突破顺势：价格从 VA 外放量突破 VA 上沿(多)/下沿(空)，且 POC 同步偏移确认资金重心 → 顺势入场；
        // 止损放近端 HVN 之外（跌破 HVN=筹码被击穿，该跑）；止盈看对侧最近 HVN（LVN 口/下一阻力）。
        const a = Math.max(0, i - vpWindow);
        const prof = vpProfile(bars, a, i - 1, vpNB, vaPct); // 用已闭合的历史窗口，无前视
        if (prof) {
          const mid = (prof.vaLow + prof.vaHigh) / 2;
          const breakUp = bar.close > prof.vaHigh;
          const breakDn = bar.close < prof.vaLow;
          const pocBull = prof.pocPrice >= mid;  // POC 在 VA 上半 = 资金重心偏上
          const pocBear = prof.pocPrice <= mid;  // POC 在 VA 下半 = 资金重心偏下
          const vOk = volSma[i - 1] != null && volSma[i - 1] > 0 && bar.volume > volSma[i - 1] * volMult;
          const openVp = (side, entryPrice) => {
            let lvl, stop;
            if (side === 'long') {
              const hvnBelow = prof.hvn.filter((x) => x < entryPrice).sort((p, q) => q - p);
              lvl = hvnBelow.length ? hvnBelow[0] : prof.vaLow;
              stop = lvl * (1 - vpStopBuf / 100);
            } else {
              const hvnAbove = prof.hvn.filter((x) => x > entryPrice).sort((p, q) => p - q);
              lvl = hvnAbove.length ? hvnAbove[0] : prof.vaHigh;
              stop = lvl * (1 + vpStopBuf / 100);
            }
            const stopDistPct = side === 'long' ? (entryPrice - stop) / entryPrice * 100 : (stop - entryPrice) / entryPrice * 100;
            if ((side === 'long' ? stop < entryPrice : stop > entryPrice) && stopDistPct >= minStopPct && stopDistPct <= maxStopPct) {
              const risk = side === 'long' ? entryPrice - stop : stop - entryPrice;
              let tp;
              if (side === 'long') {
                const hvnAbove = prof.hvn.filter((x) => x > entryPrice).sort((p, q) => p - q);
                tp = hvnAbove.length ? hvnAbove[0] : entryPrice + risk * effTpR;
              } else {
                const hvnBelow = prof.hvn.filter((x) => x < entryPrice).sort((p, q) => q - p);
                tp = hvnBelow.length ? hvnBelow[0] : entryPrice - risk * effTpR;
              }
              const takeProfit = tpMode === 'rMultiple' ? tp : null;
              openTrade = { side, entryTime: bar.time, entryPrice, entryIdx: i, stopLoss: stop, takeProfit, tpR: effTpR, entryRisk: risk, equityAtEntry: equityVal };
              lastEntryIdx = i;
              return true;
            }
            return false;
          };
          if (wantLong && breakUp && pocBull && vOk) openVp('long', bar.close);
          else if (wantShort && breakDn && pocBear && vOk) openVp('short', bar.close);
        }
      } else {
        if (wantLong && emaBull && trendActiveLong && inPullbackLong && tf.bull && rsiOkLong && volOk) {
          const structOk = signalMode !== 'strict' || (defenseLow[i] != null && pullbackLowLong != null && pullbackLowLong >= defenseLow[i] * 0.999);
          const structTrendOk = !isStruct || structHLup[i];
          if (structOk && structTrendOk) {
            let stopLoss;
            if (stopMode === 'defense') stopLoss = Math.min(defenseLow[i] ?? bar.low, bar.low);
            else if (stopMode === 'atr') stopLoss = bar.close - (atr[i] ?? bar.close * 0.02) * atrMult;
            else stopLoss = bar.close * (1 - stopPct / 100);
            const stopDistPct = stopLoss < bar.close ? (bar.close - stopLoss) / bar.close * 100 : 999;
            if (stopLoss < bar.close && stopDistPct >= minStopPct && stopDistPct <= maxStopPct) {
              const risk = bar.close - stopLoss;
              const takeProfit = tpMode === 'rMultiple' ? bar.close + risk * effTpR : null;
              openTrade = {
                side: 'long', entryTime: bar.time, entryPrice: bar.close, entryIdx: i,
                stopLoss, takeProfit, tpR: effTpR, entryRisk: risk, equityAtEntry: equityVal,
              };
              lastEntryIdx = i;
              inPullbackLong = false;
              pullbackLowLong = null;
            }
          }
        } else if (wantShort && emaBear && trendActiveShort && inPullbackShort && tf.bear && rsiOkShort && volOk) {
          const structOk = signalMode !== 'strict' || (defenseHigh[i] != null && pullbackHighShort != null && pullbackHighShort <= defenseHigh[i] * 1.001);
          const structTrendOk = !isStruct || structHLdn[i];
          if (structOk && structTrendOk) {
            let stopLoss;
            if (stopMode === 'defense') stopLoss = Math.max(defenseHigh[i] ?? bar.high, bar.high);
            else if (stopMode === 'atr') stopLoss = bar.close + (atr[i] ?? bar.close * 0.02) * atrMult;
            else stopLoss = bar.close * (1 + stopPct / 100);
            const stopDistPct = stopLoss > bar.close ? (stopLoss - bar.close) / bar.close * 100 : 999;
            if (stopLoss > bar.close && stopDistPct >= minStopPct && stopDistPct <= maxStopPct) {
              const risk = stopLoss - bar.close;
              const takeProfit = tpMode === 'rMultiple' ? bar.close - risk * effTpR : null;
              openTrade = {
                side: 'short', entryTime: bar.time, entryPrice: bar.close, entryIdx: i,
                stopLoss, takeProfit, tpR: effTpR, entryRisk: risk, equityAtEntry: equityVal,
              };
              lastEntryIdx = i;
              inPullbackShort = false;
              pullbackHighShort = null;
            }
          }
        }

        // 回调结构破位（跌破前低 / 涨破前高）→ 取消本次回调，避免逆结构入场
        if (inPullbackLong && defenseLow[i] != null && pullbackLowLong != null && pullbackLowLong < defenseLow[i]) {
          inPullbackLong = false; pullbackLowLong = null; trendActiveLong = false;
        }
        if (inPullbackShort && defenseHigh[i] != null && pullbackHighShort != null && pullbackHighShort > defenseHigh[i]) {
          inPullbackShort = false; pullbackHighShort = null; trendActiveShort = false;
        }
      }

      // 更新趋势结构信号的「上升沿」状态（必须在每根结束时记录）
      prevHLup = structHLup[i];
      prevHLdn = structHLdn[i];
    }
  }

  const closed = trades.filter((t) => t.exitPrice != null);
  const wins = closed.filter((t) => t.rMultiple > 0);
  const totalR = closed.reduce((s, t) => s + (t.rMultiple || 0), 0);
  const avgR = closed.length ? totalR / closed.length : 0;
  const winRate = closed.length ? wins.length / closed.length : 0;
  let peak = equity[0]?.equity ?? 10000;
  let maxDD = 0;
  for (const e of equity) {
    if (e.equity > peak) peak = e.equity;
    const dd = (peak - e.equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const grossWin = closed.filter((t) => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
  const grossLoss = Math.abs(closed.filter((t) => t.rMultiple <= 0).reduce((s, t) => s + t.rMultiple, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  return {
    params: { minBody, maxShadow, swingWin, minConsec, emaFast, emaMid, emaSlow, stopMode, stopPct, tpR, tpMode, timeStop, side, signalMode, feeRate, slippageBps, atrMult, minStopPct, maxStopPct, emaSlopeBars, cooldownBars, use4hFilter, riskPct, rsiPeriod, rsiLongLo, rsiLongHi, rsiShortLo, rsiShortHi, volPeriod, volMult },
    bars: bars.length,
    trades: closed.map((t) => ({
      side: t.side,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      stopLoss: t.stopLoss,
      takeProfit: t.takeProfit,
      rMultiple: t.rMultiple,
      exitReason: t.exitReason,
    })),
    equity,
    stats: {
      trades: closed.length,
      wins: wins.length,
      winRate,
      totalR,
      avgR,
      maxDrawdown: maxDD,
      profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
    },
  };
}

export async function runBacktest(params) {
  const { symbol, market = 'perp', limit = 20000, offset, since, until, splitRatio = null, ...rest } = params || {};
  const bars = await loadBars(symbol, market, limit, offset, since, until);
  if (splitRatio && splitRatio > 0 && splitRatio < 1) {
    const splitIdx = Math.floor(bars.length * splitRatio);
    const trainBars = bars.slice(0, splitIdx);
    const testBars = bars.slice(splitIdx);
    const train = runBacktestOnBars(trainBars, rest);
    const test = runBacktestOnBars(testBars, rest);
    const useTest = (test.stats.trades ?? 0) > 0;
    const primary = useTest ? test : train;
    return {
      ...primary,
      stats: primary.stats,
      trainStats: train.stats,
      testStats: test.stats,
      trainTrades: train.trades,
      testTrades: test.trades,
      trainEquity: train.equity,
      testEquity: test.equity,
      splitIdx,
      bars: bars.length,
    };
  }
  return runBacktestOnBars(bars, rest);
}

export async function validateIndicator(params) {
  const {
    symbol, market = 'perp', limit = 5000, since, until,
    minBody = 10, maxShadow = 30, emaFast = 21, emaMid = 55, emaSlow = 144,
    forwardBars = 5, side = 'both',
  } = params || {};
  const bars = await loadBars(symbol, market, limit, 0, since, until);
  if (bars.length < 50) throw new Error('数据不足');

  const closes = bars.map((b) => b.close);
  const eFast = emaSeries(closes, emaFast);
  const eMid = emaSeries(closes, emaMid);
  const eSlow = emaSeries(closes, emaSlow);
  const trendFlags = bars.map((b) => isTrendK(b, minBody, maxShadow));

  let longSignals = 0, shortSignals = 0;
  let longWins = 0, shortWins = 0;
  let longMoveSum = 0, shortMoveSum = 0;
  const signals = [];

  for (let i = 0; i < bars.length - forwardBars; i++) {
    const emaBull = eFast[i] != null && eMid[i] != null && eSlow[i] != null && eFast[i] > eMid[i] && eMid[i] > eSlow[i];
    const emaBear = eFast[i] != null && eMid[i] != null && eSlow[i] != null && eFast[i] < eMid[i] && eMid[i] < eSlow[i];
    const tf = trendFlags[i];
    const futureClose = bars[i + forwardBars].close;
    const movePct = (futureClose - bars[i].close) / bars[i].close * 100;

    if (side !== 'short' && emaBull && tf.bull) {
      longSignals++;
      if (movePct > 0) longWins++;
      longMoveSum += movePct;
      signals.push({ time: bars[i].time, side: 'long', movePct });
    }
    if (side !== 'long' && emaBear && tf.bear) {
      shortSignals++;
      if (movePct < 0) shortWins++;
      shortMoveSum += -movePct;
      signals.push({ time: bars[i].time, side: 'short', movePct });
    }
  }

  const totalSignals = longSignals + shortSignals;
  const totalWins = longWins + shortWins;
  return {
    bars: bars.length,
    forwardBars,
    longSignals,
    shortSignals,
    totalSignals,
    signalDensity: (totalSignals / bars.length * 100).toFixed(2) + '%',
    longWinRate: longSignals ? (longWins / longSignals * 100).toFixed(1) + '%' : 'n/a',
    shortWinRate: shortSignals ? (shortWins / shortSignals * 100).toFixed(1) + '%' : 'n/a',
    overallWinRate: totalSignals ? (totalWins / totalSignals * 100).toFixed(1) + '%' : 'n/a',
    longAvgMove: longSignals ? (longMoveSum / longSignals).toFixed(3) + '%' : 'n/a',
    shortAvgMove: shortSignals ? (shortMoveSum / shortSignals).toFixed(3) + '%' : 'n/a',
    signals: signals.slice(0, 100),
  };
}

export async function runOptimization(baseParams, grid) {
  const { symbol, market = 'perp', limit = 20000, since, until, splitRatio = null } = baseParams || {};
  const bars = await loadBars(symbol, market, limit, 0, since, until);
  const trainBars = splitRatio ? bars.slice(0, Math.floor(bars.length * splitRatio)) : bars;
  const testBars = splitRatio ? bars.slice(Math.floor(bars.length * splitRatio)) : null;

  const keys = Object.keys(grid);
  const combos = [{}];
  for (const k of keys) {
    const next = [];
    for (const c of combos) {
      for (const v of grid[k]) next.push({ ...c, [k]: v });
    }
    combos.splice(0, combos.length, ...next);
  }
  const MAX = 200;
  const runCombos = combos.slice(0, MAX);
  const results = [];
  for (const combo of runCombos) {
    try {
      const train = runBacktestOnBars(trainBars, { ...baseParams, ...combo });
      let testStats = null;
      if (testBars) {
        const test = runBacktestOnBars(testBars, { ...baseParams, ...combo });
        testStats = test.stats;
      }
      results.push({ params: combo, trainStats: train.stats, testStats, stats: testStats && testStats.trades > 0 ? testStats : train.stats });
    } catch (e) {
      // skip
    }
  }
  results.sort((a, b) => {
    const aHasTest = (a.testStats?.trades ?? 0) > 0;
    const bHasTest = (b.testStats?.trades ?? 0) > 0;
    const aR = aHasTest ? (a.testStats?.totalR ?? 0) : a.trainStats.totalR;
    const bR = bHasTest ? (b.testStats?.totalR ?? 0) : b.trainStats.totalR;
    if (aHasTest !== bHasTest) return aHasTest ? -1 : 1;
    return bR - aR || (b.testStats?.winRate ?? b.trainStats.winRate) - (a.testStats?.winRate ?? a.trainStats.winRate);
  });
  return { totalCombos: combos.length, runCombos: runCombos.length, results: results.slice(0, 50), splitRatio };
}
