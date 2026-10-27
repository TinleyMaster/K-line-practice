import { httpJson } from './http.js';

/**
 * GeckoTerminal 链上 OHLCV 数据源（免费、免鉴权）。
 *
 * 实测（2026-10-26）：
 *  - OHLCV 是 **pool 级**（不是 token 级）：/networks/{net}/pools/{pool}/ohlcv/{minute}
 *  - 1h 周期返回格式：[[timestamp, open, high, low, close, volume], ...]，**按时间倒序**（最新在前）
 *    注意：第 2 个元素是 open 不是 volume —— 已用「high ≥ max(open,close) 且 low ≤ min(open,close)」校验过
 *  - 单次 limit 上限 1000，可用 before_timestamp 往前翻页
 */

const BASE = 'https://api.geckoterminal.com/api/v2';

/**
 * 全局节流：GeckoTerminal 免费额度是 30 次/分钟，超了直接 429。
 * 实测多池合并时（6 池 × 分页）很容易触顶，所以这里串行化并限速。
 */
const MIN_INTERVAL_MS = 2300;
let lastCallAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - now);
  lastCallAt = now + wait;
  if (wait > 0) await sleep(wait);
}

/** 查某代币的所有交易池，按 24h 美元成交量排序 */
export async function findPools(network, tokenAddress) {
  await throttle();
  const url = `${BASE}/networks/${network}/tokens/${tokenAddress}/pools`;
  const data = await httpJson(url, { label: 'gt-pools', timeoutMs: 25_000, retries: 2 });

  const pools = (data?.data ?? []).map((p) => ({
    id: p.id,
    address: p.attributes?.address,
    name: p.attributes?.name,
    volume24h: Number(p.attributes?.volume_usd?.h24 ?? 0),
    priceUsd: Number(p.attributes?.base_token_price_usd ?? 0),
    liquidityUsd: Number(p.attributes?.reserve_in_usd ?? 0),
  }));

  return pools.sort((a, b) => b.volume24h - a.volume24h);
}

/**
 * 拉取某池的小时级 OHLCV。
 * @param {object} p
 * @param {string} p.network
 * @param {string} p.poolAddress
 * @param {number} [p.beforeTs]  往前翻页用：该时间戳之前的数据
 * @param {number} [p.limit]     默认 1000
 * @returns {Promise<Array<{time,open,high,low,close,volume}>>} 按时间升序
 */
export async function fetchHourlyOhlcv({ network, poolAddress, beforeTs = null, limit = 1000 }) {
  await throttle();
  const url = new URL(`${BASE}/networks/${network}/pools/${poolAddress}/ohlcv/hour`);
  url.searchParams.set('aggregate', '1');
  url.searchParams.set('limit', String(Math.min(limit, 1000)));
  if (beforeTs != null) url.searchParams.set('before_timestamp', String(beforeTs));

  const data = await httpJson(url.toString(), { label: 'gt-ohlcv', timeoutMs: 30_000, retries: 3 });
  const list = data?.data?.attributes?.ohlcv_list ?? [];
  if (!Array.isArray(list)) throw new Error('GeckoTerminal OHLCV 返回格式异常');

  const bars = list.map((r) => ({
    time: Number(r[0]) * 1000, // 秒 → 毫秒
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));

  // 接口按时间倒序返回，统一转成升序
  return bars.sort((a, b) => a.time - b.time);
}

/**
 * 拉全某个池的历史（自动向前翻页）。
 * @param {object} p
 * @param {string} p.network
 * @param {string} p.poolAddress
 * @param {number} [p.maxBars]
 * @param {number} [p.startMs]   只要这个时间之后的
 */
export async function fetchFullHistory({ network, poolAddress, maxBars = 5000, startMs = null }) {
  const out = [];
  let before = null;
  let guard = 0;

  while (out.length < maxBars && guard < 20) {
    guard += 1;
    const page = await fetchHourlyOhlcv({
      network,
      poolAddress,
      beforeTs: before,
      limit: 1000,
    });
    if (page.length === 0) break;

    for (const b of page) {
      if (startMs != null && b.time < startMs) continue;
      out.push(b);
    }

    const oldest = page[0].time;
    if (startMs != null && oldest <= startMs) break;
    if (page.length < 1000) break;
    before = Math.floor(oldest / 1000) - 1;
  }

  const seen = new Map();
  for (const b of out) seen.set(b.time, b);
  return [...seen.values()].sort((a, b) => a.time - b.time);
}
