import type {
  JournalEntry,
  KlinesResponse,
  Market,
  MarketInfo,
  PkResponse,
  SessionInfo,
  Setup,
  StatsResponse,
  SymbolInfo,
  User,
} from './types';

const BASE = '/api';

/**
 * 登录 token（v6）。
 *
 * 存 localStorage：刷新不丢。同一台机器两人共用浏览器时用不同浏览器/无痕窗口即可。
 */
const TOKEN_KEY = 'kline-practice-token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下 localStorage 不可用，忽略 */
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; db: { ok: boolean } }>('/health'),

  markets: () => request<MarketInfo[]>('/symbols/markets'),

  symbols: (market?: Market) =>
    request<SymbolInfo[]>(market ? `/symbols?market=${market}` : '/symbols'),

  klines: (symbol: string, market: Market = 'perp', limit = 1200) =>
    request<KlinesResponse>(
      `/klines?symbol=${encodeURIComponent(symbol)}&market=${market}&interval=both&limit=${limit}`,
    ),

  /**
   * 向左无限加载历史 K 线：取 `before` 时间之前的最近 `limit` 根（升序）。
   * 用于图表滚动/缩放到左边缘时增量补齐「起点之前」的上下文。
   */
  klinesHistory: (
    symbol: string,
    market: Market = 'perp',
    interval: '1h' | '15m' | '4h' = '1h',
    before: number,
    limit = 500,
  ) =>
    request<{
      symbol: string;
      market: Market;
      interval: string;
      before: number;
      limit: number;
      count: number;
      exhausted: boolean;
      bars: import('./types').Bar[];
    }>(
      `/klines/${encodeURIComponent(symbol)}/history?market=${market}&interval=${interval}&before=${before}&limit=${limit}`,
    ),

  backfill: (market: Market, symbol: string, days = 365, interval = '1h') =>
    request<Record<string, unknown>>('/klines/backfill', {
      method: 'POST',
      body: JSON.stringify({ market, symbol, days, interval }),
    }),

  syncStockSymbols: (limit = 40) =>
    request<Record<string, unknown>>('/symbols/sync-stock', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),

  setups: () => request<Setup[]>('/setups'),

  createSetup: (payload: Partial<Setup>) =>
    request<Setup>('/setups', { method: 'POST', body: JSON.stringify(payload) }),

  updateSetup: (id: number, payload: Partial<Setup>) =>
    request<Setup>(`/setups/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  sessions: () => request<SessionInfo[]>('/sessions'),

  createSession: (payload: Record<string, unknown>) =>
    request<SessionInfo>('/sessions', { method: 'POST', body: JSON.stringify(payload) }),

  updateSession: (id: number, payload: Record<string, unknown>) =>
    request<SessionInfo>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  createTrade: (payload: Record<string, unknown>) =>
    request<Record<string, unknown>>('/trades', { method: 'POST', body: JSON.stringify(payload) }),

  updateTrade: (id: number, payload: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/trades/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  createJournal: (payload: Record<string, unknown>) =>
    request<JournalEntry>('/journal', { method: 'POST', body: JSON.stringify(payload) }),

  /** 补写之前跳过的复盘 */
  updateJournal: (id: number, payload: Record<string, unknown>) =>
    request<JournalEntry>(`/journal/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),

  journal: () => request<JournalEntry[]>('/journal'),

  stats: (params?: { symbol?: string; setup?: string }) => {
    const q = new URLSearchParams();
    if (params?.symbol) q.set('symbol', params.symbol);
    if (params?.setup) q.set('setup', params.setup);
    const qs = q.toString();
    return request<StatsResponse>(`/stats${qs ? `?${qs}` : ''}`);
  },

  /* ---- 账号（v6）---- */
  register: (username: string, password: string, displayName?: string) =>
    request<{ user: User; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, displayName }),
    }),

  login: (username: string, password: string) =>
    request<{ user: User; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () => request<{ user: User | null }>('/auth/me'),

  pk: () => request<PkResponse>('/auth/pk'),

  /* ---- 回测（v7）---- */
  backtestRun: (params: Record<string, unknown>) =>
    request<Record<string, unknown>>('/backtest/run', { method: 'POST', body: JSON.stringify(params) }),
  backtestOptimize: (params: Record<string, unknown>) =>
    request<Record<string, unknown>>('/backtest/optimize', { method: 'POST', body: JSON.stringify(params) }),
};
