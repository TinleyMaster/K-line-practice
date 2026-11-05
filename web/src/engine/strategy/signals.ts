import type { Bar } from '../../types';
import type { RawSignal, SeriesContext, SignalModule } from './types';

/** Pinbar 检测参数（与 klinecharts 版的 calcParams 一一对应） */
export interface PinbarParams {
  noseToBody: number; // 鼻线 ≥ noseToBody × 实体
  bodyToRange: number; // 实体 ≤ bodyToRange × 区间
  noseToRange: number; // 鼻线 ≥ noseToRange × 区间
  revPct: number; // ZigZag 反转确认阈值（价格从极值反向运行 ≥ revPct 才确认拐点）
}

/**
 * 纯 TS 版 Pinbar 拐点检测（与 trendIndicator.ts 的 PINBAR 指标同算法，但脱离 klinecharts）。
 *
 * 两步：
 *   1) 逐根判定 pinbar 候选方向（长下影=看涨候选 / 长上影=看跌候选，实体过大或鼻线不够长则否）；
 *   2) ZigZag 反转确认：只有当价格从某根极值反向运行 ≥ revPct 才确认其为拐点
 *      （摆动高点 / 摆动低点）。只有被确认的拐点处的对应方向 pinbar 才发出信号——
 *      趋势半山腰的回调、震荡区间内部的小波动都不会形成信号，只认真转折。
 *
 * ⚠️ 拐点需"反转确认"后才出现（滞后若干根）；引擎在信号根「下一根开盘」入场，
 * 等价于"看到反转确认后再进场"，不会泄漏未来。
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

  // 第二遍：ZigZag 拐点检测（反转确认）
  const isHigh = new Array<boolean>(n).fill(false);
  const isLow = new Array<boolean>(n).fill(false);
  if (n > 0) {
    let dir0 = 0; // 0 未定 / 1 上行腿(跟踪高点) / -1 下行腿(跟踪低点)
    let extHigh = highArr[0];
    let extHighI = 0;
    let extLow = lowArr[0];
    let extLowI = 0;
    for (let i = 1; i < n; i++) {
      if (dir0 === 0) {
        if (highArr[i] >= extLow * (1 + p.revPct)) {
          isLow[extLowI] = true;
          dir0 = 1;
          extHigh = highArr[i];
          extHighI = i;
        } else if (lowArr[i] <= extHigh * (1 - p.revPct)) {
          isHigh[extHighI] = true;
          dir0 = -1;
          extLow = lowArr[i];
          extLowI = i;
        } else {
          if (highArr[i] > extHigh) {
            extHigh = highArr[i];
            extHighI = i;
          }
          if (lowArr[i] < extLow) {
            extLow = lowArr[i];
            extLowI = i;
          }
        }
      } else if (dir0 === 1) {
        if (highArr[i] > extHigh) {
          extHigh = highArr[i];
          extHighI = i;
        }
        if (lowArr[i] <= extHigh * (1 - p.revPct)) {
          isHigh[extHighI] = true;
          dir0 = -1;
          extLow = lowArr[i];
          extLowI = i;
        }
      } else {
        if (lowArr[i] < extLow) {
          extLow = lowArr[i];
          extLowI = i;
        }
        if (highArr[i] >= extLow * (1 + p.revPct)) {
          isLow[extLowI] = true;
          dir0 = 1;
          extHigh = highArr[i];
          extHighI = i;
        }
      }
    }
  }

  // 只在确认的拐点处发出信号，并把自然止损位带出去
  const out: RawSignal[] = [];
  for (let i = 0; i < n; i++) {
    if (dir[i] === 1 && isLow[i]) {
      out.push({
        index: i,
        time: bars[i].time,
        side: 'bull',
        price: bars[i].close,
        module: 'pinbar',
        strength: 1,
        stopPrice: lowArr[i],
      });
    } else if (dir[i] === -1 && isHigh[i]) {
      out.push({
        index: i,
        time: bars[i].time,
        side: 'bear',
        price: bars[i].close,
        module: 'pinbar',
        strength: 1,
        stopPrice: highArr[i],
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
      revPct: 0.01,
    });
  },
};

/** 注册表：所有可插拔信号模块。后续加 MA 金叉、布林收窄等，直接 push 即可。 */
export const SIGNAL_MODULES: SignalModule[] = [pinbarSignal];

export function getSignalModule(name: string): SignalModule | undefined {
  return SIGNAL_MODULES.find((m) => m.name === name);
}
