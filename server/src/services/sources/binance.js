import { httpJson } from './http.js';

/**
 * 币安 K 线数据源（现货 + U 本位合约）。
 *
 * 实测（2026-10-26）：
 *  - 现货 https://api.binance.com/api/v3/klines 直连可用，无需 API key
 *  - 合约 https://fapi.binance.com/fapi/v1/klines 直连可用，无需 API key
 *
 * 响应格式（数组）：
 * [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
 */

const ENDPOINTS = {
  spot: 'https://api.binance.com/api/v3/klines',
  perp: 'https://fapi.binance.com/fapi/v1/klines',
};

const MAX_LIMIT = 1000;

/** 拉取单页 K 线 */
async function fetchPage({ symbol, interval, market, startMs, endMs, limit }) {
  const url = new URL(ENDPOINTS[market] ?? ENDPOINTS.spot);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(Math.min(limit, MAX_LIMIT)));
  if (startMs != null) url.searchParams.set('startTime', String(startMs));
  if (endMs != null) url.searchParams.set('endTime', String(endMs));

  const rows = await httpJson(url.toString(), {
    label: `binance-${market}`,
    timeoutMs: 25_000,
    retries: 2,
  });

  if (!Array.isArray(rows)) {
    throw new Error(`binance-${market} 返回格式异常: ${JSON.stringify(rows).slice(0, 200)}`);
  }

  return rows.map((r) => ({
    time: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    closeTime: Number(r[6]),
    quoteVolume: Number(r[7]),
    trades: Number(r[8]),
  }));
}

/**
 * 拉取一段区间的 K 线（自动分页）。
 *
 * ⚠ 分页方向（实测 2026-10-26）：
 *  币安的 klines 在给了 startTime 后，返回的是 **从 startTime 开始的正序** limit 根，
 *  并不是「endTime 之前的最后 limit 根」。所以必须正向推进：
 *  nextStart = 最后一根的开盘时间 + 1ms。
 *  （若按倒序翻页会永远卡在第一页，只拿到 1000 根。）
 *
 * @param {object} p
 * @param {string} p.symbol       交易所原始符号，如 BTCUSDT
 * @param {string} [p.interval]   周期，默认 1h
 * @param {'spot'|'perp'} [p.market]
 * @param {number} [p.startMs]    起始毫秒时间戳（含）
 * @param {number} [p.endMs]      结束毫秒时间戳（含）
 * @param {number} [p.maxBars]    最多拉多少根，防止一次拉爆
 * @returns {Promise<Array>} 按时间升序
 */
export async function fetchKlines({
  symbol,
  interval = '1h',
  market = 'spot',
  startMs = null,
  endMs = null,
  maxBars = 200_000,
}) {
  const out = [];
  let cursorStart = startMs;
  if (cursorStart == null) {
    cursorStart =
      endMs != null ? endMs - 30 * 24 * 3600 * 1000 : Date.now() - 30 * 24 * 3600 * 1000;
  }
  let guard = 0;

  while (out.length < maxBars && guard < 2000) {
    guard += 1;
    const page = await fetchPage({
      symbol,
      interval,
      market,
      startMs: cursorStart,
      endMs,
      limit: MAX_LIMIT,
    });

    if (page.length === 0) break;

    for (const b of page) {
      if (endMs != null && b.time > endMs) continue;
      out.push(b);
    }

    const last = page[page.length - 1].time;
    if (endMs != null && last >= endMs) break;
    if (page.length < MAX_LIMIT) break;

    // 正向翻页：从最后一根的下一点继续
    cursorStart = last + 1;
  }

  // 去重 + 升序
  const seen = new Map();
  for (const b of out) seen.set(b.time, b);
  return [...seen.values()].sort((a, b) => a.time - b.time);
}
