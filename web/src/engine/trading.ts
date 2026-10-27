import type { Bar, ClosedTrade, OpenTrade, TradeSide } from '../types';

/** 风险金额 = 账户权益 × 单笔风险比例 */
export function riskAmount(equity: number, riskPct: number): number {
  return Math.max(0, equity * (riskPct / 100));
}

/**
 * 数量（标的数量，U 本位合约口径）。
 * qty = 风险金额 / |入场价 - 止损价|
 * 距离为 0 时不允许开仓。
 */
export function computeQty(entryPrice: number, stopLoss: number, risk: number): number {
  const dist = Math.abs(entryPrice - stopLoss);
  if (!Number.isFinite(dist) || dist <= 0) return 0;
  return risk / dist;
}

/** 校验开仓参数是否合法 */
export function validateEntry(
  side: TradeSide,
  entryPrice: number,
  stopLoss: number,
  takeProfit: number | null,
): { ok: boolean; msg?: string } {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, msg: '入场价无效' };
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) return { ok: false, msg: '止损价无效' };
  if (side === 'long') {
    if (stopLoss >= entryPrice) return { ok: false, msg: '做多时止损必须低于入场价' };
    if (takeProfit !== null && takeProfit <= entryPrice)
      return { ok: false, msg: '做多时目标必须高于入场价' };
  } else {
    if (stopLoss <= entryPrice) return { ok: false, msg: '做空时止损必须高于入场价' };
    if (takeProfit !== null && takeProfit >= entryPrice)
      return { ok: false, msg: '做空时目标必须低于入场价' };
  }
  return { ok: true };
}

/** 计划风险（1R 对应的价格距离） */
export function riskDistance(trade: OpenTrade): number {
  return Math.abs(trade.entryPrice - trade.stopLoss);
}

/** 目标对应的 R 倍数 */
export function targetR(trade: OpenTrade): number | null {
  if (trade.takeProfit === null) return null;
  const dist = riskDistance(trade);
  if (dist <= 0) return null;
  return Math.abs(trade.takeProfit - trade.entryPrice) / dist;
}

/**
 * 检查某根 1h K 线是否触发出场。
 * 保守假设：同一根 K 线内同时触及止损与目标时，视为先打止损。
 */
export function checkExit(
  trade: OpenTrade,
  bar: Bar,
): { reason: 'stop' | 'target'; price: number } | null {
  const { side, stopLoss, takeProfit } = trade;
  const stopHit = side === 'long' ? bar.low <= stopLoss : bar.high >= stopLoss;
  const targetHit =
    takeProfit === null
      ? false
      : side === 'long'
        ? bar.high >= takeProfit
        : bar.low <= takeProfit;

  if (stopHit) return { reason: 'stop', price: stopLoss };
  if (targetHit) return { reason: 'target', price: takeProfit as number };
  return null;
}

/** 浮盈（未平仓时按当前价计） */
export function unrealizedPnl(trade: OpenTrade, price: number): number {
  const dir = trade.side === 'long' ? 1 : -1;
  return (price - trade.entryPrice) * dir * trade.qty;
}

/** 当前浮动 R */
export function unrealizedR(trade: OpenTrade, price: number): number {
  if (trade.riskAmount <= 0) return 0;
  return unrealizedPnl(trade, price) / trade.riskAmount;
}

/** 平仓结果 */
export function closeTrade(
  trade: OpenTrade,
  exitTime: number,
  exitPrice: number,
  exitReason: ClosedTrade['exitReason'],
): ClosedTrade {
  const pnl = unrealizedPnl(trade, exitPrice);
  const rMultiple = trade.riskAmount > 0 ? pnl / trade.riskAmount : 0;
  return { ...trade, exitTime, exitPrice, exitReason, pnl, rMultiple };
}
