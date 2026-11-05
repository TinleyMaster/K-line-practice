import type { Bar } from '../../types';
import { atr, sma } from './indicators';
import type { RawSignal, SeriesContext, SignalModule } from './types';

/**
 * 因果摆动点：返回每个严格的摆动低/高点，及其「确认根」(j+W)。
 * 站在确认根 i 回看窗口 [i-2W, i]，中点 j=i-W 若严格是极值则确认——确认只用 ≤ i 数据，零未来函数。
 */
export function causalSwings(
  bars: Bar[],
  W: number,
): { lows: { index: number; confirmIndex: number }[]; highs: { index: number; confirmIndex: number }[] } {
  const n = bars.length;
  const lowArr = bars.map((b) => b.low);
  const highArr = bars.map((b) => b.high);
  const Ww = Math.max(1, Math.floor(W));
  const lows: { index: number; confirmIndex: number }[] = [];
  const highs: { index: number; confirmIndex: number }[] = [];
  for (let i = Ww; i < n - Ww; i++) {
    const j = i - Ww;
    let isLow = true;
    let isHigh = true;
    for (let k = j - Ww; k <= j + Ww; k++) {
      if (k < 0 || k >= n || k === j) continue;
      if (lowArr[k] <= lowArr[j]) isLow = false; // j 必须严格最低
      if (highArr[k] >= highArr[j]) isHigh = false; // j 必须严格最高
    }
    if (isLow) lows.push({ index: j, confirmIndex: i });
    if (isHigh) highs.push({ index: j, confirmIndex: i });
  }
  return { lows, highs };
}

/**
 * Pinbar 检测参数。
 * swingWindow（默认 5）是「因果摆动确认」的窗口半径：一根 K 线要被确认是摆动拐点，
 * 必须等它之后 swingWindow 根内不再出现更极端的价（即它在 [j-W, j+W] 仍是极值）。
 * 这保证**确认只使用过去数据**——拐点 j 在 j+W 根才被"声明"，入场在 j+W+1，零未来函数。
 */
export interface PinbarParams {
  noseToBody: number; // 鼻线 ≥ noseToBody × 实体
  bodyToRange: number; // 实体 ≤ bodyToRange × 区间
  noseToRange: number; // 鼻线 ≥ noseToRange × 区间
  swingWindow: number; // 摆动确认窗口半径（因果：j 在 [j-W, j+W] 仍为极值才确认）
}

/**
 * 纯 TS 版 Pinbar 拐点检测（脱离 klinecharts，供自动交易引擎使用）。
 *
 * 两步：
 *   1) 逐根判定 pinbar 候选方向（长下影=看涨候选 / 长上影=看跌候选，实体过大或鼻线不够长则否）；
 *   2) **因果摆动确认**：一根 K 线 j 要成为摆动拐点，必须在它之后 W 根内（[j-W, j+W] 窗口）
 *      仍是区间极值——窗口内的极值要么就是 j 本身，要么更早/更晚都不会更极端。
 *      我们在「确认根 i = j+W」才声明这个拐点（此时窗口 [i-2W, i] 全在 j+W 之前，纯过去数据），
 *      策略在 i+1 = j+W+1 开盘入场。因此**任何入场决策都不依赖未来**，无未来函数。
 *      只有被确认的拐点处的对应方向 pinbar 才发信号——趋势半山腰、震荡内部的 K 线不会形成信号。
 */
export function detectPinbars(bars: Bar[], p: PinbarParams): RawSignal[] {
  const n = bars.length;
  const highArr = new Array<number>(n);
  const lowArr = new Array<number>(n);
  // dir[i]: 1=看涨候选（长下影） / -1=看跌候选（长上影） / 0=非 pinbar
  const dir = new Array<number>(n).fill(0);

  // 第一遍：逐根判定 pinbar 候选方向
  for (let i = 0; i < n; i++) {
    const k = bars[i];
    const o = k.open;
    const h = k.high;
    const l = k.low;
    const c = k.close;
    highArr[i] = h;
    lowArr[i] = l;
    const range = h - l;
    const body = Math.abs(c - o);
    const upperWick = h - Math.max(o, c);
    const lowerWick = Math.min(o, c) - l;
    if (!(range > 0)) continue;
    if (body > p.bodyToRange * range) continue;
    const nose = Math.max(upperWick, lowerWick);
    if (nose < p.noseToBody * body) continue;
    if (nose < p.noseToRange * range) continue;
    dir[i] = lowerWick > upperWick ? 1 : -1;
  }

  // 第二遍：**因果摆动确认**（无未来函数）。
  // 站在「确认根 i」回看窗口 [i-2W, i]：若其中点 j = i-W 是严格极值（高低都未被窗口内其他根超越），
  // 则 j 是一个摆动拐点——且确认只用到了 ≤ i 的数据，入场在 i+1 = j+W+1，纯因果。
  // 摆动高点只发看跌信号、摆动低点只发看涨信号；方向必须与 pinbar 候选一致才发。
  const W = Math.max(1, Math.floor(p.swingWindow));
  const out: RawSignal[] = [];

  for (let i = W; i < n - W; i++) {
    const j = i - W; // 待确认的拐点候选
    let isLow = true;
    let isHigh = true;
    for (let k = j - W; k <= j + W; k++) {
      if (k < 0 || k >= n || k === j) continue;
      if (lowArr[k] <= lowArr[j]) isLow = false; // j 必须严格最低
      if (highArr[k] >= highArr[j]) isHigh = false; // j 必须严格最高
    }
    if (dir[j] === 1 && isLow) {
      out.push({
        index: j,
        confirmIndex: i,
        time: bars[j].time,
        side: 'bull',
        price: bars[j].close,
        module: 'pinbar',
        strength: 1,
        stopPrice: lowArr[j],
      });
    } else if (dir[j] === -1 && isHigh) {
      out.push({
        index: j,
        confirmIndex: i,
        time: bars[j].time,
        side: 'bear',
        price: bars[j].close,
        module: 'pinbar',
        strength: 1,
        stopPrice: highArr[j],
      });
    }
  }

  return out;
}

/** Pinbar 拐点信号模块 */
export const pinbarSignal: SignalModule = {
  name: 'pinbar',
  label: 'Pinbar 拐点',
  description: '仅在 ZigZag 确认的真正转折点处的 Pinbar 发出信号：长下影=看涨、长上影=看跌。',
  detect(bars: Bar[], _ctx: SeriesContext): RawSignal[] {
    return detectPinbars(bars, {
      noseToBody: 2,
      bodyToRange: 0.33,
      noseToRange: 0.6,
      swingWindow: 5,
    });
  },
};

/**
 * 趋势回调信号：在摆动低点（高点）处顺势接单——本质是"回调入场"的 continuation 套路。
 * 本身不内嵌趋势判断，方向由策略的「仅顺势」过滤把关（多头势只接摆动低点多、空头势只接摆动高点空），
 * 因此与策略共用同一套 trendPeriod/MA，不会口径漂移。止损取摆动极值外推缓冲。
 */
export function detectTrendPullback(bars: Bar[], p: { swingWindow: number }): RawSignal[] {
  const { lows, highs } = causalSwings(bars, p.swingWindow);
  const out: RawSignal[] = [];
  for (const lo of lows) {
    out.push({
      index: lo.index,
      confirmIndex: lo.confirmIndex,
      time: bars[lo.index].time,
      side: 'bull',
      price: bars[lo.index].close,
      module: 'trend_pullback',
      strength: 1,
      stopPrice: bars[lo.index].low,
    });
  }
  for (const hi of highs) {
    out.push({
      index: hi.index,
      confirmIndex: hi.confirmIndex,
      time: bars[hi.index].time,
      side: 'bear',
      price: bars[hi.index].close,
      module: 'trend_pullback',
      strength: 1,
      stopPrice: bars[hi.index].high,
    });
  }
  return out;
}

/** 趋势回调信号模块 */
export const trendPullbackSignal: SignalModule = {
  name: 'trend_pullback',
  label: '趋势回调',
  description: '在摆动低点/高点处顺势接单（回调入场）。配合「趋势翻转离场」让利润随趋势奔跑。',
  detect(bars: Bar[], _ctx: SeriesContext): RawSignal[] {
    return detectTrendPullback(bars, { swingWindow: 5 });
  },
};

/** 滚动标准差（窗口 period，前 period-1 根返回 NaN）。 */
function rollingStd(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 1) return out;
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += values[k];
    const mean = sum / period;
    let sq = 0;
    for (let k = i - period + 1; k <= i; k++) sq += (values[k] - mean) ** 2;
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

/**
 * 区间均值回归信号：价格相对均线的偏离用「z 分数 = (close - SMA) / 滚动标准差」衡量。
 * - 当 z ≤ -entryZ（价格被压到均值下方 entryZ 个标准差）→ 超卖，发多（赌回归均值）；
 * - 当 z ≥ +entryZ（价格被推到均值上方）→ 超买，发空。
 * 全部基于 ≤ i 的数据（close/SMA/std 都是因果的）；入场在 i+1 开盘，零未来函数。
 * 止损取 entry ∓ atrMult×ATR（模块自带，独立于全局 stopType 也能用）；目标价位=回归均值（targetPrice）。
 * 这是与「趋势跟踪」互补的 edge 类：趋势策略在震荡市亏的钱，均值回归在震荡市赚。
 */
export function detectMeanReversion(
  bars: Bar[],
  p: { meanPeriod: number; atrPeriod: number; entryZ: number; atrMult: number; cooldown: number },
): RawSignal[] {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const ma = sma(closes, p.meanPeriod);
  const std = rollingStd(closes, p.meanPeriod);
  const a = atr(bars, p.atrPeriod);
  const out: RawSignal[] = [];
  let lastBull = -1e9;
  let lastBear = -1e9;
  for (let i = p.meanPeriod; i < n; i++) {
    const m = ma[i];
    const s = std[i];
    const atrV = a[i];
    if (!Number.isFinite(m) || !Number.isFinite(s) || s <= 0 || !Number.isFinite(atrV) || atrV <= 0) {
      continue;
    }
    const z = (closes[i] - m) / s;
    if (z <= -p.entryZ && i - lastBull >= p.cooldown) {
      lastBull = i;
      out.push({
        index: i,
        confirmIndex: i,
        time: bars[i].time,
        side: 'bull',
        price: closes[i],
        module: 'mean_reversion',
        strength: Math.min(1, -z / (p.entryZ * 2)),
        stopPrice: closes[i] - p.atrMult * atrV, // 自带 ATR 止损，逆势单需给足缓冲
        targetPrice: m, // 回归均值
        againstTrend: true,
      });
    } else if (z >= p.entryZ && i - lastBear >= p.cooldown) {
      lastBear = i;
      out.push({
        index: i,
        confirmIndex: i,
        time: bars[i].time,
        side: 'bear',
        price: closes[i],
        module: 'mean_reversion',
        strength: Math.min(1, z / (p.entryZ * 2)),
        stopPrice: closes[i] + p.atrMult * atrV,
        targetPrice: m,
        againstTrend: true,
      });
    }
  }
  return out;
}

/** 区间均值回归信号模块 */
export const meanReversionSignal: SignalModule = {
  name: 'mean_reversion',
  label: '区间均值回归',
  description:
    '价格偏离均值达 entryZ 个标准差时反向开仓，赌回归均值（震荡市赚钱的逻辑，与趋势跟踪互补）。自带 ATR 止损与目标=均值。',
  detect(bars: Bar[], _ctx: SeriesContext): RawSignal[] {
    return detectMeanReversion(bars, {
      meanPeriod: 20,
      atrPeriod: 20,
      entryZ: 2,
      atrMult: 2,
      cooldown: 10,
    });
  },
};

/** 注册表：所有可插拔信号模块。后续加 MA 金叉、布林收窄等，直接 push 即可。 */
export const SIGNAL_MODULES: SignalModule[] = [pinbarSignal, trendPullbackSignal, meanReversionSignal];

export function getSignalModule(name: string): SignalModule | undefined {
  return SIGNAL_MODULES.find((m) => m.name === name);
}
