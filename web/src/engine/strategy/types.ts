import type { Bar, ChartPeriod, Market, TradeSide } from '../../types';

/** 标的 + 周期上下文，随信号/策略一起传递 */
export interface SeriesContext {
  symbol: string;
  market: Market;
  period: ChartPeriod;
}

/* ============================================================
 * 第一层：信号（Signal）—— 只负责"发现值得关注的形态"，不含任何交易决策。
 * 设计为可插拔：每个信号模块独立实现 detect()，引擎按开关启用。
 * ============================================================ */

/** 原始信号事件（未经过滤 / 决策） */
export interface RawSignal {
  index: number; // 该信号在 bars 中的下标
  time: number; // bars[index].time（epoch ms）
  side: 'bull' | 'bear'; // bull=看多反转 / bear=看空反转
  price: number; // 参考价（信号根收盘或鼻线价）
  module: string; // 产生它的信号模块名
  strength: number; // 0~1 强度（预留给排序 / 过滤）
  stopPrice: number; // 自然止损位（如 pinbar 鼻线外侧）
}

/** 信号模块接口：纯函数，不依赖 klinecharts */
export interface SignalModule {
  name: string;
  label: string;
  description: string;
  detect(bars: Bar[], ctx: SeriesContext): RawSignal[];
}

/* ============================================================
 * 第二层：策略（Strategy）—— 把信号 + 趋势过滤 + 仓位规则
 * 组合成"具体的开仓意图"（方向 / 入场 / 止损 / 止盈 / 风险）。
 * ============================================================ */

export interface StrategyParams {
  /** 启用的信号模块（名字 -> 是否启用），可插拔 */
  signals: Record<string, boolean>;
  /** 趋势过滤：是否启用 */
  trendEnabled: boolean;
  /** 趋势均线周期（慢线，默认 60） */
  trendPeriod: number;
  /** 顺势交易：仅允许与趋势同向的信号入场（多只在多头势、空只在空头势） */
  requireTrendAligned: boolean;
  /** 止损方式：signal=用信号自然止损（如 pinbar 鼻线）；atr=ATR 倍数 */
  stopType: 'signal' | 'atr';
  atrPeriod: number;
  atrMult: number;
  /** 止盈倍数（R）：target = entry ± takeProfitR × 风险距离 */
  takeProfitR: number;
  /** 单笔风险占权益比（%） */
  riskPct: number;
  /** 同时持仓上限（通常 1） */
  maxConcurrent: number;
  /** 起始权益（U） */
  startEquity: number;
  /** 单边手续费率（小数，0.0004 = 4bp） */
  feeRate: number;
  /** 滑点（基点，1bp = 0.01%） */
  slippageBps: number;
}

/** 策略产出的开仓意图（还没真正成交） */
export interface TradeIntent {
  index: number; // 入场根下标（信号根下一根开盘）
  time: number;
  side: TradeSide;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  riskPct: number;
  signal: string; // 触发它的信号模块名
  strength: number;
}

export interface Strategy {
  name: string;
  label: string;
  description: string;
  detectIntents(bars: Bar[], params: StrategyParams, ctx: SeriesContext): TradeIntent[];
}

/* ============================================================
 * 第三层：执行器（Executor）—— 把意图按时间顺序模拟成交、
 * 管理持仓与出场，产出成交明细 + 权益曲线。
 * 先做 SimExecutor（模拟盘）；实盘 LiveExecutor 是后续阶段的桩。
 * ============================================================ */

export interface SimTrade {
  id: string;
  symbol: string;
  side: TradeSide;
  signal: string;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  exitIndex: number;
  exitTime: number;
  exitPrice: number;
  exitReason: 'stop' | 'target' | 'session_end';
  qty: number;
  riskAmount: number;
  pnl: number;
  rMultiple: number;
  equityAfter: number;
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  avgR: number;
  expectancy: number; // 每笔期望 R
  maxDrawdown: number; // 权益峰值回撤（小数）
  profitFactor: number | null; // 总盈利 / 总亏损
  grossProfit: number; // 总盈利（U，用于精确聚合盈亏比）
  grossLoss: number; // 总亏损（U）
  avgHoldBars: number;
}

export interface BacktestResult {
  trades: SimTrade[];
  equityCurve: { time: number; equity: number }[];
  stats: BacktestStats;
  params: StrategyParams;
  /** 回测覆盖的 K 线数（用于提示样本量） */
  bars: number;
}
