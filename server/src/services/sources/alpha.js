import { httpJson } from './http.js';

/**
 * Binance Alpha 代币清单（链上资产，含 Ondo 的代币化美股 / ETF）。
 *
 * 实测（2026-10-26）：
 *  - 端点 https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list 直连可用
 *  - Alpha 上的股票代币不在币安主站 klines 通道（api/v3/exchangeInfo 报 Invalid symbol），
 *    但代币本身是真实链上资产，合约地址 + 链信息可拿到 → 用于链上 OHLCV 取数
 *  - 清单里 rwaInfo 非空的条目 = RWA（代币化美股 / ETF），当前约 80 个
 */

const ALPHA_LIST_URL =
  'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';

/** Binance Alpha 链名 → GeckoTerminal network id */
export const NETWORK_ID_MAP = {
  BSC: 'bsc',
  BNB: 'bsc',
  Base: 'base',
  Ethereum: 'eth',
  ETH: 'eth',
  Solana: 'solana',
  Polygon: 'polygon_pos',
  Arbitrum: 'arbitrum',
  ArbitrumOne: 'arbitrum',
  Avalanche: 'avax',
  Optimism: 'optimism',
  Sui: 'sui',
  Aptos: 'aptos',
  Tron: 'tron',
};

function normalize(t) {
  const rwa = t.rwaInfo ?? null;
  return {
    symbol: t.symbol,
    name: t.name,
    chain: t.chainName,
    network: NETWORK_ID_MAP[t.chainName] ?? null,
    contractAddress: t.contractAddress,
    price: Number(t.price ?? 0),
    marketCap: Number(t.marketCap ?? 0),
    volume24h: Number(t.volume24h ?? 0),
    holders: t.holders ?? null,
    listingCex: t.listingCex ?? false,
    rwaInfo: rwa,
    // Ondo 代币在美股休市时暂停撮合，这里记录其市场状态，便于前端提示
    marketStatus: rwa?.marketStatus ?? null,
  };
}

/** 拉取 Alpha 全部代币（已归一化） */
export async function fetchAlphaTokens() {
  const data = await httpJson(ALPHA_LIST_URL, {
    label: 'binance-alpha-list',
    timeoutMs: 25_000,
    retries: 2,
  });
  const list = data?.data ?? [];
  if (!Array.isArray(list)) throw new Error('Alpha 清单返回格式异常');
  return list.map(normalize);
}

/** 只要 RWA（代币化股票 / ETF）条目 */
export async function fetchRwaTokens() {
  const all = await fetchAlphaTokens();
  return all.filter((t) => t.rwaInfo && t.contractAddress && t.network);
}
