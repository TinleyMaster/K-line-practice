import type { Bar } from '../../types';

/** 简单移动平均（SMA）。前 period-1 根返回 NaN。 */
export function sma(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * 真实波幅 ATR（Wilder 平滑）。
 * tr = max(high-low, |high-prevClose|, |low-prevClose|)。前 period-1 根返回 NaN。
 */
export function atr(bars: Bar[], period: number): number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(NaN);
  if (n === 0 || period <= 0) return out;
  const tr = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const prevClose = i > 0 ? bars[i - 1].close : bars[i].open;
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    );
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i < period) {
      sum += tr[i];
      if (i === period - 1) out[i] = sum / period;
    } else if (Number.isFinite(out[i - 1])) {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
  }
  return out;
}

/**
 * 趋势偏置：基于"价格在慢均线上下"判断多空。
 * 返回每根 1=多头势 / -1=空头势 / 0=无（均线未就绪或价格等于均线）。
 */
export function trendBias(closes: number[], ma: number[]): number[] {
  return ma.map((m, i) => {
    if (!Number.isFinite(m)) return 0;
    if (closes[i] > m) return 1;
    if (closes[i] < m) return -1;
    return 0;
  });
}

/**
 * 效率比（Efficiency Ratio / 趋势度）：窗口内「净位移」占「总路径」的比例。
 * ER→1 表示价格几乎单向移动（强趋势）；ER→0 表示来回折返（震荡/区间）。
 * 仅用 ≤ i 的数据（closes[i-window..i]），零未来函数。
 */
export function efficiencyRatio(closes: number[], window: number): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(NaN);
  if (window <= 0) return out;
  for (let i = window; i < n; i++) {
    let path = 0;
    for (let k = i - window + 1; k <= i; k++) path += Math.abs(closes[k] - closes[k - 1]);
    const net = Math.abs(closes[i] - closes[i - window]);
    out[i] = path > 0 ? net / path : 0;
  }
  return out;
}

export type Regime = 'trend' | 'range' | 'unknown';

/**
 * 由效率比判定市场状态（带滞后 hysteresis，避免反复横跳空仓）：
 *  - ER ≥ hi → 趋势市（trend）
 *  - ER ≤ lo → 震荡市（range）
 *  - 中间带 → 保持上一根状态
 * 前向扫描，每根只用 ≤ i 的状态，零未来函数。
 */
export function regimeSeries(er: number[], hi: number, lo: number): Regime[] {
  const n = er.length;
  const out: Regime[] = new Array<Regime>(n).fill('unknown');
  let prev: Regime = 'unknown';
  for (let i = 0; i < n; i++) {
    const v = er[i];
    if (!Number.isFinite(v)) {
      out[i] = prev;
      continue;
    }
    let r: Regime;
    if (v >= hi) r = 'trend';
    else if (v <= lo) r = 'range';
    else r = prev === 'unknown' ? 'range' : prev;
    out[i] = r;
    prev = r;
  }
  return out;
}
