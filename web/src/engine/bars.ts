import type { Bar } from '../types';

export const HOUR = 3600_000;
export const FOUR_HOURS = 4 * HOUR;

/**
 * 由 1h 聚合派生 4h（与后端 server/src/services/klineService.js 的 derive4h 保持一致）。
 * 桶起点 = floor(epoch / 4h) * 4h，UTC 对齐。
 */
export function derive4h(bars1h: Bar[]): Bar[] {
  if (!bars1h.length) return [];
  const out: Bar[] = [];
  let cur: Bar | null = null;

  for (const b of bars1h) {
    const bucketStart = Math.floor(b.time / FOUR_HOURS) * FOUR_HOURS;
    if (!cur || cur.time !== bucketStart) {
      if (cur) out.push(cur);
      cur = {
        symbol: b.symbol,
        time: bucketStart,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: 0,
        quoteVolume: 0,
        trades: 0,
        constituents: 0,
      };
    }
    cur.high = Math.max(cur.high, b.high);
    cur.low = Math.min(cur.low, b.low);
    cur.close = b.close;
    cur.volume += b.volume;
    cur.quoteVolume += b.quoteVolume;
    cur.trades += b.trades;
    cur.constituents = (cur.constituents ?? 0) + 1;
  }
  if (cur) out.push(cur);
  return out;
}

/** 已揭示区间内「当前形成中」的 4h 蜡烛（最后一桶），没有则 null */
export function forming4h(revealed1h: Bar[]): Bar | null {
  if (!revealed1h.length) return null;
  const all = derive4h(revealed1h);
  return all.length ? all[all.length - 1] : null;
}

/** 取已揭示切片（含 index） */
export function sliceRevealed(bars: Bar[], cursor: number): Bar[] {
  if (cursor < 0) return [];
  return bars.slice(0, cursor + 1);
}

/**
 * ATR（平均真实波幅）。
 *
 * klinecharts 没有内置 ATR 指标，但「按 ATR 设止损」是实战里最常用的止损方式之一
 * —— 比固定百分比更贴合波动率（BTC 波动大的时候 1% 是噪音，ETH 平稳的时候 1% 又太宽）。
 *
 * 公式：TR = max(H-L, |H-prevC|, |L-prevC|)；ATR = TR 的 N 周期 Wilder 平滑。
 *
 * @param bars  1h K 线（升序）
 * @param period ATR 周期，默认 14
 * @returns 最后一根对应的 ATR；数据不足返回 0
 */
export function atr(bars: Bar[], period = 14): number {
  if (!bars || bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose),
    );
    trs.push(tr);
  }
  if (trs.length < period) return 0;
  // Wilder 平滑：前 period 个取均值，之后递推
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let prev = sum / period;
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
  }
  return prev;
}

/** 价格有效位（用于显示与输入框步进） */
export function pricePrecision(price: number): number {
  if (!Number.isFinite(price) || price === 0) return 2;
  if (price >= 10000) return 1;
  if (price >= 1000) return 2;
  if (price >= 10) return 3;
  if (price >= 1) return 4;
  return 6;
}

export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const p = pricePrecision(v);
  return v.toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p });
}

export function fmtTime(t: number | string | null | undefined): string {
  if (t === null || t === undefined || t === '') return '—';
  // 后端返回的时间是 ISO 字符串，前端本地计算的是 epoch ms —— 两种都收
  const ms = typeof t === 'string' ? Date.parse(t) : t;
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(t: number | string | null | undefined): string {
  if (t === null || t === undefined || t === '') return '—';
  const ms = typeof t === 'string' ? Date.parse(t) : t;
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
