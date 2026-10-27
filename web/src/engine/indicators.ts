/**
 * 技术指标注册表
 *
 * klinecharts v10 内置 27 个指标，无需自己写公式 —— 全部白嫖。
 * 本模块只负责：
 *   1. 声明每个指标的注册名（klinecharts 的 name）
 *   2. 分类：叠加在主图（candle_pane）还是独立副图（自动新建 pane）
 *   3. 默认参数、默认启用状态、中文标签
 *
 * 分 pane 的规则（来自 klinecharts 源码 createIndicator）：
 *   - 传 paneId = 'candle_pane' → 画在 K 线主图上
 *   - 不传 paneId             → 自动创建一个新的独立副图 pane
 */

export type IndicatorGroup = 'overlay' | 'pane';

export interface IndicatorSpec {
  /** klinecharts 注册名，必须与内置指标一致 */
  name: string;
  /** 中文标签 */
  label: string;
  group: IndicatorGroup;
  /** 默认计算参数 */
  calcParams: number[];
  /** 默认是否启用 */
  defaultOn: boolean;
  /** 副图高度权重（0.26 ~ 0.34），仅 group='pane' 有效 */
  weight?: number;
}

/**
 * 主图叠加类：线条/通道画在蜡烛图上，不额外占高度。
 * 4h 看趋势最常用的是慢均线 + 布林带。
 */
const OVERLAY: IndicatorSpec[] = [
  { name: 'MA', label: 'MA 均线', group: 'overlay', calcParams: [20, 60], defaultOn: true },
  { name: 'EMA', label: 'EMA 指数均线', group: 'overlay', calcParams: [12, 26], defaultOn: false },
  { name: 'SMA', label: 'SMA 简单均线', group: 'overlay', calcParams: [5, 10], defaultOn: false },
  { name: 'BOLL', label: 'BOLL 布林带', group: 'overlay', calcParams: [20, 2], defaultOn: false },
  { name: 'DMA', label: 'DMA 差离均线', group: 'overlay', calcParams: [10, 50, 30], defaultOn: false },
  { name: 'AVP', label: 'AVP 均价线', group: 'overlay', calcParams: [], defaultOn: false },
  { name: 'BBI', label: 'BBI 多空线', group: 'overlay', calcParams: [], defaultOn: false },
  { name: 'SAR', label: 'SAR 抛物线', group: 'overlay', calcParams: [], defaultOn: false },
  { name: 'TRIX', label: 'TRIX 三重指数', group: 'overlay', calcParams: [12], defaultOn: false },
  { name: 'BIAS', label: 'BIAS 乖离率', group: 'overlay', calcParams: [6, 12, 24], defaultOn: false },
];

/**
 * 独立副图类：自带一个窗格，数值型指标（RSI/MACD/KDJ…）与量能型（VOL/OBV…）。
 * 常驻上限 2 个（UI 层限制），其余走浮层。
 */
const PANE: IndicatorSpec[] = [
  { name: 'VOL', label: 'VOL 成交量', group: 'pane', calcParams: [], defaultOn: true, weight: 0.26 },
  { name: 'RSI', label: 'RSI 相对强弱', group: 'pane', calcParams: [6, 12, 24], defaultOn: false, weight: 0.3 },
  { name: 'MACD', label: 'MACD 异同移动', group: 'pane', calcParams: [12, 26, 9], defaultOn: false, weight: 0.32 },
  { name: 'KDJ', label: 'KDJ 随机指标', group: 'pane', calcParams: [9, 3, 3], defaultOn: false, weight: 0.3 },
  { name: 'CCI', label: 'CCI 顺势指标', group: 'pane', calcParams: [14], defaultOn: false, weight: 0.28 },
  { name: 'WR', label: 'WR 威廉指标', group: 'pane', calcParams: [10, 6], defaultOn: false, weight: 0.28 },
  { name: 'VR', label: 'VR 成交量比率', group: 'pane', calcParams: [26, 12], defaultOn: false, weight: 0.28 },
  { name: 'PSY', label: 'PSY 心理线', group: 'pane', calcParams: [12, 6], defaultOn: false, weight: 0.26 },
  { name: 'ROC', label: 'ROC 变动率', group: 'pane', calcParams: [12, 6, 3], defaultOn: false, weight: 0.28 },
  { name: 'OBV', label: 'OBV 能量潮', group: 'pane', calcParams: [], defaultOn: false, weight: 0.28 },
  { name: 'BRAR', label: 'BRAR 情绪指标', group: 'pane', calcParams: [], defaultOn: false, weight: 0.28 },
  { name: 'CR', label: 'CR 能量线', group: 'pane', calcParams: [26, 10], defaultOn: false, weight: 0.28 },
  { name: 'DMI', label: 'DMI 趋向指标', group: 'pane', calcParams: [14, 6], defaultOn: false, weight: 0.3 },
  { name: 'EMV', label: 'EMV 简易波动', group: 'pane', calcParams: [14, 9], defaultOn: false, weight: 0.26 },
  { name: 'MTM', label: 'MTM 动量指标', group: 'pane', calcParams: [12, 6], defaultOn: false, weight: 0.26 },
  { name: 'PVT', label: 'PVT 价量趋势', group: 'pane', calcParams: [], defaultOn: false, weight: 0.26 },
  { name: 'AO', label: 'AO awesome 振荡', group: 'pane', calcParams: [], defaultOn: false, weight: 0.28 },
  { name: 'TRIX', label: 'TRIX 三重指数(副图)', group: 'pane', calcParams: [12], defaultOn: false, weight: 0.26 },
  { name: 'BIAS', label: 'BIAS 乖离率(副图)', group: 'pane', calcParams: [6, 12, 24], defaultOn: false, weight: 0.26 },
];

export const ALL_INDICATORS: IndicatorSpec[] = [...OVERLAY, ...PANE];

const BY_NAME = new Map(ALL_INDICATORS.map((i) => [i.name, i]));

export function getIndicatorSpec(name: string): IndicatorSpec | undefined {
  return BY_NAME.get(name);
}

/** 4h 周期默认：MA(20,60) + VOL —— 与 v1 行为一致 */
export const DEFAULT_4H: string[] = ['MA', 'VOL'];

/** 1h 周期默认：MA(5,20,60) + VOL —— 与 v1 行为一致 */
export const DEFAULT_1H: string[] = ['MA', 'VOL'];

/** 一个周期下允许同时常驻的独立副图数量上限 */
export const MAX_RESIDENT_PANES = 4;

/**
 * 校验并规整一份指标选择配置。
 * - 剔除未知指标名
 * - 独立副图超过上限时，保留靠前的（用户选择顺序 = 优先级）
 * - 同一指标不重复
 */
export function normalizeSelection(names: string[]): string[] {
  const seen = new Set<string>();
  const overlay: string[] = [];
  const panes: string[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    const spec = BY_NAME.get(n);
    if (!spec) continue;
    seen.add(n);
    if (spec.group === 'overlay') overlay.push(n);
    else if (panes.length < MAX_RESIDENT_PANES) panes.push(n);
  }
  return [...overlay, ...panes];
}

/** 拆成主图叠加 / 独立副图两组 */
export function splitByGroup(names: string[]): { overlay: IndicatorSpec[]; panes: IndicatorSpec[] } {
  const overlay: IndicatorSpec[] = [];
  const panes: IndicatorSpec[] = [];
  for (const n of names) {
    const spec = BY_NAME.get(n);
    if (!spec) continue;
    if (spec.group === 'overlay') overlay.push(spec);
    else panes.push(spec);
  }
  return { overlay, panes };
}
