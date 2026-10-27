/**
 * 显示格式化（币安风格）
 *
 * 币安的行情行习惯用「紧凑数字」（1.23K / 4.56M / 7.89B），
 * 涨跌一律带符号，颜色由 CSS 决定（红涨绿跌）。
 */

/** 紧凑数字：1.23K / 4.56M / 7.89B */
export function fmtCompact(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(digits)}K`;
  if (abs >= 1) return v.toFixed(digits);
  return v.toFixed(4);
}

/** 带符号百分比：+1.23% / -0.45% */
export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

/** 带符号数字：+123.45 / -0.67 */
export function fmtSigned(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
}

/** 涨跌方向：1 涨 / -1 跌 / 0 平 */
export function dir(v: number | null | undefined): 1 | -1 | 0 {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return 0;
  return v > 0 ? 1 : -1;
}
