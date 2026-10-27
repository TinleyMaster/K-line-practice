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
  /** 后退一根 1h（回看） */
  prev: () => void;
  /** 后退一根 4h（回看） */
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
        const { cursor } = get();
        set({
          cursor: cursor >= 0 ? cursor : 0,
          maxCursor: cursor >= 0 ? cursor : 0,
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
       * 后退一根 1h —— 回看模式。
       *
       * 语义边界（刻意保守，避免制造「时间旅行」的错觉）：
       * - 只回看画面与浮动盈亏，**不撤销已平仓交易**（历史就是历史）；
       * - 持仓期间最多退回入场那根 —— 再往前退，「持仓」在时间上就不成立了；
       * - 权益曲线按游标截断，浮动盈亏按当前价重算；
       * - 回看时 maxCursor 不变，游标回到 maxCursor 即退出回看模式。
       */
      prev: () => {
        const state = get();
        const { bars1h, cursor, openTrade } = state;
        if (cursor <= 0) return;

        let target = cursor - 1;
        if (openTrade) {
          const entryIdx = bars1h.findIndex((b) => b.time === openTrade.entryTime);
          if (entryIdx >= 0 && target < entryIdx) target = entryIdx;
        }

        const bar = bars1h[target];
        if (!bar) return;

        const realized = state.closedTrades.reduce((s, t) => s + t.pnl, 0);
        const floating = openTrade ? unrealizedPnl(openTrade, bar.close) : 0;
        const equity = DEFAULT_EQUITY + realized + floating;

        set({
          cursor: target,
          playing: false,
          equity,
          equityCurve: state.equityCurve.filter((p) => p.time <= bar.time),
        });
      },

      /** 后退一根 4h（= 4 根 1h） */
      back4h: () => {
        for (let i = 0; i < 4; i++) get().prev();
      },

      next: () => {
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

      jump4h: () => {
        for (let i = 0; i < 4; i++) get().next();
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

        const entryPrice = bar.close;
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
          entryTime: bar.time,
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
        const exitPrice = price ?? bar?.close ?? trade.entryPrice;
        const closed = closeTrade(trade, bar?.time ?? Date.now(), exitPrice, reason);
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
