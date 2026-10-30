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

function midPoints(bars, win = 3, confBars = 6, revTol = 0.001) {
  const highs = new Array(bars.length).fill(null);
  const lows = new Array(bars.length).fill(null);
  // 候选拐点：左侧 win 根 + 右侧 1 根都更低/更高（右侧只等 1 根，避免滞后）
  const rightWin = 1;
  const candHigh = new Array(bars.length).fill(false);
  const candLow = new Array(bars.length).fill(false);
  for (let i = 0; i < bars.length; i++) {
    if (i - win < 0 || i + rightWin >= bars.length) continue;
    let isH = true;
    let isL = true;
    for (let j = i - win; j <= i + rightWin; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isH = false;
      if (bars[j].low <= bars[i].low) isL = false;
    }
    if (isH) candHigh[i] = true;
    if (isL) candLow[i] = true;
  }
  // 确认：候选高点若在之后 confBars 根内被更高的高点击穿 → 上升途中的回拉，丢弃；
  // 真正的顶之后价格反向，不会被击穿，保留。末 confBars 根无法确认 → 暂保留。
  for (let i = 0; i < bars.length; i++) {
    if (candHigh[i]) {
      let broken = false;
      for (let j = i + 1; j <= i + confBars && j < bars.length; j++) {
        if (bars[j].high > bars[i].high * (1 + revTol)) { broken = true; break; }
      }
      if (!broken) highs[i] = bars[i].high;
    }
    if (candLow[i]) {
      let broken = false;
      for (let j = i + 1; j <= i + confBars && j < bars.length; j++) {
        if (bars[j].low < bars[i].low * (1 - revTol)) { broken = true; break; }
      }
      if (!broken) lows[i] = bars[i].low;
    }
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
    'SELECT open_time, open_px, high_px, low_px, close_px FROM ' + PRAC.schema + '.klines WHERE ' + where + ' ORDER BY open_time ASC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2),
    [...params, lim, finalOffset],
  );
  return rows.map((r) => ({
    time: new Date(r.open_time).getTime(),
    open: Number(r.open_px),
    high: Number(r.high_px),
    low: Number(r.low_px),
    close: Number(r.close_px),
  }));
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
  } = params || {};

  if (bars.length < 100) throw new Error('数据不足');

  const closes = bars.map((b) => b.close);
  const eFast = emaSeries(closes, emaFast);
  const eMid = emaSeries(closes, emaMid);
  const eSlow = emaSeries(closes, emaSlow);
  const trendFlags = bars.map((b) => isTrendK(b, minBody, maxShadow));
  const mp = midPoints(bars, swingWin, 6, 0.001);
  const atr = atrSeries(bars, atrPeriod);

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

  const equity = [{ time: bars[0].time, equity: 10000 }];
  let equityVal = 10000;

  const slip = slippageBps / 10000;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const tf = trendFlags[i];

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
        else if (timeStop != null && barsHeld >= timeStop) { exitPrice = bar.close; exitReason = 'time'; }
      } else {
        if (bar.high >= t.stopLoss) { exitPrice = t.stopLoss; exitReason = 'stop'; }
        else if (tpMode === 'rMultiple' && t.takeProfit != null && bar.low <= t.takeProfit) { exitPrice = t.takeProfit; exitReason = 'target'; }
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
      if (wantLong && emaBull && trendActiveLong && inPullbackLong && tf.bull) {
        const structOk = signalMode !== 'strict' || (defenseLow[i] != null && pullbackLowLong != null && pullbackLowLong >= defenseLow[i] * 0.999);
        if (structOk) {
          let stopLoss;
          if (stopMode === 'defense') stopLoss = Math.min(defenseLow[i] ?? bar.low, bar.low);
          else if (stopMode === 'atr') stopLoss = bar.close - (atr[i] ?? bar.close * 0.02) * atrMult;
          else stopLoss = bar.close * (1 - stopPct / 100);
          const stopDistPct = stopLoss < bar.close ? (bar.close - stopLoss) / bar.close * 100 : 999;
          if (stopLoss < bar.close && stopDistPct >= minStopPct && stopDistPct <= maxStopPct) {
            const risk = bar.close - stopLoss;
            const takeProfit = tpMode === 'rMultiple' ? bar.close + risk * tpR : null;
            openTrade = {
              side: 'long', entryTime: bar.time, entryPrice: bar.close, entryIdx: i,
              stopLoss, takeProfit, tpR, entryRisk: risk, equityAtEntry: equityVal,
            };
            lastEntryIdx = i;
            inPullbackLong = false;
            pullbackLowLong = null;
          }
        }
      } else if (wantShort && emaBear && trendActiveShort && inPullbackShort && tf.bear) {
        const structOk = signalMode !== 'strict' || (defenseHigh[i] != null && pullbackHighShort != null && pullbackHighShort <= defenseHigh[i] * 1.001);
        if (structOk) {
          let stopLoss;
          if (stopMode === 'defense') stopLoss = Math.max(defenseHigh[i] ?? bar.high, bar.high);
          else if (stopMode === 'atr') stopLoss = bar.close + (atr[i] ?? bar.close * 0.02) * atrMult;
          else stopLoss = bar.close * (1 + stopPct / 100);
          const stopDistPct = stopLoss > bar.close ? (stopLoss - bar.close) / bar.close * 100 : 999;
          if (stopLoss > bar.close && stopDistPct >= minStopPct && stopDistPct <= maxStopPct) {
            const risk = stopLoss - bar.close;
            const takeProfit = tpMode === 'rMultiple' ? bar.close - risk * tpR : null;
            openTrade = {
              side: 'short', entryTime: bar.time, entryPrice: bar.close, entryIdx: i,
              stopLoss, takeProfit, tpR, entryRisk: risk, equityAtEntry: equityVal,
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
    params: { minBody, maxShadow, swingWin, minConsec, emaFast, emaMid, emaSlow, stopMode, stopPct, tpR, tpMode, timeStop, side, signalMode, feeRate, slippageBps, atrMult, minStopPct, maxStopPct, emaSlopeBars, cooldownBars, use4hFilter, riskPct },
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
  console.error('[DBG] bars=' + bars.length + ' first=' + new Date(bars[0]?.time).toISOString());
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
