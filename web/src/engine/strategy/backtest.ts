import type { Bar, OpenTrade, TradeSide } from '../../types';
import { checkExit, closeTrade, computeQty, riskAmount } from '../trading';
import type {
  BacktestResult,
  BacktestStats,
  SeriesContext,
  SimTrade,
  Strategy,
  StrategyParams,
} from './types';

interface ActivePos {
  intentIndex: number; // 入场意图在 intents 中的序号
  side: TradeSide;
  entryIndex: number;
  entryTime: number;
  entryPrice: number; // 已含滑点
  stopLoss: number;
  takeProfit: number | null;
  qty: number;
  risk: number;
  signal: string;
}

/** 用滑点与手续费把一次成交价"变真实"一点（偏保守：单子总是吃最差价） */
function applySlippage(price: number, side: TradeSide, bps: number, isEntry: boolean): number {
  const slip = bps / 10000;
  if (side === 'long') return isEntry ? price * (1 + slip) : price * (1 - slip);
  return isEntry ? price * (1 - slip) : price * (1 + slip);
}

function buildOpenTrade(
  symbol: string,
  p: ActivePos,
  feeRate: number,
  slippageBps: number,
): OpenTrade {
  return {
    id: 'sim',
    symbol,
    side: p.side,
    setup: p.signal,
    entryTime: p.entryTime,
    entryPrice: p.entryPrice,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    riskAmount: p.risk,
    qty: p.qty,
    checklist: {},
    entryMode: 'market',
    limitPrice: null,
    stopType: 'price',
    tpType: 'ratio',
    sizeMode: 'risk',
    feeRate,
    slippageBps,
    timeStopHrs: null,
    confidence: null,
    notes: null,
  };
}

/**
 * 模拟执行器（SimExecutor）：把策略产出的开仓意图按时间顺序模拟成交。
 *
 * - 逐根 K 线推进：先检查现有持仓是否触及止损/止盈（用 trading.ts 的 checkExit，
 *   保守假设同根同时触及时先打止损），再处理该根的新开仓意图；
 * - 仓位按"风险 % × 当前权益"计算，止损距离决定 qty；
 * - 计入单边手续费与滑点（偏保守）；
 * - 产出成交明细、权益曲线与统计（胜率 / R / 回撤 / 盈亏比）。
 *
 * 这是模拟盘闭环；实盘只需替换"成交"这一步（接交易所 API），其余逻辑复用。
 */
export function runBacktest(
  bars: Bar[],
  strategy: Strategy,
  params: StrategyParams,
  ctx: SeriesContext,
): BacktestResult {
  const intents = strategy.detectIntents(bars, params, ctx);
  const n = bars.length;

  let equity = params.startEquity;
  let peakEquity = params.startEquity;
  const trades: SimTrade[] = [];
  const equityCurve: { time: number; equity: number }[] = [
    { time: bars[0]?.time ?? 0, equity },
  ];

  const active: ActivePos[] = [];

  for (let i = 0; i < n; i++) {
    const bar = bars[i];

    // 1) 检查现有持仓出场（止损 / 止盈）
    for (let k = active.length - 1; k >= 0; k--) {
      const pos = active[k];
      // 直接用 trading.ts 的 checkExit 判断这根 K 是否触发出场
      const exit = checkExit(buildOpenTrade(ctx.symbol, pos, params.feeRate, params.slippageBps), bar);
      if (exit) {
        const rawExit = applySlippage(exit.price, pos.side, params.slippageBps, false);
        const open = buildOpenTrade(ctx.symbol, pos, params.feeRate, params.slippageBps);
        const closed = closeTrade(open, bar.time, rawExit, exit.reason);
        // 手续费：开 + 平 双边名义
        const fee = (pos.entryPrice + rawExit) * pos.qty * params.feeRate;
        const pnlNet = closed.pnl - fee;
        const rNet = pos.risk > 0 ? pnlNet / pos.risk : 0;
        equity += pnlNet;
        peakEquity = Math.max(peakEquity, equity);
        trades.push({
          id: `sim-${trades.length}`,
          symbol: ctx.symbol,
          side: pos.side,
          signal: pos.signal,
          entryIndex: pos.entryIndex,
          entryTime: pos.entryTime,
          entryPrice: pos.entryPrice,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          exitIndex: i,
          exitTime: bar.time,
          exitPrice: rawExit,
          exitReason: exit.reason,
          qty: pos.qty,
          riskAmount: pos.risk,
          pnl: pnlNet,
          rMultiple: rNet,
          equityAfter: equity,
        });
        equityCurve.push({ time: bar.time, equity });
        active.splice(k, 1);
      }
    }

    // 2) 该根是否有新开仓意图（且未达持仓上限）
    if (active.length < params.maxConcurrent) {
      // 取该根所有意图（同一根可能有多个信号模块信号，先到先得取第一个未超上限的）
      const here = intents.filter((t) => t.index === i);
      for (const intent of here) {
        if (active.length >= params.maxConcurrent) break;
        const entryPrice = applySlippage(intent.entryPrice, intent.side, params.slippageBps, true);
        const risk = riskAmount(equity, intent.riskPct);
        const qty = computeQty(entryPrice, intent.stopLoss, risk);
        if (qty <= 0) continue;
        active.push({
          intentIndex: i,
          side: intent.side,
          entryIndex: i,
          entryTime: intent.time,
          entryPrice,
          stopLoss: intent.stopLoss,
          takeProfit: intent.takeProfit,
          qty,
          risk,
          signal: intent.signal,
        });
      }
    }
  }

  // 3) 收尾：仍持仓的，按最后一根收盘平掉（session_end）
  const last = bars[n - 1];
  if (last) {
    for (let k = active.length - 1; k >= 0; k--) {
      const pos = active[k];
      const rawExit = applySlippage(last.close, pos.side, params.slippageBps, false);
      const open = buildOpenTrade(ctx.symbol, pos, params.feeRate, params.slippageBps);
      const closed = closeTrade(open, last.time, rawExit, 'session_end');
      const fee = (pos.entryPrice + rawExit) * pos.qty * params.feeRate;
      const pnlNet = closed.pnl - fee;
      const rNet = pos.risk > 0 ? pnlNet / pos.risk : 0;
      equity += pnlNet;
      peakEquity = Math.max(peakEquity, equity);
      trades.push({
        id: `sim-${trades.length}`,
        symbol: ctx.symbol,
        side: pos.side,
        signal: pos.signal,
        entryIndex: pos.entryIndex,
        entryTime: pos.entryTime,
        entryPrice: pos.entryPrice,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
        exitIndex: n - 1,
        exitTime: last.time,
        exitPrice: rawExit,
        exitReason: 'session_end',
        qty: pos.qty,
        riskAmount: pos.risk,
        pnl: pnlNet,
        rMultiple: rNet,
        equityAfter: equity,
      });
      equityCurve.push({ time: last.time, equity });
      active.splice(k, 1);
    }
  }

  const stats = computeStats(trades, params.startEquity, equity);

  return { trades, equityCurve, stats, params, bars: n };
}

function computeStats(
  trades: SimTrade[],
  startEquity: number,
  endEquity: number,
): BacktestStats {
  const count = trades.length;
  const wins = trades.filter((t) => t.rMultiple > 0).length;
  const losses = count - wins;
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
  const avgR = count > 0 ? totalR / count : 0;
  const grossProfit = trades.reduce((s, t) => s + (t.pnl > 0 ? t.pnl : 0), 0);
  const grossLoss = trades.reduce((s, t) => s + (t.pnl < 0 ? -t.pnl : 0), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null;
  const avgHoldBars =
    count > 0 ? trades.reduce((s, t) => s + (t.exitIndex - t.entryIndex), 0) / count : 0;
  // 最大回撤：扫权益曲线峰值回撤
  let p2 = startEquity;
  let maxDd = 0;
  for (const t of trades) {
    p2 = Math.max(p2, t.equityAfter);
    maxDd = Math.max(maxDd, p2 > 0 ? (p2 - t.equityAfter) / p2 : 0);
  }
  void endEquity;
  return {
    trades: count,
    wins,
    losses,
    winRate: count > 0 ? wins / count : 0,
    totalR,
    avgR,
    expectancy: avgR,
    maxDrawdown: maxDd,
    profitFactor,
    avgHoldBars,
  };
}
