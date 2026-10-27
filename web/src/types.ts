/* ===== 领域类型 ===== */

/** 市场维度：合约 / 现货 / 链上美股 */
export type Market = 'perp' | 'spot' | 'stock';

/** 图表周期：15m（精找入场）/ 1h（主入场）/ 4h（看趋势） */
export type ChartPeriod = '15m' | '1h' | '4h';

export interface MarketInfo {
  market: Market;
  label: string;
  category: string;
  source: string;
}

/** 登录用户 */
export interface User {
  id: number;
  username: string;
  displayName: string;
  createdAt?: string;
}

/** PK 对比里的一个玩家 */
export interface PkPlayer {
  userId: number;
  username: string;
  displayName: string;
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
  journaled: number;
  followed: number;
  violated: number;
  skipped: number;
  adherenceRate: number | null;
}

/** PK 的一个对比维度 */
export interface PkComparison {
  key: string;
  label: string;
  better: 'high' | 'low' | 'none';
  leader: number | null;
  values: Array<{ userId: number; value: number | null; display: string }>;
}

export interface PkResponse {
  players: PkPlayer[];
  comparisons: PkComparison[];
  generatedAt: string;
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

/** 入场方式：市价（按当前收盘价成交）/ 限价（挂单，到价才成交） */
export type EntryMode = 'market' | 'limit';
/** 止损定义方式：固定价格 / 百分比 / ATR 倍数 */
export type StopType = 'price' | 'pct' | 'atr';
/** 止盈定义方式：固定价格 / R 倍数 / 不设 */
export type TargetType = 'price' | 'ratio' | 'none';
/** 仓位定义方式：按风险 % / 按名义金额 */
export type SizeMode = 'risk' | 'notional';

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
  /* ---- v6：开仓设置扩展 ---- */
  /** 入场方式 */
  entryMode: EntryMode;
  /** 限价单价格（entryMode=limit 时有效） */
  limitPrice: number | null;
  /** 止损定义方式（记录当时的输入方式，便于复盘） */
  stopType: StopType;
  /** 止盈定义方式 */
  tpType: TargetType;
  /** 仓位定义方式 */
  sizeMode: SizeMode;
  /** 单边费率（小数，0.0004 = 4bp） */
  feeRate: number;
  /** 滑点（基点，1bp = 0.01%） */
  slippageBps: number;
  /** 时间止损（小时），超过则强制平仓 */
  timeStopHrs: number | null;
  /** 信号置信度 1~5 */
  confidence: number | null;
  /** 开仓备注 */
  notes: string | null;
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
  count15m: number;
  /** 15m 不可用时的说明（例如「仅 BTC/ETH 覆盖 15m」） */
  note15m: string | null;
  firstTime: number;
  lastTime: number;
  bars1h?: Bar[];
  bars4h?: Bar[];
  bars15m?: Bar[];
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
  userId?: number | null;
  symbol: string | null;
  setup: string | null;
  followedPlan: boolean | null;
  emotion: string | null;
  mistakeTag: string | null;
  content: string;
  snapshot: Record<string, unknown>;
  /** 跳过的复盘（关掉了弹窗没写内容）—— 可稍后补写 */
  skipped: boolean;
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
    /** 跳过的复盘（关掉弹窗没写） */
    skipped: number;
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
