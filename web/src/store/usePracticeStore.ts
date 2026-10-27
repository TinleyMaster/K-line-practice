import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, setToken } from '../api';
import type {
  Bar,
  ChartPeriod,
  ClosedTrade,
  EntryMode,
  JournalEntry,
  Market,
  MarketInfo,
  OpenTrade,
  Setup,
  SizeMode,
  StopType,
  SymbolInfo,
  TargetType,
  TradeSide,
  User,
} from '../types';
import { derive4h, sliceRevealed } from '../engine/bars';
import { checkExit, closeTrade, unrealizedPnl } from '../engine/trading';
import { DEFAULT_1H, DEFAULT_4H, normalizeSelection } from '../engine/indicators';

export interface EquityPoint {
  time: number;
  equity: number;
  label?: string | number;
}

/** 开仓草稿 —— v6 扩展后的完整设置 */
export interface TradeDraft {
  side: TradeSide;
  stopLoss: number;
  takeProfit: number | null;
  riskPct: number;
  setup: string | null;
  checklist: Record<string, boolean>;
  /* v6 */
  entryMode: EntryMode;
  limitPrice: number | null;
  stopType: StopType;
  tpType: TargetType;
  sizeMode: SizeMode;
  sizeValue: number;
  feeRate: number;
  slippageBps: number;
  timeStopHrs: number | null;
  confidence: number | null;
  notes: string | null;
}

interface PracticeState {
  /* 数据 */
  symbols: SymbolInfo[];
  markets: MarketInfo[];
  setups: Setup[];
  symbol: string;
  market: Market;
  bars1h: Bar[];
  bars4h: Bar[];
  /** 15m 独立序列（仅 BTC/ETH 有；其他标的为空数组） */
  bars15m: Bar[];
  /** 15m 不可用时的说明文案 */
  note15m: string | null;
  loading: boolean;
  error: string | null;

  /* 回放 */
  cursor: number;
  /**
   * 当前时刻（epoch ms）—— **精确到 15m 的位置真值**。
   *
   * 为什么不让 cursor 兼此职：cursor 是 bars1h 的**索引**，粒度固定 1h。
   * 而 v6.3 要求「停在 15m 图时，单步就前进一根 15m」—— 1h 索引表达不了
   * 15 分钟的位置（index 不能是小数）。
   *
   * 两者关系（不变量，务必保持）：
   *   bars1h[cursor].time <= cursorMs < bars1h[cursor + 1].time
   * 即 cursor 始终是「包含 cursorMs 的那根 1h」。
   *
   * 于是：cursor 是**引擎真值**（开平仓判定、权益曲线、落库都按 1h 走），
   * cursorMs 是**视线真值**（图表右端、步进粒度、开仓取价都按它走）。
   * 15m 步进时可能只动 cursorMs 而不动 cursor —— 引擎仍以 1h 为准，
   * 这与「引擎只知道 1h」的设计一致。
   */
  cursorMs: number;
  startCursor: number;
  /** 已回放到的最远位置。cursor < maxCursor 即为「回看模式」（往回看，不能开仓） */
  maxCursor: number;
  playing: boolean;
  speed: number;
  /** 练习起点模式：auto = 自动推导，manual = 用户指定 */
  startMode: 'auto' | 'manual';
  /** 用户指定的起点时间戳（epoch ms），manual 模式下有效 */
  manualStartTime: number | null;

  /* 指标配置 */
  indicators4h: string[];
  indicators1h: string[];
  /** 15m 复用 1h 的指标配置（15m 是 1h 的细化视图，指标体系一致） */
  /** 当前图表显示的周期（单图 + Tab 切换） */
  chartPeriod: ChartPeriod;

  /* UI */
  /** 开仓面板是否展开 */
  tradePanelOpen: boolean;

  /* 交易 */
  openTrade: OpenTrade | null;
  closedTrades: ClosedTrade[];
  equityStart: number;
  equity: number;
  peakEquity: number;
  maxDrawdown: number;
  equityCurve: EquityPoint[];

  /* 复盘 */
  pendingJournal: ClosedTrade | null;
  journal: JournalEntry[];
  /** 被关掉但没写的复盘（可稍后补） */
  skippedJournal: JournalEntry[];

  /* 会话 */
  sessionId: number | null;

  /* 账号（v6） */
  user: User | null;
  authReady: boolean;

  /* actions */
  bootstrap: () => Promise<void>;
  selectSymbol: (symbol: string, market?: Market) => Promise<void>;
  selectMarket: (market: Market) => Promise<void>;
  setSpeed: (ms: number) => void;
  startReplay: (fromIndex?: number) => Promise<void>;
  resetReplay: () => void;
  next: () => void;
  /** 后退一步（步长跟随当前图表周期：15m / 1h / 4h） */
  prev: () => void;
  /** 引擎推进一根 1h —— 内部用 */
  advance1h: () => void;
  /** 引擎回退一根 1h —— 内部用 */
  back1h: () => void;
  /** 后退一根 4h（= 4 根 1h） */
  back4h: () => void;
  jump4h: () => void;
  play: () => void;
  pause: () => void;
  /** 设置练习起点（时间戳），null 表示回到自动模式 */
  setStartTime: (time: number | null) => void;
  /** 设置某周期的指标选择 */
  setIndicators: (period: '4h' | '1h', names: string[]) => void;
  /** 切换图表显示的周期 */
  setChartPeriod: (period: ChartPeriod) => void;
  /** 展开/收起开仓面板 */
  setTradePanelOpen: (open: boolean) => void;
  openPosition: (draft: TradeDraft) => Promise<{ ok: boolean; msg?: string }>;
  closePosition: (reason: ClosedTrade['exitReason'], price?: number) => Promise<void>;
  saveJournal: (payload: {
    followedPlan: boolean;
    emotion: string | null;
    mistakeTag: string | null;
    content: string;
  }) => Promise<void>;
  /** 跳过复盘（关掉弹窗不写内容）—— 标记为待补，不阻塞继续 */
  skipJournal: () => Promise<void>;
  /** 补写之前跳过的复盘 */
  fillSkippedJournal: (id: number, payload: {
    followedPlan: boolean;
    emotion: string | null;
    mistakeTag: string | null;
    content: string;
  }) => Promise<void>;
  /** 登录 / 注册 / 登出 */
  login: (username: string, password: string) => Promise<{ ok: boolean; msg?: string }>;
  register: (username: string, password: string, displayName?: string) => Promise<{ ok: boolean; msg?: string }>;
  logout: () => Promise<void>;
  refreshStatsLater: () => void;
}

const DEFAULT_EQUITY = 10000;

/**
 * 起点推导所需的最小 4h 上下文根数。
 *
 * 4h 是看趋势的周期 —— 起点之前至少要有这么多根已完成的 4h，
 * 否则用户看到的第一屏没有趋势依据，「只做顺着 4h 方向的单」这条规则就落不了地。
 * 120 根 4h ≈ 480 根 1h ≈ 20 天。
 */
export const MIN_4H_CONTEXT = 120;

/**
 * 每个周期的**单步时长**（v6.3）。
 *
 * 需求：单步前进/后退的步长跟随当前图表所在周期 ——
 *   停在 15m → 前进一根 15m；停在 1h → 一根 1h；停在 4h → 一根 4h。
 *
 * 之前是硬编码的「一根 1h」（next/prev）与「四根 1h」（jump4h/back4h），
 * 跟图表周期脱节 —— 在 15m 图上看「当前小时内部」的走势时，
 * 按钮却一格跳过一整小时，精细操作用不上。
 */
export const STEP_MS: Record<ChartPeriod, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

/**
 * 二分查找：bars 中「开盘时间 <= t 的最后一根」的索引；t 早于全部则返回 -1。
 *
 * 注意是**按时间**而非按下标 —— 15m 与 1h 是两套独立序列，
 * 同一个时刻在两套序列里的下标完全不同，只能按时间定位。
 */
function indexAtOrBefore(bars: Bar[], t: number): number {
  if (!bars.length) return -1;
  let lo = 0;
  let hi = bars.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= t) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

/**
 * 取「当前时刻」对应的价格 K 线。
 *
 * 优先用 15m：cursorMs 落在某根 1h 内部时（15m 档走到一半），
 * 用 1h 收盘价当"现价"会让用户看到的图和实际开仓价对不上。
 * 15m 不可用（非 BTC/ETH）或该时刻之前没有 15m 时，退回 1h。
 */
export function priceBarAt(bars1h: Bar[], bars15m: Bar[], cursor: number, cursorMs: number): Bar | null {
  const h = bars1h[cursor];
  if (!h) return null;
  if (!bars15m.length || cursorMs < 0) return h;
  const i = indexAtOrBefore(bars15m, cursorMs);
  if (i < 0) return h;
  const fine = bars15m[i];
  // 必须落在同一根 1h 区间内，否则说明 15m 与 1h 时钟不同步，回退
  return fine.time >= h.time ? fine : h;
}

/**
 * 计算练习起点索引。
 *
 * @param bars1h    全部 1h K 线
 * @param manualTime 用户指定的时间戳（epoch ms），null / undefined = 自动
 * @returns 起点在 bars1h 中的索引
 */
export function resolveStartIndex(bars1h: Bar[], manualTime?: number | null): number {
  if (!bars1h.length) return -1;

  // 自动模式：留出足够的 4h 趋势上下文，其余作为「未来」供回放
  if (!manualTime) {
    return Math.min(MIN_4H_CONTEXT * 4, Math.max(MIN_4H_CONTEXT, Math.floor(bars1h.length * 0.4)));
  }

  // 手动模式：定位到不晚于指定时间的最后一根 1h
  let idx = bars1h.findIndex((b) => b.time > manualTime) - 1;
  if (idx < 0) idx = bars1h.length - 1;

  // 约束 1：起点之后至少要留 60 根 1h 作为「未来」，否则没东西可回放
  const maxIdx = bars1h.length - 60;
  if (idx > maxIdx) idx = maxIdx;

  // 约束 2：起点之前至少要有 MIN_4H_CONTEXT 根 4h 上下文
  const minIdx = Math.min(MIN_4H_CONTEXT * 4, bars1h.length - 1);
  if (idx < minIdx) idx = minIdx;

  return Math.max(0, idx);
}

export const usePracticeStore = create<PracticeState>()(
  persist(
    (set, get) => ({
      symbols: [],
      markets: [],
      setups: [],
      symbol: 'BTCUSDT',
      market: 'perp',
      bars1h: [],
      bars4h: [],
      bars15m: [],
      note15m: null,
      loading: false,
      error: null,

      cursor: -1,
      cursorMs: -1,
      startCursor: -1,
      maxCursor: -1,
      playing: false,
      speed: 1200,
      startMode: 'auto',
      manualStartTime: null,

      indicators4h: DEFAULT_4H,
      indicators1h: DEFAULT_1H,
      chartPeriod: '1h',

      tradePanelOpen: false,

      openTrade: null,
      closedTrades: [],
      equityStart: DEFAULT_EQUITY,
      equity: DEFAULT_EQUITY,
      peakEquity: DEFAULT_EQUITY,
      maxDrawdown: 0,
      equityCurve: [],

      pendingJournal: null,
      journal: [],
      skippedJournal: [],

      sessionId: null,

      user: null,
      authReady: false,

      bootstrap: async () => {
        try {
          const [symbols, setups, markets] = await Promise.all([
            api.symbols(),
            api.setups(),
            api.markets(),
          ]);
          set({ symbols, setups, markets });

          // 账号状态（未登录也继续用，不强制）
          try {
            const { user } = await api.me();
            set({ user, authReady: true });
          } catch {
            set({ authReady: true });
          }

          const { symbol, market } = get();
          const exists = symbols.some((s) => s.symbol === symbol && s.market === market);
          if (exists) {
            if (get().bars1h.length === 0) await get().selectSymbol(symbol, market);
            return;
          }
          // 优先选当前市场下第一个有数据的标的
          const inMarket = symbols.find((s) => s.market === market && s.bars > 0);
          const fallback =
            inMarket?.symbol ??
            symbols.find((s) => s.symbol === 'BTCUSDT' && s.market === 'perp')?.symbol ??
            symbols.find((s) => s.bars > 0)?.symbol;
          if (fallback) {
            const fm = symbols.find((s) => s.symbol === fallback)?.market ?? market;
            await get().selectSymbol(fallback, fm);
          }
        } catch (err) {
          set({ error: (err as Error).message });
        }
      },

      selectMarket: async (market) => {
        if (market === get().market) return;
        set({ market, symbols: get().symbols });
        const inMarket = get().symbols.find((s) => s.market === market && s.bars > 0);
        if (inMarket) {
          await get().selectSymbol(inMarket.symbol, market);
        } else {
          set({
            bars1h: [],
            bars4h: [],
            bars15m: [],
            note15m: null,
            cursor: -1,
            cursorMs: -1,
            maxCursor: -1,
            openTrade: null,
            closedTrades: [],
          });
        }
      },

      selectSymbol: async (symbol, market) => {
        const m = market ?? get().market;
        set({ loading: true, error: null, symbol, market: m });
        try {
          const data = await api.klines(symbol, m, 1200);
          const bars1h = data.bars1h ?? [];
          const bars4h = data.bars4h ?? derive4h(bars1h);
          const bars15m = data.bars15m ?? [];
          // 练习起点：用户指定优先（保留其偏好），否则自动推导；
          // 起点前保证有足够的 4h 趋势上下文（≥120 根 4h）
          const start = resolveStartIndex(bars1h, get().manualStartTime);
          set({
            symbol,
            market: m,
            bars1h,
            bars4h,
            bars15m,
            note15m: data.note15m ?? null,
            cursor: start,
            cursorMs: bars1h[start]?.time ?? -1,
            startCursor: start,
            maxCursor: start,
            openTrade: null,
            closedTrades: [],
            equity: DEFAULT_EQUITY,
            equityStart: DEFAULT_EQUITY,
            peakEquity: DEFAULT_EQUITY,
            maxDrawdown: 0,
            equityCurve: [],
            pendingJournal: null,
            sessionId: null,
            playing: false,
            loading: false,
          });
          // 当前周期若是 15m 但没数据 → 自动退回 1h（避免打开就是空图）
          if (get().chartPeriod === '15m' && bars15m.length === 0) {
            set({ chartPeriod: '1h' });
          }
        } catch (err) {
          set({ error: (err as Error).message, loading: false });
        }
      },

      setSpeed: (ms) => set({ speed: ms }),

      setStartTime: (time) => {
        const state = get();
        if (!state.bars1h.length) return;
        if (time === null) {
          // 回到自动模式
          const idx = resolveStartIndex(state.bars1h, null);
          set({
            startMode: 'auto',
            manualStartTime: null,
            cursor: idx,
            cursorMs: state.bars1h[idx]?.time ?? -1,
            startCursor: idx,
            maxCursor: idx,
            openTrade: null,
            closedTrades: [],
            equity: DEFAULT_EQUITY,
            equityStart: DEFAULT_EQUITY,
            peakEquity: DEFAULT_EQUITY,
            maxDrawdown: 0,
            equityCurve: [],
            pendingJournal: null,
            sessionId: null,
            playing: false,
          });
          return;
        }
        const idx = resolveStartIndex(state.bars1h, time);
        set({
          startMode: 'manual',
          manualStartTime: time,
          cursor: idx,
          cursorMs: state.bars1h[idx]?.time ?? -1,
          startCursor: idx,
          maxCursor: idx,
          openTrade: null,
          closedTrades: [],
          equity: DEFAULT_EQUITY,
          equityStart: DEFAULT_EQUITY,
          peakEquity: DEFAULT_EQUITY,
          maxDrawdown: 0,
          equityCurve: [],
          pendingJournal: null,
          sessionId: null,
          playing: false,
        });
      },

      setIndicators: (period, names) => {
        const normalized = normalizeSelection(names);
        if (period === '4h') set({ indicators4h: normalized });
        else set({ indicators1h: normalized });
      },

      setChartPeriod: (period) => set({ chartPeriod: period }),

      setTradePanelOpen: (open) => set({ tradePanelOpen: open }),

      startReplay: async (fromIndex) => {
        const { bars1h, symbol, market } = get();
        if (!bars1h.length) return;
        const cursor = fromIndex ?? get().cursor;
        set({
          cursor,
          cursorMs: bars1h[cursor]?.time ?? -1,
          startCursor: cursor,
          maxCursor: cursor,
          openTrade: null,
          closedTrades: [],
          equity: DEFAULT_EQUITY,
          equityStart: DEFAULT_EQUITY,
          peakEquity: DEFAULT_EQUITY,
          maxDrawdown: 0,
          equityCurve: [],
          pendingJournal: null,
          sessionId: null,
        });
        try {
          const session = await api.createSession({
            symbol,
            market,
            startTime: new Date(bars1h[cursor].time).toISOString(),
            equityStart: DEFAULT_EQUITY,
            meta: { source: 'practice-web' },
          });
          set({ sessionId: session.id });
        } catch {
          /* 会话落库失败不阻塞本地练习 */
        }
      },

      resetReplay: () => {
        const { cursor, bars1h } = get();
        const idx = cursor >= 0 ? cursor : 0;
        set({
          cursor: idx,
          cursorMs: bars1h[idx]?.time ?? -1,
          maxCursor: idx,
          openTrade: null,
          closedTrades: [],
          equity: DEFAULT_EQUITY,
          equityStart: DEFAULT_EQUITY,
          peakEquity: DEFAULT_EQUITY,
          maxDrawdown: 0,
          equityCurve: [],
          pendingJournal: null,
        });
      },

      /**
       * 引擎回退一根 1h —— 回看模式。**内部用**，对外的 prev 是「按当前周期步进」。
       *
       * 语义边界（刻意保守，避免制造「时间旅行」的错觉）：
       * - 只回看画面与浮动盈亏，**不撤销已平仓交易**（历史就是历史）；
       * - 持仓期间最多退回入场那根 —— 再往前退，「持仓」在时间上就不成立了；
       * - 权益曲线按游标截断，浮动盈亏按当前价重算；
       * - 回看时 maxCursor 不变，游标回到 maxCursor 即退出回看模式。
       */
      back1h: () => {
        const state = get();
        const { bars1h, cursor, openTrade } = state;
        if (cursor <= 0) return;

        let target = cursor - 1;
        if (openTrade) {
          // entryTime 可能是 15m 粒度（v6.3）—— 要找的是「包含入场时刻的那根 1h」，
          // 不能用等值匹配（等值匹配会因粒度不同而永远找不到 → 持仓期回退限制失效）
          const entryIdx = bars1h.findIndex((b) => b.time <= openTrade.entryTime);
          if (entryIdx >= 0 && target < entryIdx) target = entryIdx;
        }

        const bar = bars1h[target];
        if (!bar) return;

        const realized = state.closedTrades.reduce((s, t) => s + t.pnl, 0);
        const floating = openTrade ? unrealizedPnl(openTrade, bar.close) : 0;
        const equity = DEFAULT_EQUITY + realized + floating;

        set({
          cursor: target,
          cursorMs: bar.time,
          playing: false,
          equity,
          equityCurve: state.equityCurve.filter((p) => p.time <= bar.time),
        });
      },

      /**
       * 后退一步 —— **步长跟随当前图表周期**（v6.3）。
       *
       * 停在 15m → 退一根 15m；1h → 退一根 1h；4h → 退一根 4h。
       *
       * 实现要点：cursorMs 减一个步长得到目标时刻 target，
       * 再用 target 反查「包含它的 1h 索引」：
       *   - target 仍在同一根 1h 内（15m 档常见）→ 引擎不动，只挪 cursorMs
       *   - target 跨到了更早的 1h → 引擎逐根回退（触发权益曲线截断、浮盈重算）
       *
       * ⚠️ 边界只挡「数据起点」，**不挡练习起点** ——
       *   练习起点之前是预热区（本来就给用户看的历史），允许回看进去。
       *   （v6.3 初版误加「不许越过练习起点」的限制，把 v4 的回看功能整个锁死了。）
       */
      prev: () => {
        const state = get();
        const { bars1h, cursor, cursorMs } = state;
        if (cursor <= 0) return;

        const base = cursorMs >= 0 ? cursorMs : (bars1h[cursor]?.time ?? 0);
        const target = base - STEP_MS[state.chartPeriod];

        // 边界：不能退到数据起点之前
        if (target < (bars1h[0]?.time ?? 0)) return;

        const targetIdx = indexAtOrBefore(bars1h, target);
        if (targetIdx < 0) return;

        while (get().cursor > targetIdx) get().back1h();
        // 保持不变量 cursorMs ≥ bars1h[cursor].time（数据有缺口时 target 可能更早）
        const floor = bars1h[get().cursor]?.time ?? target;
        set({ cursorMs: Math.max(target, floor) });
      },

      /**
       * 后退一根 4h（= 4 根 1h）—— 快捷键，不受当前周期影响。
       *
       * ⚠️ 必须按**时间**推进（cursorMs -= 4h）而不是把 cursorMs 钉到 1h 边界：
       *   若钉到 bars1h[cursor].time，会把 cursorMs 的 15m 小数位抹掉
       *   （例：cursorMs 在 :15 分 → 被抹成 :00 → 后续步长全部错位 15 分钟）。
       */
      back4h: () => {
        const state = get();
        const { bars1h, cursor, cursorMs } = state;
        if (cursor <= 0) return;

        const base = cursorMs >= 0 ? cursorMs : (bars1h[cursor]?.time ?? 0);
        const target = base - 4 * 3600000;
        if (target < (bars1h[0]?.time ?? 0)) return;

        const targetIdx = indexAtOrBefore(bars1h, target);
        if (targetIdx < 0) return;

        while (get().cursor > targetIdx) get().back1h();
        const floor = bars1h[get().cursor]?.time ?? target;
        set({ cursorMs: Math.max(target, floor) });
      },

      /**
       * 引擎推进一根 1h —— **内部用**，对外的 next 是「按当前周期步进」。
       */
      advance1h: () => {
        const state = get();
        const { bars1h, cursor, openTrade, closedTrades } = state;
        if (cursor + 1 >= bars1h.length) {
          set({ playing: false });
          return;
        }
        const nextCursor = cursor + 1;
        const bar = bars1h[nextCursor];

        let newOpen = openTrade;
        let newClosed = closedTrades;

        // 持仓检查出场（开仓那根不检查，从下一根开始）
        if (openTrade && nextCursor > 0) {
          const hit = checkExit(openTrade, bar);
          if (hit) {
            const closed = closeTrade(openTrade, bar.time, hit.price, hit.reason);
            newOpen = null;
            newClosed = [...closedTrades, closed];
            set({ pendingJournal: closed }); // 强制复盘，阻塞继续开仓
          }
        }

        const price = bar.close;
        const realized = newClosed.reduce((s, t) => s + t.pnl, 0);
        const floating = newOpen ? unrealizedPnl(newOpen, price) : 0;
        const equity = DEFAULT_EQUITY + realized + floating;
        const peak = Math.max(state.peakEquity, equity);
        const dd = peak > 0 ? (peak - equity) / peak : 0;

        set({
          cursor: nextCursor,
          maxCursor: Math.max(state.maxCursor, nextCursor),
          openTrade: newOpen,
          closedTrades: newClosed,
          equity,
          peakEquity: peak,
          maxDrawdown: Math.max(state.maxDrawdown, dd),
          equityCurve: [
            ...state.equityCurve,
            { time: bar.time, equity, label: bar.close },
          ],
        });

        // 平仓后同步到后端
        if (newClosed.length > closedTrades.length) {
          const justClosed = newClosed[newClosed.length - 1];
          void (async () => {
            try {
              if (justClosed.serverId) {
                await api.updateTrade(justClosed.serverId, {
                  exitTime: new Date(justClosed.exitTime).toISOString(),
                  exitPrice: justClosed.exitPrice,
                  exitReason: justClosed.exitReason,
                  status: 'closed',
                  rMultiple: justClosed.rMultiple,
                  pnl: justClosed.pnl,
                });
              }
              const sid = get().sessionId;
              if (sid) {
                await api.updateSession(sid, {
                  cursorTime: new Date(bar.time).toISOString(),
                  equityEnd: equity,
                  barsPlayed: nextCursor - get().startCursor,
                  status: 'active',
                });
              }
            } catch {
              /* 落库失败不阻塞练习 */
            }
          })();
        }
      },

      /**
       * 前进一步 —— **步长跟随当前图表周期**（v6.3）。
       *
       * 停在 15m → 前进一根 15m；1h → 一根 1h；4h → 一根 4h。
       *
       * 上界判定用「当前周期能揭示到的最后一根」：
       *   15m 档 → 最后一根 15m；1h/4h 档 → 最后一根 1h。
       * 越界时停止播放（而不是静默不动）。
       */
      next: () => {
        const state = get();
        const { bars1h, bars15m, cursor, cursorMs, chartPeriod } = state;
        if (cursor < 0 || !bars1h.length) return;

        const base = cursorMs >= 0 ? cursorMs : (bars1h[cursor]?.time ?? 0);
        const target = base + STEP_MS[chartPeriod];

        const limit =
          chartPeriod === '15m' && bars15m.length
            ? bars15m[bars15m.length - 1].time
            : (bars1h[bars1h.length - 1]?.time ?? 0);
        if (target > limit) {
          set({ playing: false });
          return;
        }

        const targetIdx = indexAtOrBefore(bars1h, target);
        if (targetIdx < 0) return;

        // 引擎逐根推进（每根都会检查出场、记权益曲线、落库）
        while (get().cursor < targetIdx) get().advance1h();
        // 保持不变量 cursorMs < bars1h[cursor+1].time（数据有缺口时 target 可能更晚）
        const ceil = bars1h[get().cursor + 1]?.time ?? Number.POSITIVE_INFINITY;
        set({ cursorMs: Math.min(target, ceil) });
      },

      /**
       * 前进一根 4h（= 4 根 1h）—— 快捷键，不受当前周期影响。
       *
       * ⚠️ 同 back4h：必须按**时间**推进（cursorMs += 4h），
       *   不能把 cursorMs 钉到 bars1h[cursor].time —— 那会抹掉 15m 的小数位，
       *   导致「按了 4h 跳，实际只走了 3h45m」这种隐性错位。
       */
      jump4h: () => {
        const state = get();
        const { bars1h, cursor, cursorMs } = state;
        if (cursor < 0) return;

        const base = cursorMs >= 0 ? cursorMs : (bars1h[cursor]?.time ?? 0);
        const target = base + 4 * 3600000;
        const targetIdx = indexAtOrBefore(bars1h, target);
        if (targetIdx < 0) return;

        while (get().cursor < targetIdx) get().advance1h();
        const ceil = bars1h[get().cursor + 1]?.time ?? Number.POSITIVE_INFINITY;
        set({ cursorMs: Math.min(target, ceil) });
      },

      play: () => set({ playing: true }),
      pause: () => set({ playing: false }),

      openPosition: async (draft) => {
        const state = get();
        if (state.pendingJournal) {
          return { ok: false, msg: '请先完成上一笔交易的复盘' };
        }
        if (state.openTrade) {
          return { ok: false, msg: '已有持仓，请先平仓' };
        }
        const bar = state.bars1h[state.cursor];
        if (!bar) return { ok: false, msg: '当前没有可用的价格' };

        // 价格取「当前时刻」对应的那根 —— 15m 档下 cursorMs 可能落在某根 1h 内部，
        // 用 1h 收盘价会让图上看到的价和实际开仓价对不上。
        const priceBar = priceBarAt(state.bars1h, state.bars15m, state.cursor, state.cursorMs);
        const entryPrice = (priceBar ?? bar).close;
        const entryTime = state.cursorMs >= 0 ? state.cursorMs : bar.time;
        const risk = state.equity * (draft.riskPct / 100);
        const dist = Math.abs(entryPrice - draft.stopLoss);
        if (!Number.isFinite(dist) || dist <= 0) {
          return { ok: false, msg: '止损距离为 0，无法计算仓位' };
        }
        const qty = risk / dist;

        const trade: OpenTrade = {
          id: `t-${Date.now()}`,
          symbol: state.symbol,
          side: draft.side,
          setup: draft.setup,
          entryTime,
          entryPrice,
          stopLoss: draft.stopLoss,
          takeProfit: draft.takeProfit,
          riskAmount: risk,
          qty,
          checklist: draft.checklist,
          entryMode: draft.entryMode,
          limitPrice: draft.limitPrice,
          stopType: draft.stopType,
          tpType: draft.tpType,
          sizeMode: draft.sizeMode,
          feeRate: draft.feeRate,
          slippageBps: draft.slippageBps,
          timeStopHrs: draft.timeStopHrs,
          confidence: draft.confidence,
          notes: draft.notes,
        };
        set({ openTrade: trade });

        try {
          const sid = state.sessionId ?? (await api.createSession({
            symbol: state.symbol,
            market: state.market,
            startTime: new Date(bar.time).toISOString(),
            equityStart: DEFAULT_EQUITY,
          })).id;
          const created = await api.createTrade({
            sessionId: sid,
            symbol: trade.symbol,
            market: state.market,
            side: trade.side,
            setup: trade.setup,
            entryTime: new Date(trade.entryTime).toISOString(),
            entryPrice: trade.entryPrice,
            stopLoss: trade.stopLoss,
            takeProfit: trade.takeProfit,
            riskAmount: trade.riskAmount,
            qty: trade.qty,
            checklist: trade.checklist,
            entryMode: trade.entryMode,
            limitPrice: trade.limitPrice,
            stopType: trade.stopType,
            stopValue: draft.stopType === 'price' ? draft.stopLoss : null,
            tpType: trade.tpType,
            tpValue: draft.tpType === 'price' ? draft.takeProfit : null,
            sizeMode: trade.sizeMode,
            sizeValue: draft.sizeValue,
            feeRate: trade.feeRate,
            slippageBps: trade.slippageBps,
            timeStopHrs: trade.timeStopHrs,
            confidence: trade.confidence,
            notes: trade.notes,
          });
          set({
            sessionId: sid,
            openTrade: { ...trade, serverId: Number(created.id), sessionId: sid },
          });
        } catch {
          /* 落库失败不阻塞本地练习 */
        }
        return { ok: true };
      },

      closePosition: async (reason, price) => {
        const state = get();
        const trade = state.openTrade;
        if (!trade) return;
        const bar = state.bars1h[state.cursor];
        const priceBar = priceBarAt(state.bars1h, state.bars15m, state.cursor, state.cursorMs);
        const exitPrice = price ?? priceBar?.close ?? bar?.close ?? trade.entryPrice;
        const exitTime = state.cursorMs >= 0 ? state.cursorMs : (bar?.time ?? Date.now());
        const closed = closeTrade(trade, exitTime, exitPrice, reason);
        const realized = state.closedTrades.reduce((s, t) => s + t.pnl, 0) + closed.pnl;
        const equity = DEFAULT_EQUITY + realized;
        const peak = Math.max(state.peakEquity, equity);
        set({
          openTrade: null,
          closedTrades: [...state.closedTrades, closed],
          equity,
          peakEquity: peak,
          maxDrawdown: Math.max(state.maxDrawdown, peak > 0 ? (peak - equity) / peak : 0),
          equityCurve: [...state.equityCurve, { time: closed.exitTime, equity, label: exitPrice }],
          pendingJournal: closed,
        });
        try {
          if (closed.serverId) {
            await api.updateTrade(closed.serverId, {
              exitTime: new Date(closed.exitTime).toISOString(),
              exitPrice: closed.exitPrice,
              exitReason: closed.exitReason,
              status: 'closed',
              rMultiple: closed.rMultiple,
              pnl: closed.pnl,
            });
          }
        } catch {
          /* ignore */
        }
      },

      saveJournal: async (payload) => {
        const pending = get().pendingJournal;
        if (!pending) return;
        const sid = get().sessionId;
        try {
          const entry = await api.createJournal({
            sessionId: sid,
            tradeId: pending.serverId ?? null,
            symbol: pending.symbol,
            market: get().market,
            setup: pending.setup,
            followedPlan: payload.followedPlan,
            emotion: payload.emotion,
            mistakeTag: payload.mistakeTag,
            content: payload.content,
            snapshot: {
              entry: pending.entryPrice,
              stop: pending.stopLoss,
              target: pending.takeProfit,
              exit: pending.exitPrice,
              r: pending.rMultiple,
              side: pending.side,
            },
          });
          set((s) => ({ journal: [entry, ...s.journal], pendingJournal: null }));
        } catch {
          // 落库失败也要放行复盘流程，但不能清空历史记录
          set({ pendingJournal: null });
        }
      },

      /**
       * 跳过复盘（v6）：关掉弹窗但不写内容。
       *
       * 语义：**不阻塞继续练习**，但记一条 skipped 标记，
       * 纪律统计里算「没复盘」，且顶栏显示待补数量 —— 事后可以补写。
       *
       * 为什么允许跳过：强制弹窗如果完全无法关闭，用户会被卡死（v5 的真实问题）。
       * 更好的做法是「允许跳过但留痕」—— 纪律指标照样能反映出来。
       */
      skipJournal: async () => {
        const pending = get().pendingJournal;
        if (!pending) return;
        const sid = get().sessionId;
        set({ pendingJournal: null });
        try {
          const entry = await api.createJournal({
            sessionId: sid,
            tradeId: pending.serverId ?? null,
            symbol: pending.symbol,
            market: get().market,
            setup: pending.setup,
            followedPlan: null,
            emotion: null,
            mistakeTag: null,
            content: '',
            skipped: true,
            snapshot: {
              entry: pending.entryPrice,
              stop: pending.stopLoss,
              target: pending.takeProfit,
              exit: pending.exitPrice,
              r: pending.rMultiple,
              side: pending.side,
            },
          });
          set((s) => ({ skippedJournal: [entry, ...s.skippedJournal] }));
        } catch {
          /* 落库失败不影响本地练习 */
        }
      },

      /** 补写之前跳过的复盘 */
      fillSkippedJournal: async (id, payload) => {
        try {
          const entry = await api.updateJournal(id, {
            followedPlan: payload.followedPlan,
            emotion: payload.emotion,
            mistakeTag: payload.mistakeTag,
            content: payload.content,
          });
          set((s) => ({
            skippedJournal: s.skippedJournal.filter((e) => e.id !== id),
            journal: [entry, ...s.journal],
          }));
        } catch (err) {
          throw err;
        }
      },

      /* ---- 账号 ---- */
      login: async (username, password) => {
        try {
          const { user, token } = await api.login(username, password);
          setToken(token);
          set({ user });
          return { ok: true };
        } catch (err) {
          return { ok: false, msg: (err as Error).message };
        }
      },

      register: async (username, password, displayName) => {
        try {
          const { user, token } = await api.register(username, password, displayName);
          setToken(token);
          set({ user });
          return { ok: true };
        } catch (err) {
          return { ok: false, msg: (err as Error).message };
        }
      },

      logout: async () => {
        try {
          await api.logout();
        } catch {
          /* ignore */
        }
        setToken(null);
        set({ user: null });
      },

      refreshStatsLater: () => {
        /* 占位：统计页自行拉取 */
      },
    }),
    {
      name: 'kline-practice-v1',
      partialize: (s) => ({
        symbol: s.symbol,
        market: s.market,
        cursor: s.cursor,
        cursorMs: s.cursorMs,
        startCursor: s.cursor,
        openTrade: s.openTrade,
        closedTrades: s.closedTrades,
        equity: s.equity,
        equityStart: s.equityStart,
        peakEquity: s.peakEquity,
        maxDrawdown: s.maxDrawdown,
        equityCurve: s.equityCurve,
        sessionId: s.sessionId,
        startMode: s.startMode,
        manualStartTime: s.manualStartTime,
        indicators4h: s.indicators4h,
        indicators1h: s.indicators1h,
        chartPeriod: s.chartPeriod,
        tradePanelOpen: s.tradePanelOpen,
      }),
    },
  ),
);

/** 便捷选择器 */
export const selectRevealed1h = (s: PracticeState): Bar[] => sliceRevealed(s.bars1h, s.cursor);
export const selectRevealed4h = (s: PracticeState): Bar[] => sliceRevealed(s.bars4h, s.cursor);

/**
 * e2e 测试钩子：把 store 挂到 window。
 *
 * 为什么要这个：验证脚本要可靠地驱动「开仓 → 平仓 → 强制复盘」这条链路。
 * 纯 DOM 点击会踩坑 —— 页面上有多个「市价平仓」语义的按钮、
 * React 受控表单的填充方式在不同 input 类型下行为不一致，
 * 靠选择器猜很容易测了个寂寞（而且失败时看不出是产品问题还是脚本问题）。
 *
 * 挂的是 getState（只读快照）+ action 引用，不做任何额外事情。
 * 跟 ChartPanel 的 window.__klineChart 是同一套惯例。
 */
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__practiceStore = usePracticeStore;
}
