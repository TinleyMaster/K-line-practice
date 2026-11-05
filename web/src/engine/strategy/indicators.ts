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
