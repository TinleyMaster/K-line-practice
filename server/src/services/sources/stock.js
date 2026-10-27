import { findPools, fetchFullHistory } from './geckoterminal.js';

/**
 * 链上美股（代币化股票）取数编排层。
 *
 * 数据链路：
 *   Binance Alpha 清单（拿 symbol / 链 / 合约地址）
 *     → GeckoTerminal 查该代币的 DEX 池（取多个，按 24h 成交额排序）
 *       → 各池的小时级 OHLCV（= 该代币的链上成交价 K 线）
 *       → 跨池合并成一条干净的 K 线
 *
 * 为什么必须多池合并（实测 2026-10-26）：
 *   单池的历史深度取决于该池何时建立 —— 实测同一批标的里，
 *   NVDAON 单池有 1162 根，MSTRON 只有 3 根，HIMSON 22 根。
 *   不同池的活跃期互补，合并后能拿到完整得多的历史。
 *
 * 合并规则（同一时间戳跨池）：
 *   close = 各池 close 的中位数（抗单池异常成交）
 *   high  = 各池 high 的最大值
 *   low   = 各池 low 的最小值
 *   open  = 取与中位 close 最接近的那个池的 open
 *   volume= 各池 volume 之和
 */

const MAX_POOLS = 4;
/** 拿到这么多根就够练了，不再继续拉其他池（GeckoTerminal 有限流，池越多越慢） */
const ENOUGH_BARS = 900;

/** 为某个 RWA 代币解析出候选交易池（按流动性降序） */
export async function resolveStockPool(token) {
  const pools = await findPools(token.network, token.contractAddress);
  if (pools.length === 0) {
    throw new Error(`未找到 ${token.symbol} 的链上交易池`);
  }
  const usable = pools.filter((p) => p.address).slice(0, MAX_POOLS);
  return {
    network: token.network,
    poolAddress: usable[0].address,
    poolName: usable[0].name,
    volume24h: usable[0].volume24h,
    priceUsd: usable[0].priceUsd,
    pools: usable.map((p) => ({
      address: p.address,
      name: p.name,
      volume24h: p.volume24h,
    })),
  };
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 合并多个池在同一时间戳的数据 */
function mergeAt(buckets) {
  const closes = buckets.map((b) => b.close).sort((a, b) => a - b);
  const med = median(closes);

  // ⚠ 剔除异常池：低流动性池的成交价会严重偏离真实价格。
  //   实测 SPYON 历史里出现过 388（真实约 768）、CRCLON 出现过 0.07。
  //   直接取 max(high)/min(low) 会被这些脏点放大，所以先按中位数过滤掉明显偏离的池。
  const kept = buckets.filter((b) => {
    if (!med) return true;
    return Math.abs(b.close - med) / med <= 0.03;
  });
  const use = kept.length > 0 ? kept : buckets;

  const close = kept.length > 0 ? median(use.map((b) => b.close)) : med;
  const high = Math.max(...use.map((b) => b.high));
  const low = Math.min(...use.map((b) => b.low));

  // open 取与中位 close 最接近的那根，避免把某个极端池的开盘价带进来
  let open = use[0].open;
  let bestDiff = Infinity;
  for (const b of use) {
    const d = Math.abs(b.open - close);
    if (d < bestDiff) {
      bestDiff = d;
      open = b.open;
    }
  }
  const volume = use.reduce((s, b) => s + (b.volume || 0), 0);
  return { open, high, low, close, volume };
}

/**
 * 拉某个链上美股的小时级 K 线（多池合并）。
 * @param {object} p
 * @param {string} p.network
 * @param {string|string[]} p.pools 池地址（单个或数组）
 * @param {number} [p.startMs]
 * @param {number} [p.maxBars]
 */
export async function fetchStock1h({ network, pools, startMs = null, maxBars = 5000 }) {
  const list = (Array.isArray(pools) ? pools : [pools]).filter(Boolean);
  if (list.length === 0) throw new Error('缺少链上池地址');

  /** @type {Map<number, Array<{open,high,low,close,volume}>>} */
  const byTime = new Map();

  for (const poolAddress of list) {
    let bars;
    try {
      bars = await fetchFullHistory({ network, poolAddress, startMs, maxBars });
    } catch (err) {
      console.warn(`  [stock] 池 ${poolAddress.slice(0, 10)} 拉取失败：${err.message}`);
      continue;
    }
    for (const b of bars) {
      if (!byTime.has(b.time)) byTime.set(b.time, []);
      byTime.get(b.time).push(b);
    }
    // 历史已经够深就不再消耗限流额度去拉更多池
    if (byTime.size >= ENOUGH_BARS) break;
  }

  const out = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, buckets]) => {
      const m = mergeAt(buckets);
      return {
        time,
        open: m.open,
        high: m.high,
        low: m.low,
        close: m.close,
        volume: m.volume,
        quoteVolume: m.volume * m.close,
        trades: 0,
      };
    });

  return out;
}
