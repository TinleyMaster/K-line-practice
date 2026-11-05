import type { Bar } from '../../types';
import {
  runBacktest,
  type BacktestResult,
  type BacktestStats,
  type SeriesContext,
  type Strategy,
  type StrategyParams,
} from './index';

export interface MultiSymbolSpec {
  bars: Bar[];
  ctx: SeriesContext;
}

/** 空统计，用于历史不足的标的占位 */
export function emptyStats(): BacktestStats {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalR: 0,
    avgR: 0,
    expectancy: 0,
    maxDrawdown: 0,
    profitFactor: null,
    grossProfit: 0,
    grossLoss: 0,
    avgHoldBars: 0,
  };
}

/**
 * 把多个标的的统计合并成一个"组合视角"：
 * - 总 R / 胜率 / 盈亏比 由合并的交易精确计算（R 按风险归一，可跨标的相加）；
 * - 最大回撤取各标的交易数加权平均（不同标的独立账户，不宜直接拼接权益曲线）。
 */
export function combineStats(list: BacktestStats[]): BacktestStats {
  const trades = list.reduce((s, x) => s + x.trades, 0);
  if (trades === 0) return emptyStats();
  const wins = list.reduce((s, x) => s + x.wins, 0);
  const losses = trades - wins;
  const totalR = list.reduce((s, x) => s + x.totalR, 0);
  const avgR = totalR / trades;
  const grossProfit = list.reduce((s, x) => s + x.grossProfit, 0);
  const grossLoss = list.reduce((s, x) => s + x.grossLoss, 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null;
  const avgHoldBars =
    trades > 0
      ? list.reduce((s, x) => s + x.avgHoldBars * x.trades, 0) / trades
      : 0;
  const maxDrawdown =
    trades > 0 ? list.reduce((s, x) => s + x.maxDrawdown * x.trades, 0) / trades : 0;
  return {
    trades,
    wins,
    losses,
    winRate: wins / trades,
    totalR,
    avgR,
    expectancy: avgR,
    maxDrawdown,
    profitFactor,
    grossProfit,
    grossLoss,
    avgHoldBars,
  };
}

/** 按训练比例把序列切成 训练段 / 测试段（靠前为训练，靠后为样本外） */
export function splitTrainTest(bars: Bar[], trainFrac = 0.6): { train: Bar[]; test: Bar[] } {
  const k = Math.max(2, Math.floor(bars.length * trainFrac));
  return { train: bars.slice(0, k), test: bars.slice(k) };
}

export interface SymbolRow {
  symbol: string;
  market: string;
  period: string;
  full: BacktestStats;
  train?: BacktestStats;
  test?: BacktestStats;
  skipped?: string;
}

export interface MultiResult {
  rows: SymbolRow[];
  aggregate: BacktestStats;
  aggregateTrain?: BacktestStats;
  aggregateTest?: BacktestStats;
  split: boolean;
}

/**
 * 多标的批量回测（可选样本外切分）。
 * 同一套参数跑在一组标的上，产出每标的统计 + 组合聚合。
 * split=true 时，每个标的再切成 前60%训练 / 后40%测试，
 * 用相同参数跑两段——若训练段大赚、测试段亏损，即提示过拟合 / 样本内幸运。
 */
export function runMultiBacktest(
  specs: MultiSymbolSpec[],
  strategy: Strategy,
  params: StrategyParams,
  opts: { split?: boolean; trainFrac?: number } = {},
): MultiResult {
  const rows: SymbolRow[] = [];
  const allFull: BacktestStats[] = [];
  const allTrain: BacktestStats[] = [];
  const allTest: BacktestStats[] = [];

  for (const spec of specs) {
    if (!spec.bars || spec.bars.length < params.trendPeriod + 10) {
      rows.push({
        symbol: spec.ctx.symbol,
        market: spec.ctx.market,
        period: spec.ctx.period,
        full: emptyStats(),
        skipped: `历史不足（${spec.bars?.length ?? 0} 根）`,
      });
      continue;
    }

    const fullRes: BacktestResult = runBacktest(spec.bars, strategy, params, spec.ctx);
    const row: SymbolRow = {
      symbol: spec.ctx.symbol,
      market: spec.ctx.market,
      period: spec.ctx.period,
      full: fullRes.stats,
    };
    allFull.push(fullRes.stats);

    if (opts.split) {
      const { train, test } = splitTrainTest(spec.bars, opts.trainFrac ?? 0.6);
      const tRes = runBacktest(train, strategy, params, spec.ctx);
      const eRes = runBacktest(test, strategy, params, spec.ctx);
      row.train = tRes.stats;
      row.test = eRes.stats;
      allTrain.push(tRes.stats);
      allTest.push(eRes.stats);
    }
    rows.push(row);
  }

  return {
    rows,
    aggregate: combineStats(allFull),
    aggregateTrain: opts.split ? combineStats(allTrain) : undefined,
    aggregateTest: opts.split ? combineStats(allTest) : undefined,
    split: !!opts.split,
  };
}

/** 参数扫描的一维范围（只包含 StrategyParams 里可调的字段） */
export interface ParamRange {
  key: 'takeProfitR' | 'trendPeriod' | 'riskPct' | 'atrMult' | 'trendEnabled';
  values: Array<number | boolean>;
}

export interface SweepRow {
  params: StrategyParams;
  stats: BacktestStats;
}

/**
 * 参数敏感度扫描：对给定维度的取值做笛卡尔积，逐组回测，按总 R 降序返回。
 * 用来观察"策略对参数是否敏感"——若总 R 在某个维度上剧烈跳动，说明策略脆弱、
 * 当前样本上的"好参数"可能只是过拟合；若各组合都稳定为正，edge 更可信。
 */
export function sweepParams(
  bars: Bar[],
  ctx: SeriesContext,
  strategy: Strategy,
  base: StrategyParams,
  ranges: ParamRange[],
  maxCombos = 80,
): SweepRow[] {
  // 笛卡尔积
  let combos: Record<string, number | boolean>[] = [{}];
  for (const r of ranges) {
    const next: Record<string, number | boolean>[] = [];
    for (const c of combos) {
      for (const v of r.values) {
        next.push({ ...c, [r.key]: v });
      }
    }
    combos = next;
    if (combos.length > maxCombos) break;
  }

  const rows: SweepRow[] = [];
  for (const c of combos) {
    const params: StrategyParams = { ...base, ...(c as Partial<StrategyParams>) };
    const res = runBacktest(bars, strategy, params, ctx);
    rows.push({ params, stats: res.stats });
  }
  rows.sort((a, b) => b.stats.totalR - a.stats.totalR);
  return rows;
}
