import { queryRows } from '../db.js';
import { PRAC } from '../config.js';

/**
 * 回测引擎（服务端）。
 *
 * 输入：params
 *   symbol, market, startIdx? (默认全部)
 *   minBody, maxShadow (趋势K严格度)
 *   minConsec (连续趋势K根数)
 *   emaFast, emaMid, emaSlow
 *   stopMode: 'defense' | 'fixedPct'
 *   stopPct: 固定止损百分比（stopMode=fixedPct 时）
 *   tpMode: 'rMultiple' | 'none' | 'time'
 *   tpR: 止盈 R 倍数
 *   timeStop: 时间止损根数（null 不启用）
 *   side: 'both' | 'long' | 'short'
 *
 * 输出：{ trades: [...], equity: [...], stats: {...} }
 */

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

// 中期高低点：当前 high > 前两根 high
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

  // 防守位：最后一个中期高/低点（滚动）
  const defenseHigh = new Array(bars.length).fill(null); // 空头防守位 = 最后一个中期高点
  const defenseLow = new Array(bars.length).fill(null);  // 多头防守位 = 最后一个中期低点
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
    const prev = bars[i - 1];
    const tf = trendFlags[i];

    // 更新连续趋势K计数
    if (tf.bull) consecBull++; else consecBull = 0;
    if (tf.bear) consecBear++; else consecBear = 0;

    const emaBull = eFast[i] != null && eMid[i] != null && eSlow[i] != null && eFast[i] > eMid[i] && eMid[i] > eSlow[i];
    const emaBear = eFast[i] != null && eMid[i] != null && eSlow[i] != null && eFast[i] < eMid[i] && eMid[i] < eSlow[i];

    // 趋势激活
    if (consecBull >= minConsec && emaBull) trendActiveLong = true;
    else if (!tf.bull) trendActiveLong = false;
    if (consecBear >= minConsec && emaBear) trendActiveShort = true;
    else if (!tf.bear) trendActiveShort = false;

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
      // 同根同时触及：保守先止损（上面已优先 stop）
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

      // 多头：趋势激活后出现回调，再出现趋势K入场
      if (wantLong && trendActiveLong && emaBull) {
        // 回调检测：上一根非多头趋势K 或 低点低于前高
        if (!tf.bull) {
          inPullbackLong = true;
          pullbackLowLong = bar.low;
        } else if (inPullbackLong) {
          // 回调结束，出现趋势K → 入场
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
        if (inPullbackLong && bar.low < (pullbackLowLong ?? bar.low)) pullbackLowLong = bar.low;
        // 若回调跌破防守位 → 失败
        if (inPullbackLong && defenseLow[i] != null && pullbackLowLong != null && pullbackLowLong < defenseLow[i]) {
          inPullbackLong = false;
          pullbackLowLong = null;
          trendActiveLong = false;
        }
      } else {
        inPullbackLong = false;
        pullbackLowLong = null;
      }

      if (!openTrade && wantShort && trendActiveShort && emaBear) {
        if (!tf.bear) {
          inPullbackShort = true;
          pullbackHighShort = bar.high;
        } else if (inPullbackShort) {
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
        if (inPullbackShort && bar.high > (pullbackHighShort ?? bar.high)) pullbackHighShort = bar.high;
        if (inPullbackShort && defenseHigh[i] != null && pullbackHighShort != null && pullbackHighShort > defenseHigh[i]) {
          inPullbackShort = false;
          pullbackHighShort = null;
          trendActiveShort = false;
        }
      } else if (!openTrade) {
        inPullbackShort = false;
        pullbackHighShort = null;
      }
    }
  }

  // 未平仓的尾部交易不计（或按最后收盘平）
  // 统计
  const closed = trades.filter((t) => t.exitPrice != null);
  const wins = closed.filter((t) => t.rMultiple > 0);
  const totalR = closed.reduce((s, t) => s + (t.rMultiple || 0), 0);
  const avgR = closed.length ? totalR / closed.length : 0;
  const winRate = closed.length ? wins.length / closed.length : 0;
  // max drawdown on equity
  let peak = equity[0]?.equity ?? 10000;
  let maxDD = 0;
  for (const e of equity) {
    if (e.equity > peak) peak = e.equity;
    const dd = (peak - e.equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const grossWin = closed.filter(t=>t.rMultiple>0).reduce((s,t)=>s+t.rMultiple,0);
  const grossLoss = Math.abs(closed.filter(t=>t.rMultiple<=0).reduce((s,t)=>s+t.rMultiple,0));
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
  // 笛卡尔积
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
  // 限制组合数
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
