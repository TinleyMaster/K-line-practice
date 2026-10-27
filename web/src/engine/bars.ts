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

export function fmtTime(t: number | null | undefined): string {
  if (!t) return '—';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(t: number | null | undefined): string {
  if (!t) return '—';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
