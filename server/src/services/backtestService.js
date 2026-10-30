import { queryRows } from '../db.js';
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

export async function runBacktest(params) {
  const {
    symbol,
    market = 'perp',
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
    limit = 20000,
  } = params || {};

  if (!symbol) throw new Error('缺少 symbol');

  const rows = await queryRows(
    `SELECT open_time, open_px, high_px, low_px, close_px
       FROM ${PRAC.schema}.klines
      WHERE market = $1 AND symbol = $2 AND interval = '1h'
      ORDER BY open_time ASC
      LIMIT $3`,
    [market, String(symbol).toUpperCase(), limit],
  );

  const bars = rows.map((r) => ({
    time: new Date(r.open_time).getTime(),
    open: Number(r.open_px),
    high: Number(r.high_px),
    low: Number(r.low_px),
    close: Number(r.close_px),
  }));

  if (bars.length < 100) throw new Error('数据不足');

  const closes = bars.map((b) => b.close);
  const eFast = emaSeries(closes, emaFast);
  const eMid = emaSeries(closes, emaMid);
  const eSlow = emaSeries(closes, emaSlow);
  const trendFlags = bars.map((b) => isTrendK(b, minBody, maxShadow));
  const mp = midPoints(bars);

  const defenseHigh = new Array(bars.length).fill(null);
  const defenseLow = new Array(bars.length).fill(null);
  let lastMH = null, lastML = null;
  for (let i = 0; i < bars.length; i++) {
    if (mp.highs[i] != null) lastMH = mp.highs[i];
    if (mp.lows[i] != null) lastML = mp.lows[i];
    defenseHigh[i] = lastMH;
    defenseLow[i] = lastML;
  }

  const trades = [];
  let openTrade = null;
  let consecBull = 0, consecBear = 0;
  let inPullbackLong = false, inPullbackShort = false;
  let pullbackLowLong = null, pullbackHighShort = null;
  let trendActiveLong = false, trendActiveShort = false;

  const equity = [{ time: bars[0].time, equity: 10000 }];
  let equityVal = 10000;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const tf = trendFlags[i];

    if (tf.bull) consecBull++; else consecBull = 0;
    if (tf.bear) consecBear++; else consecBear = 0;

    const emaBull = eFast[i] != null && eMid[i] != null && eSlow[i] != null && eFast[i] > eMid[i] && eMid[i] > eSlow[i];
    const emaBear = eFast[i] != null && eMid[i] != null && eSlow[i] != null && eFast[i] < eMid[i] && eMid[i] < eSlow[i];

    if (consecBull >= minConsec && emaBull) trendActiveLong = true;
    if (trendActiveLong && !tf.bull) {
      inPullbackLong = true;
      if (pullbackLowLong == null || bar.low < pullbackLowLong) pullbackLowLong = bar.low;
    }
    if (!trendActiveLong && !inPullbackLong && !tf.bull) trendActiveLong = false;

    if (consecBear >= minConsec && emaBear) trendActiveShort = true;
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
        const pnl = t.side === 'long' ? (exitPrice - t.entryPrice) : (t.entryPrice - exitPrice);
        const risk = t.side === 'long' ? (t.entryPrice - t.stopLoss) : (t.stopLoss - t.entryPrice);
        const rMult = risk > 0 ? pnl / risk : 0;
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
    if (!openTrade) {
      const wantLong = side === 'both' || side === 'long';
      const wantShort = side === 'both' || side === 'short';

      if (wantLong && trendActiveLong) {
        if (inPullbackLong && tf.bull) {
          const stopLoss = stopMode === 'defense' ? (defenseLow[i] ?? bar.low) : bar.close * (1 - stopPct / 100);
          if (stopLoss < bar.close) {
            const risk = bar.close - stopLoss;
            const takeProfit = tpMode === 'rMultiple' ? bar.close + risk * tpR : null;
            openTrade = {
              side: 'long',
              entryTime: bar.time,
              entryPrice: bar.close,
              entryIdx: i,
              stopLoss,
              takeProfit,
              tpR,
            };
            inPullbackLong = false;
            pullbackLowLong = null;
            trendActiveLong = false;
          }
        }
        if (inPullbackLong && defenseLow[i] != null && pullbackLowLong != null && pullbackLowLong < defenseLow[i]) {
          inPullbackLong = false;
          pullbackLowLong = null;
          trendActiveLong = false;
        }
      } else if (wantLong) {
        inPullbackLong = false;
        pullbackLowLong = null;
      }

      if (!openTrade && wantShort && trendActiveShort) {
        if (inPullbackShort && tf.bear) {
          const stopLoss = stopMode === 'defense' ? (defenseHigh[i] ?? bar.high) : bar.close * (1 + stopPct / 100);
          if (stopLoss > bar.close) {
            const risk = stopLoss - bar.close;
            const takeProfit = tpMode === 'rMultiple' ? bar.close - risk * tpR : null;
            openTrade = {
              side: 'short',
              entryTime: bar.time,
              entryPrice: bar.close,
              entryIdx: i,
              stopLoss,
              takeProfit,
              tpR,
            };
            inPullbackShort = false;
            pullbackHighShort = null;
            trendActiveShort = false;
          }
        }
        if (inPullbackShort && defenseHigh[i] != null && pullbackHighShort != null && pullbackHighShort > defenseHigh[i]) {
          inPullbackShort = false;
          pullbackHighShort = null;
          trendActiveShort = false;
        }
      } else if (!openTrade && wantShort) {
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
    params: { minBody, maxShadow, minConsec, emaFast, emaMid, emaSlow, stopMode, stopPct, tpR, tpMode, timeStop, side },
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

export async function runOptimization(baseParams, grid) {
  const results = [];
  const keys = Object.keys(grid);
  const combos = [{}];
  for (const k of keys) {
    const next = [];
    for (const c of combos) {
      for (const v of grid[k]) {
        next.push({ ...c, [k]: v });
      }
    }
    combos.splice(0, combos.length, ...next);
  }
  const MAX = 200;
  const runCombos = combos.slice(0, MAX);
  for (const combo of runCombos) {
    try {
      const r = await runBacktest({ ...baseParams, ...combo });
      results.push({ params: combo, stats: r.stats });
    } catch (e) {
      // skip
    }
  }
  results.sort((a, b) => (b.stats.totalR - a.stats.totalR) || (b.stats.winRate - a.stats.winRate));
  return { totalCombos: combos.length, runCombos: runCombos.length, results: results.slice(0, 50) };
}
