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

function midPoints(bars) {
  const highs = new Array(bars.length).fill(null);
  const lows = new Array(bars.length).fill(null);
  for (let i = 2; i < bars.length; i++) {
    if (bars[i].high > bars[i - 1].high && bars[i].high > bars[i - 2].high) highs[i] = bars[i].high;
    if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i - 2].low) lows[i] = bars[i].low;
  }
  return { highs, lows };
}

// ATR (Wilder smoothing)
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

// 4h K 线派生（从 1h 聚合，UTC 4h 桶对齐）
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

// EMA 斜率：最近 slopeBars 根 EMA 是否单调上升/下降
function emaSlope(emaArr, i, slopeBars) {
  if (i < slopeBars) return 0;
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
    // 新增参数
    feeRate = 0.0004,        // 单边费率
    slippageBps = 0,         // 滑点 bp
    atrPeriod = 14,
    atrMult = 2,             // ATR 止损倍数（stopMode='atr' 时）
    minStopPct = 0.5,        // 止损距离最小 %
    maxStopPct = 8,          // 止损距离最大 %
    emaSlopeBars = 3,        // EMA 斜率确认根数
    cooldownBars = 3,        // 信号冷却根数
    use4hFilter = true,      // 4h 方向过滤
    feeEnabled = true,
    riskPct = 1,
  } = params || {};

  if (bars.length < 100) throw new Error('数据不足');

  const closes = bars.map((b) => b.close);
  const eFast = emaSeries(closes, emaFast);
  const eMid = emaSeries(closes, emaMid);
  const eSlow = emaSeries(closes, emaSlow);
  const trendFlags = bars.map((b) => isTrendK(b, minBody, maxShadow));
  const mp = midPoints(bars);
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

  // 4h 方向
  let h4Bull = new Array(bars.length).fill(false);
  let h4Bear = new Array(bars.length).fill(false);
  if (use4hFilter) {
    const bars4h = derive4h(bars);
    const c4 = bars4h.map((b) => b.close);
    const e4f = emaSeries(c4, emaFast);
    const e4m = emaSeries(c4, emaMid);
    const e4s = emaSeries(c4, emaSlow);
    // map 4h EMA to 1h bars
    let idx4 = 0;
    for (let i = 0; i < bars.length; i++) {
      while (idx4 + 1 < bars4h.length && bars4h[idx4 + 1].time <= bars[i].time) idx4++;
      // 使用已完成的 4h K 线（当前桶未收盘，不能用）
      const cIdx = idx4 > 0 ? idx4 - 1 : -1;
      if (cIdx >= 0 && e4m[cIdx] != null) {
        // 简化 4h 过滤：价格在 4h EMA 中线上方/下方
        h4Bull[i] = bars4h[cIdx].close > e4m[cIdx];
        h4Bear[i] = bars4h[cIdx].close < e4m[cIdx];
      }
    }
  } else {
    h4Bull.fill(true);
    h4Bear.fill(true);
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

    // EMA 斜率确认
    const slopeFast = emaSlope(eFast, i, emaSlopeBars);
    const emaBullSlope = emaBull && slopeFast >= 0;
    const emaBearSlope = emaBear && slopeFast <= 0;

    if (consecBull >= minConsec && emaBullSlope) trendActiveLong = true;
    if (trendActiveLong && !tf.bull) {
      inPullbackLong = true;
      if (pullbackLowLong == null || bar.low < pullbackLowLong) pullbackLowLong = bar.low;
    }
    if (!trendActiveLong && !inPullbackLong && !tf.bull) trendActiveLong = false;

    if (consecBear >= minConsec && emaBearSlope) trendActiveShort = true;
    if (trendActiveShort && !tf.bear) {
      inPullbackShort = true;
      if (pullbackHighShort == null || bar.high > pullbackHighShort) pullbackHighShort = bar.high;
    }
    if (!trendActiveShort && !inPullbackShort && !tf.bear) trendActiveShort = false;

    // 持仓管理
    if (openTrade) {
      const t = openTrade;
      const barsHeld = i - t.entryIdx;
      let exitPrice = null, exitReason = null;
      if (t.side === 'long') {
        if (bar.low <= t.stopLoss) { exitPrice = t.stopLoss; exitReason = 'stop'; }
        else if (tpMode === 'rMultiple' && bar.high >= t.takeProfit) { exitPrice = t.takeProfit; exitReason = 'target'; }
        else if (timeStop != null && barsHeld >= timeStop) { exitPrice = bar.close; exitReason = 'time'; }
      } else {
        if (bar.high >= t.stopLoss) { exitPrice = t.stopLoss; exitReason = 'stop'; }
        else if (tpMode === 'rMultiple' && bar.low <= t.takeProfit) { exitPrice = t.takeProfit; exitReason = 'target'; }
        else if (timeStop != null && barsHeld >= timeStop) { exitPrice = bar.close; exitReason = 'time'; }
      }
      if (exitPrice != null) {
        const riskPerUnit = t.side === 'long' ? (t.entryPrice - t.stopLoss) : (t.stopLoss - t.entryPrice);
        const pricePnl = t.side === 'long' ? (exitPrice - t.entryPrice) : (t.entryPrice - exitPrice);
        const equityAtEntry = t.equityAtEntry ?? equityVal;
        const riskAmount = equityAtEntry * (riskPct / 100);
        const qty = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
        let pnl = pricePnl * qty;
        if (feeEnabled && qty > 0) {
          const slip = slippageBps / 10000;
          const cost = (2 * feeRate + 2 * slip) * t.entryPrice * qty;
          pnl -= cost;
        }
        const rMult = riskAmount > 0 ? pnl / riskAmount : 0;
        t.exitTime = bar.time;
        t.exitPrice = exitPrice;
        t.exitReason = exitReason;
        t.rMultiple = rMult;
        t.pnl = pnl;
        t.exitIdx = i;
        trades.push({ ...t });
        equityVal += pnl;
        equity.push({ time: bar.time, equity: equityVal });
        openTrade = null;
      }
    }

    // 无持仓时检测入场
    if (!openTrade && i - lastEntryIdx >= cooldownBars) {
      const wantLong = (side === 'both' || side === 'long') && h4Bull[i];
      const wantShort = (side === 'both' || side === 'short') && h4Bear[i];

      // loose mode：EMA 共振 + 趋势 K 直接入场
      if (signalMode === 'loose' && wantLong && emaBull && tf.bull) {
        let stopLoss;
        if (stopMode === 'defense') stopLoss = defenseLow[i] ?? bar.low;
        else if (stopMode === 'atr') stopLoss = bar.close - (atr[i] ?? bar.close * 0.02) * atrMult;
        else stopLoss = bar.close * (1 - stopPct / 100);
        const stopDistPct = (bar.close - stopLoss) / bar.close * 100;
        if (stopLoss < bar.close && stopDistPct >= minStopPct && stopDistPct <= maxStopPct) {
          const risk = bar.close - stopLoss;
          const takeProfit = tpMode === 'rMultiple' ? bar.close + risk * tpR : null;
          openTrade = {
            side: 'long', entryTime: bar.time, entryPrice: bar.close, entryIdx: i,
            stopLoss, takeProfit, tpR, equityAtEntry: equityVal,
          };
          lastEntryIdx = i;
        }
      } else if (signalMode === 'loose' && wantShort && emaBear && tf.bear) {
        let stopLoss;
        if (stopMode === 'defense') stopLoss = defenseHigh[i] ?? bar.high;
        else if (stopMode === 'atr') stopLoss = bar.close + (atr[i] ?? bar.close * 0.02) * atrMult;
        else stopLoss = bar.close * (1 + stopPct / 100);
        const stopDistPct = (stopLoss - bar.close) / bar.close * 100;
        if (stopLoss > bar.close && stopDistPct >= minStopPct && stopDistPct <= maxStopPct) {
          const risk = stopLoss - bar.close;
          const takeProfit = tpMode === 'rMultiple' ? bar.close - risk * tpR : null;
          openTrade = {
            side: 'short', entryTime: bar.time, entryPrice: bar.close, entryIdx: i,
            stopLoss, takeProfit, tpR,
          };
          lastEntryIdx = i;
        }
      }

      // strict mode：趋势激活 → 回调 → 入场
      if (!openTrade && signalMode === 'strict' && wantLong && trendActiveLong) {
        if (inPullbackLong && tf.bull) {
          const stopLoss = stopMode === 'defense' ? (defenseLow[i] ?? bar.low) : (stopMode === 'atr' ? bar.close - (atr[i] ?? bar.close * 0.02) * atrMult : bar.close * (1 - stopPct / 100));
          const stopDistPct = (bar.close - stopLoss) / bar.close * 100;
          if (stopLoss < bar.close && stopDistPct >= minStopPct && stopDistPct <= maxStopPct) {
            const risk = bar.close - stopLoss;
            const takeProfit = tpMode === 'rMultiple' ? bar.close + risk * tpR : null;
            openTrade = {
              side: 'long', entryTime: bar.time, entryPrice: bar.close, entryIdx: i,
              stopLoss, takeProfit, tpR, equityAtEntry: equityVal,
            };
            inPullbackLong = false;
            pullbackLowLong = null;
            trendActiveLong = false;
            lastEntryIdx = i;
          }
        }
        if (inPullbackLong && defenseLow[i] != null && pullbackLowLong != null && pullbackLowLong < defenseLow[i]) {
          inPullbackLong = false;
          pullbackLowLong = null;
          trendActiveLong = false;
        }
      } else if (!openTrade && signalMode === 'strict' && wantLong) {
        inPullbackLong = false;
        pullbackLowLong = null;
      }

      if (!openTrade && signalMode === 'strict' && wantShort && trendActiveShort) {
        if (inPullbackShort && tf.bear) {
          const stopLoss = stopMode === 'defense' ? (defenseHigh[i] ?? bar.high) : (stopMode === 'atr' ? bar.close + (atr[i] ?? bar.close * 0.02) * atrMult : bar.close * (1 + stopPct / 100));
          const stopDistPct = (stopLoss - bar.close) / bar.close * 100;
          if (stopLoss > bar.close && stopDistPct >= minStopPct && stopDistPct <= maxStopPct) {
            const risk = stopLoss - bar.close;
            const takeProfit = tpMode === 'rMultiple' ? bar.close - risk * tpR : null;
            openTrade = {
              side: 'short', entryTime: bar.time, entryPrice: bar.close, entryIdx: i,
              stopLoss, takeProfit, tpR,
            };
            inPullbackShort = false;
            pullbackHighShort = null;
            trendActiveShort = false;
            lastEntryIdx = i;
          }
        }
        if (inPullbackShort && defenseHigh[i] != null && pullbackHighShort != null && pullbackHighShort > defenseHigh[i]) {
          inPullbackShort = false;
          pullbackHighShort = null;
          trendActiveShort = false;
        }
      } else if (!openTrade && signalMode === 'strict' && wantShort) {
        inPullbackShort = false;
        pullbackHighShort = null;
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
    params: { minBody, maxShadow, minConsec, emaFast, emaMid, emaSlow, stopMode, stopPct, tpR, tpMode, timeStop, side, signalMode, feeRate, slippageBps, atrMult, minStopPct, maxStopPct, emaSlopeBars, cooldownBars, use4hFilter, riskPct },
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
  const bars = await loadBars(symbol, market, limit, offset);
  if (splitRatio && splitRatio > 0 && splitRatio < 1) {
    const splitIdx = Math.floor(bars.length * splitRatio);
    const trainBars = bars.slice(0, splitIdx);
    const testBars = bars.slice(splitIdx);
    const train = runBacktestOnBars(trainBars, rest);
    const test = runBacktestOnBars(testBars, rest);
    const useTest = (test.stats.trades ?? 0) > 0;
    return { ...train, stats: useTest ? test.stats : train.stats, trainStats: train.stats, testStats: test.stats, testTrades: test.trades, testEquity: test.equity, splitIdx, bars: bars.length };
  }
  return runBacktestOnBars(bars, rest);
}

export async function runOptimization(baseParams, grid) {
  const { symbol, market = 'perp', limit = 20000, splitRatio = null } = baseParams || {};
  const bars = await loadBars(symbol, market, limit, 0);
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

export async function loadBars(symbol, market, limit, offset, since, until) {
  const sym = String(symbol).toUpperCase();
  const lim = limit || 20000;
  let where = "market = $1 AND symbol = $2 AND interval = '1h'";
  const params = [market, sym];
  if (since) { params.push(new Date(since).toISOString()); where += ' AND open_time >= $' + params.length; }
  if (until) { params.push(new Date(until).toISOString()); where += ' AND open_time <= $' + params.length; }
  let off = offset;
  if (off == null && !since && !until) {
      const cnt = await queryOne('SELECT count(*)::int AS c FROM ' + PRAC.schema + '.klines WHERE ' + where, params);
    off = Math.max(0, (cnt?.c ?? 0) - lim);
  }
  off = off || 0;
  const rows = await queryRows(
    'SELECT open_time, open_px, high_px, low_px, close_px FROM ' + PRAC.schema + '.klines WHERE ' + where + ' ORDER BY open_time ASC LIMIT ' + lim + ' OFFSET ' + off,
    params,
  );
  return rows.map((r) => ({
    time: new Date(r.open_time).getTime(),
    open: Number(r.open_px),
    high: Number(r.high_px),
    low: Number(r.low_px),
    close: Number(r.close_px),
  }));
}
