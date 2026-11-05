import type { Bar } from '../../types';
import type { RawSignal, SeriesContext, SignalModule } from './types';

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

/** 注册表：所有可插拔信号模块。后续加 MA 金叉、布林收窄等，直接 push 即可。 */
export const SIGNAL_MODULES: SignalModule[] = [pinbarSignal];

export function getSignalModule(name: string): SignalModule | undefined {
  return SIGNAL_MODULES.find((m) => m.name === name);
}
