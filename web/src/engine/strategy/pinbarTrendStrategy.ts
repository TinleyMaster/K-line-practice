import type { Bar } from '../../types';
import type { RawSignal, SeriesContext, Strategy, StrategyParams, TradeIntent } from './types';
import { atr, sma, trendBias } from './indicators';
import { SIGNAL_MODULES } from './signals';

/**
 * 默认策略：Pinbar 拐点 + 趋势过滤。
 *
 * 决策流程：
 *   1) 收集所有「启用」信号模块的原始信号；
 *   2) 若开启趋势过滤，用慢均线（默认 MA60）判断多空偏置；
 *   3) 若开启「仅顺势」，bull 信号只在多头势入场、bear 信号只在空头势入场；
 *   4) 信号根「下一根开盘」入场（避免看未来），止损取 pinbar 鼻线（或 ATR 倍数），
 *      止盈取 entry ± takeProfitR × 风险距离。
 *
 * 这一步只产出"开仓意图"，真正的成交与持仓管理交给执行器（Executor）。
 */
export const pinbarTrendStrategy: Strategy = {
  name: 'pinbar_trend',
  label: 'Pinbar 拐点 + 趋势过滤',
  description:
    '只在真实转折点的 Pinbar 处考虑入场，并用慢均线过滤方向，顺势开仓。可插拔：信号模块可在参数里按需开关。',
  detectIntents(bars: Bar[], params: StrategyParams, ctx: SeriesContext): TradeIntent[] {
    const n = bars.length;
    if (n === 0) return [];

    const closes = bars.map((b) => b.close);

    // 趋势偏置
    let bias = new Array<number>(n).fill(0);
    if (params.trendEnabled) {
      const ma = sma(closes, params.trendPeriod);
      bias = trendBias(closes, ma);
    }

    // 收集启用的原始信号
    const raw: RawSignal[] = [];
    for (const mod of SIGNAL_MODULES) {
      if (params.signals[mod.name]) raw.push(...mod.detect(bars, ctx));
    }

    // ATR（用于 ATR 止损）
    const atrArr = params.stopType === 'atr' ? atr(bars, params.atrPeriod) : [];

    const intents: TradeIntent[] = [];
    for (const s of raw) {
      // 顺势过滤：趋势明确且与信号同向才入场（bias=0 表示均线未就绪，不交易）
      if (params.trendEnabled && params.requireTrendAligned) {
        if (s.side === 'bull' && bias[s.index] !== 1) continue; // 只在多头势接多
        if (s.side === 'bear' && bias[s.index] !== -1) continue; // 只在空头势接空
      }

      // 入场根 = 信号根下一根开盘（看到反转确认后进场）
      const entryIdx = s.index + 1;
      if (entryIdx >= n) continue;
      const entryBar = bars[entryIdx];
      const entryPrice = entryBar.open;

      // 止损
      let stopLoss: number;
      if (params.stopType === 'atr') {
        const a = atrArr[s.index];
        if (!Number.isFinite(a) || a <= 0) continue;
        stopLoss = s.side === 'bull' ? entryPrice - params.atrMult * a : entryPrice + params.atrMult * a;
      } else {
        // 信号自然止损：pinbar 鼻线再外推一点点缓冲，避免毛刺扫损
        const buffer = Math.max(entryPrice * 0.0005, Math.abs(s.stopPrice - entryPrice) * 0.1);
        stopLoss = s.side === 'bull' ? s.stopPrice - buffer : s.stopPrice + buffer;
      }

      // 方向合法性
      if (s.side === 'bull' && stopLoss >= entryPrice) continue;
      if (s.side === 'bear' && stopLoss <= entryPrice) continue;

      const dist = Math.abs(entryPrice - stopLoss);
      if (dist <= 0) continue;

      const takeProfit =
        params.takeProfitR > 0
          ? s.side === 'bull'
            ? entryPrice + params.takeProfitR * dist
            : entryPrice - params.takeProfitR * dist
          : null;

      intents.push({
        index: entryIdx,
        time: entryBar.time,
        side: s.side === 'bull' ? 'long' : 'short',
        entryPrice,
        stopLoss,
        takeProfit,
        riskPct: params.riskPct,
        signal: s.module,
        strength: s.strength,
      });
    }

    // 按入场时间排序，执行器按序处理
    intents.sort((a, b) => a.index - b.index);
    return intents;
  },
};

/** 策略注册表（后续可加反转、突破等策略） */
export const STRATEGIES: Strategy[] = [pinbarTrendStrategy];

export function getStrategy(name: string): Strategy {
  return STRATEGIES.find((s) => s.name === name) ?? pinbarTrendStrategy;
}
