import type { Bar } from '../../types';
import type { RawSignal, SeriesContext, Strategy, StrategyParams, TradeIntent } from './types';
import { atr, efficiencyRatio, regimeSeries, sma, trendBias } from './indicators';
import { SIGNAL_MODULES } from './signals';

/**
 * 把"原始信号 → 开仓意图"的核心逻辑抽成共享函数，供普通策略与 regime 切换元策略复用。
 * 负责：趋势对齐过滤、入场时机（确认根+1 开盘，零未来函数）、止损、止盈（信号自带目标价优先）。
 * gate(s, decIdx) 可选：regime 元策略用它按当前市场状态放行/拦截某类信号。
 */
export function buildIntentsFromRaw(
  raw: RawSignal[],
  bars: Bar[],
  params: StrategyParams,
  bias: number[],
  atrArr: number[],
  gate?: (s: RawSignal, decIdx: number) => boolean,
): TradeIntent[] {
  const n = bars.length;
  const intents: TradeIntent[] = [];
  for (const s of raw) {
    // 决策根 = 拐点被「摆动确认」的根 j+W（confirmIndex）；入场只发生在 confirmIndex+1 开盘，
    // 确认所用数据（窗口 [confirmIndex-2W, confirmIndex]）全部 ≤ confirmIndex，零未来函数。
    const decIdx = s.confirmIndex;

    // regime 门禁：不满足当前市场状态则丢弃该信号
    if (gate && !gate(s, decIdx)) continue;

    // 顺势过滤：趋势明确且与信号同向才入场（bias=0 表示均线未就绪，不交易）。
    // 均值回归类信号（againstTrend）逆向开仓，跳过该过滤——方向由信号自身决定。
    if (params.trendEnabled && params.requireTrendAligned && !s.againstTrend) {
      if (s.side === 'bull' && bias[decIdx] !== 1) continue; // 只在多头势接多
      if (s.side === 'bear' && bias[decIdx] !== -1) continue; // 只在空头势接空
    }

    // 入场根 = 确认根下一根开盘（拐点 + 摆动确认都已是过去，零未来函数）
    const entryIdx = decIdx + 1;
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
      // 信号自然止损：pinbar 鼻线 / 均值回归的 ATR 止损，再外推一点点缓冲，避免毛刺扫损
      const buffer = Math.max(entryPrice * 0.0005, Math.abs(s.stopPrice - entryPrice) * 0.1);
      stopLoss = s.side === 'bull' ? s.stopPrice - buffer : s.stopPrice + buffer;
    }

    // 方向合法性
    if (s.side === 'bull' && stopLoss >= entryPrice) continue;
    if (s.side === 'bear' && stopLoss <= entryPrice) continue;

    const dist = Math.abs(entryPrice - stopLoss);
    if (dist <= 0) continue;

    // 出场方式：
    //  - 信号自带的 targetPrice（如均值回归回归均值）优先；
    //  - trail=趋势翻转才离场（让利润奔跑），此时不设固定止盈；
    //  - 否则固定 R 止盈。三者都保留初始止损来定义 R。
    let takeProfit: number | null;
    if (s.targetPrice != null) {
      takeProfit =
        s.side === 'bull'
          ? Math.max(s.targetPrice, entryPrice + dist * 0.1)
          : Math.min(s.targetPrice, entryPrice - dist * 0.1);
    } else if (params.exitType === 'trail' || params.takeProfitR <= 0) {
      takeProfit = null;
    } else {
      takeProfit =
        s.side === 'bull'
          ? entryPrice + params.takeProfitR * dist
          : entryPrice - params.takeProfitR * dist;
    }

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
      againstTrend: s.againstTrend,
    });
  }

  // 按入场时间排序，执行器按序处理
  intents.sort((a, b) => a.index - b.index);
  return intents;
}

/**
 * 默认策略：Pinbar 拐点 + 趋势过滤（实为"启用信号模块的并集"，无 regime 区分）。
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
  label: '信号并集（无 Regime 区分）',
  description:
    '把启用信号模块的并集直接交易（趋势回调 + 均值回归同时在线，不做市场状态切换）。可插拔：信号模块可在参数里按需开关。',
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

    return buildIntentsFromRaw(raw, bars, params, bias, atrArr);
  },
};

/**
 * Regime 切换元策略：按"效率比"判定市场是趋势市还是震荡市，
 * 再放行对应类别的信号——趋势市用顺势信号（趋势回调），震荡市用均值回归。
 *
 * - 效率比 ER = 窗口内净位移 / 总路径，仅用 ≤ i 数据；ER 高=趋势、低=震荡（带滞后避免横跳）；
 * - 在决策根 decIdx 读取状态，入场在 decIdx+1，零未来函数；
 * - 这样把"趋势类（训练赚/测试亏）"与"回归类（训练亏/测试赚）"错位的时间段拼接起来，
 *   目标是在两个时段都赚钱，而不是把过拟合藏在某一段。
 */
export const regimeSwitchStrategy: Strategy = {
  name: 'regime_switch',
  label: 'Regime 切换（趋势/回归）',
  description:
    '按效率比判定趋势/震荡市：趋势市放行顺势信号（趋势回调），震荡市放行均值回归。把两类互补 edge 按市场状态拼接。',
  detectIntents(bars: Bar[], params: StrategyParams, ctx: SeriesContext): TradeIntent[] {
    const n = bars.length;
    if (n === 0) return [];

    const closes = bars.map((b) => b.close);

    // 趋势偏置（趋势类信号仍要顺势过滤）
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

    const atrArr = params.stopType === 'atr' ? atr(bars, params.atrPeriod) : [];

    // 市场状态（因果：每根只用 ≤ i 的状态，带滞后）
    const er = efficiencyRatio(closes, Math.max(2, params.regimeWindow));
    const reg = regimeSeries(er, params.regimeHi, params.regimeLo);

    // 门禁：趋势市只放 trend 类信号，震荡市只放 reversion 类信号，未知状态两类都放（不空仓）
    const gate = (s: RawSignal, decIdx: number): boolean => {
      const r = reg[decIdx];
      if (r === 'unknown') return true;
      const cls = s.againstTrend ? 'reversion' : 'trend';
      return r === 'trend' ? cls === 'trend' : cls === 'reversion';
    };

    return buildIntentsFromRaw(raw, bars, params, bias, atrArr, gate);
  },
};

/** 策略注册表（后续可加反转、突破等策略） */
export const STRATEGIES: Strategy[] = [pinbarTrendStrategy, regimeSwitchStrategy];

export function getStrategy(name: string): Strategy {
  return STRATEGIES.find((s) => s.name === name) ?? pinbarTrendStrategy;
}
