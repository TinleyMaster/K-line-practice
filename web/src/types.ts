/* ===== 领域类型 ===== */

/** 市场维度：合约 / 现货 / 链上美股 */
export type Market = 'perp' | 'spot' | 'stock';

export interface MarketInfo {
  market: Market;
  label: string;
  category: string;
  source: string;
}

export interface Bar {
  symbol: string;
  time: number; // epoch ms (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  /** 仅 4h 派生柱带上：组成它的 1h 根数 */
  constituents?: number;
  /**
   * 数据来源标记。链上美股低流动性时段没有成交，会做前向填充补成哑线，
   * 这些行标记为 `geckoterminal_ffill`，前端据此提示用户。
   */
  source?: string | null;
}

export type TradeSide = 'long' | 'short';

export interface OpenTrade {
  id: string; // 本地临时 id
  serverId?: number;
  sessionId?: number;
  symbol: string;
  side: TradeSide;
  setup: string | null;
  entryTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  riskAmount: number;
  qty: number;
  /** 开仓时的检查表勾选情况 */
  checklist: Record<string, boolean>;
}

export interface ClosedTrade extends OpenTrade {
  exitTime: number;
  exitPrice: number;
  exitReason: 'stop' | 'target' | 'manual' | 'session_end';
  pnl: number;
  rMultiple: number;
}

export interface Setup {
  id: number;
  name: string;
  description: string;
  marketCondition: string;
  entryRules: string[];
  exitRules: string[];
  color: string;
  enabled: boolean;
}

export interface SymbolInfo {
  symbol: string;
  market: Market;
  marketLabel: string;
  base: string;
  quote: string;
  category: string;
  enabled: boolean;
  sortRank: number | null;
  note: string | null;
  bars: number;
  firstTime: string | null;
  lastTime: string | null;
  /** 链上美股数据健康度（回填审计写入） */
  dataHealth?: {
    bars1h: number;
    coveragePct: number;
    realBars: number;
    realRatioPct: number;
    enabled: boolean;
    checkedAt: string;
  } | null;
}

/* ===== 后端 API 返回 ===== */

export interface KlinesResponse {
  symbol: string;
  market: Market;
  marketLabel: string;
  baseInterval: string;
  trendInterval: string;
  count1h: number;
  count4h: number;
  firstTime: number;
  lastTime: number;
  bars1h?: Bar[];
  bars4h?: Bar[];
  bars?: Bar[];
}

export interface SessionInfo {
  id: number;
  symbol: string;
  market: Market;
  baseInterval: string;
  trendInterval: string;
  mode: string;
  startTime: string | null;
  endTime: string | null;
  cursorTime: string | null;
  status: string;
  equityStart: number;
  equityEnd: number | null;
  barsPlayed: number;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  tradeCount?: number;
  closedCount?: number;
  totalR?: number;
}

export interface JournalEntry {
  id: number;
  sessionId: number | null;
  tradeId: number | null;
  symbol: string | null;
  setup: string | null;
  followedPlan: boolean | null;
  emotion: string | null;
  mistakeTag: string | null;
  content: string;
  snapshot: Record<string, unknown>;
  createdAt: string;
}

export interface StatsResponse {
  overall: {
    trades: number;
    closed: number;
    wins: number;
    losses: number;
    winRate: number;
    totalR: number;
    avgR: number;
    expectancy: number;
    profitFactor: number | null;
    maxDrawdown: number;
    avgHoldHours: number;
  };
  bySetup: Array<{
    setup: string;
    trades: number;
    wins: number;
    winRate: number;
    totalR: number;
    avgR: number;
    avgHoldHours: number;
  }>;
  bySymbol: Array<{
    symbol: string;
    market: Market;
    trades: number;
    wins: number;
    winRate: number;
    totalR: number;
    avgR: number;
  }>;
  byExitReason: Array<{ exitReason: string; trades: number; avgR: number }>;
  rDistribution: Array<{ bucket: string; n: number }>;
  discipline: {
    journaled: number;
    followed: number;
    violated: number;
    adherenceRate: number | null;
  };
  equityCurve: Array<{
    time: string;
    pnl: number;
    r: number;
    symbol: string;
    market: Market;
    setup: string | null;
  }>;
}
