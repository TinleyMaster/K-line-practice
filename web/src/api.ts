import type {
  JournalEntry,
  KlinesResponse,
  Market,
  MarketInfo,
  SessionInfo,
  Setup,
  StatsResponse,
  SymbolInfo,
} from './types';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
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

  backfill: (market: Market, symbol: string, days = 365) =>
    request<Record<string, unknown>>('/klines/backfill', {
      method: 'POST',
      body: JSON.stringify({ market, symbol, days }),
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

  journal: () => request<JournalEntry[]>('/journal'),

  stats: (params?: { symbol?: string; setup?: string }) => {
    const q = new URLSearchParams();
    if (params?.symbol) q.set('symbol', params.symbol);
    if (params?.setup) q.set('setup', params.setup);
    const qs = q.toString();
    return request<StatsResponse>(`/stats${qs ? `?${qs}` : ''}`);
  },
};
