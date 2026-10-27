import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../api';
import type {
  Bar,
  ClosedTrade,
  JournalEntry,
  Market,
  MarketInfo,
  OpenTrade,
  Setup,
  SymbolInfo,
  TradeSide,
} from '../types';
import { derive4h, sliceRevealed } from '../engine/bars';
import { checkExit, closeTrade, unrealizedPnl } from '../engine/trading';

export interface EquityPoint {
  time: number;
  equity: number;
  label?: string | number;
}

interface TradeDraft {
  side: TradeSide;
  stopLoss: number;
  takeProfit: number | null;
  riskPct: number;
  setup: string | null;
  checklist: Record<string, boolean>;
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
  loading: boolean;
  error: string | null;

  /* 回放 */
  cursor: number;
  startCursor: number;
  playing: boolean;
  speed: number;

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

  /* 会话 */
  sessionId: number | null;

  /* actions */
  bootstrap: () => Promise<void>;
  selectSymbol: (symbol: string, market?: Market) => Promise<void>;
  selectMarket: (market: Market) => Promise<void>;
  setSpeed: (ms: number) => void;
  startReplay: (fromIndex?: number) => Promise<void>;
  resetReplay: () => void;
  next: () => void;
  jump4h: () => void;
  play: () => void;
  pause: () => void;
  openPosition: (draft: TradeDraft) => Promise<{ ok: boolean; msg?: string }>;
  closePosition: (reason: ClosedTrade['exitReason'], price?: number) => Promise<void>;
  saveJournal: (payload: {
    followedPlan: boolean;
    emotion: string | null;
    mistakeTag: string | null;
    content: string;
  }) => Promise<void>;
  refreshStatsLater: () => void;
}

const DEFAULT_EQUITY = 10000;

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
      loading: false,
      error: null,

      cursor: -1,
      startCursor: -1,
      playing: false,
      speed: 1200,

      openTrade: null,
      closedTrades: [],
      equityStart: DEFAULT_EQUITY,
      equity: DEFAULT_EQUITY,
      peakEquity: DEFAULT_EQUITY,
      maxDrawdown: 0,
      equityCurve: [],

      pendingJournal: null,
      journal: [],

      sessionId: null,

      bootstrap: async () => {
        try {
          const [symbols, setups, markets] = await Promise.all([
            api.symbols(),
            api.setups(),
            api.markets(),
          ]);
          set({ symbols, setups, markets });

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
          set({ bars1h: [], bars4h: [], cursor: -1, openTrade: null, closedTrades: [] });
        }
      },

      selectSymbol: async (symbol, market) => {
        const m = market ?? get().market;
        set({ loading: true, error: null, symbol, market: m });
        try {
          const data = await api.klines(symbol, m, 1200);
          const bars1h = data.bars1h ?? [];
          const bars4h = data.bars4h ?? derive4h(bars1h);
          // 练习起点：留出足够的 4h 趋势上下文（≥120根 4h ≈ 480根 1h），其余作为「未来」供回放
          const start = Math.min(480, Math.max(120, Math.floor(bars1h.length * 0.4)));
          set({
            symbol,
            market: m,
            bars1h,
            bars4h,
            cursor: start,
            startCursor: start,
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
        } catch (err) {
          set({ error: (err as Error).message, loading: false });
        }
      },

      setSpeed: (ms) => set({ speed: ms }),

      startReplay: async (fromIndex) => {
        const { bars1h, symbol, market } = get();
        if (!bars1h.length) return;
        const cursor = fromIndex ?? get().cursor;
        set({
          cursor,
          startCursor: cursor,
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
          openTrade: null,
          closedTrades: [],
          equity: DEFAULT_EQUITY,
          peakEquity: DEFAULT_EQUITY,
          maxDrawdown: 0,
          equityCurve: [],
          pendingJournal: null,
        });
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
        startCursor: s.startCursor,
        openTrade: s.openTrade,
        closedTrades: s.closedTrades,
        equity: s.equity,
        equityStart: s.equityStart,
        peakEquity: s.peakEquity,
        maxDrawdown: s.maxDrawdown,
        equityCurve: s.equityCurve,
        sessionId: s.sessionId,
      }),
    },
  ),
);

/** 便捷选择器 */
export const selectRevealed1h = (s: PracticeState): Bar[] => sliceRevealed(s.bars1h, s.cursor);
export const selectRevealed4h = (s: PracticeState): Bar[] => sliceRevealed(s.bars4h, s.cursor);
