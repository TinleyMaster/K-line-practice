import { useMemo, useState } from 'react';
import type { Market, MarketInfo, SymbolInfo } from '../types';

interface Props {
  symbols: SymbolInfo[];
  markets: MarketInfo[];
  current: string;
  market: Market;
  onSelect: (symbol: string, market: Market) => void;
  onMarketChange: (market: Market) => void;
  loading?: boolean;
}

/** 链上美股的代币符号（AAPLON）展示时去掉 ON 后缀，还原成真实 ticker */
function displaySymbol(s: SymbolInfo): string {
  if (s.market === 'stock' && s.base) return s.base;
  return s.symbol;
}

export function SymbolPicker({
  symbols,
  markets,
  current,
  market,
  onSelect,
  onMarketChange,
  loading,
}: Props) {
  const [keyword, setKeyword] = useState('');

  const marketSymbols = useMemo(
    () => symbols.filter((s) => s.market === market && s.enabled),
    [symbols, market],
  );

  const filtered = useMemo(() => {
    const kw = keyword.trim().toUpperCase();
    const list = kw
      ? marketSymbols.filter(
          (s) => s.symbol.includes(kw) || (s.base ?? '').toUpperCase().includes(kw),
        )
      : marketSymbols;
    return [...list].sort((a, b) => {
      const ar = a.sortRank ?? 9999;
      const br = b.sortRank ?? 9999;
      if (ar !== br) return ar - br;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [marketSymbols, keyword]);

  const currentSymbol = symbols.find((s) => s.symbol === current && s.market === market);

  return (
    <div className="symbol-picker">
      <div className="market-tabs" role="tablist" aria-label="市场">
        {markets.map((m) => (
          <button
            key={m.market}
            role="tab"
            aria-selected={m.market === market}
            className={`market-tab ${m.market === market ? 'active' : ''}`}
            onClick={() => onMarketChange(m.market)}
            disabled={loading}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="symbol-picker-row">
        <input
          className="input"
          placeholder="搜索标的（BTC / ETH…）"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <select
          className="input select"
          value={currentSymbol ? current : ''}
          onChange={(e) => {
            const s = filtered.find((x) => x.symbol === e.target.value);
            if (s) onSelect(s.symbol, s.market);
          }}
          disabled={loading || filtered.length === 0}
        >
          {filtered.length === 0 && <option value="">（该市场暂无标的）</option>}
          {filtered.map((s) => (
            <option key={`${s.market}:${s.symbol}`} value={s.symbol}>
              {displaySymbol(s)}
              {s.bars ? ` · ${s.bars}根` : ' · 无数据'}
              {s.dataHealth ? ` · 真实成交${s.dataHealth.realRatioPct}%` : ''}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
