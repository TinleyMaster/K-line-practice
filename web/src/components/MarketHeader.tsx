import { useMemo } from 'react';
import type { Bar, Market } from '../types';
import { fmtPrice } from '../engine/bars';
import { dir, fmtCompact, fmtPct, fmtSigned } from '../engine/format';

interface Props {
  symbol: string;
  market: Market;
  marketLabel: string;
  /** 已揭示的 1h K 线（游标处的切片） */
  revealed: Bar[];
  /** 当前显示周期 */
  period: '4h' | '1h';
}

/**
 * 币安风格行情头。
 *
 * 结构照抄币安现货/合约页的顶部：左边是「交易对 + 最新价 + 涨跌」，
 * 右边一排 24h 统计（最高/最低/涨跌/成交量/成交额）。
 */
export function MarketHeader({ symbol, market, marketLabel, revealed, period }: Props) {
  const stats = useMemo(() => {
    if (!revealed.length) return null;
    const last = revealed[revealed.length - 1];
    const window = revealed.slice(-24);
    const high = Math.max(...window.map((b) => b.high));
    const low = Math.min(...window.map((b) => b.low));
    const volume = window.reduce((s, b) => s + b.volume, 0);
    const turnover = window.reduce((s, b) => s + b.quoteVolume, 0);
    const open = window[0].open;
    const chg = last.close - open;
    const chgPct = open ? (chg / open) * 100 : 0;
    return { last, high, low, volume, turnover, chg, chgPct };
  }, [revealed]);

  const tone = stats ? dir(stats.chg) : 0;
  const toneCls = tone === 1 ? 'up' : tone === -1 ? 'down' : '';

  return (
    <div className="market-head">
      <div className="market-head-left">
        <div className="market-head-title">
          <span className="market-symbol">{symbol}</span>
          <span className={`market-badge ${market}`}>{marketLabel}</span>
          <span className="market-period">{period}</span>
        </div>
        {stats && (
          <div className="market-price">
            <span className={`price-now ${toneCls}`}>{fmtPrice(stats.last.close)}</span>
            <span className={`price-chg ${toneCls}`}>
              {fmtSigned(stats.chg)} ({fmtPct(stats.chgPct)})
            </span>
          </div>
        )}
      </div>

      {stats && (
        <div className="market-head-stats">
          <Stat label="24h最高" value={fmtPrice(stats.high)} />
          <Stat label="24h最低" value={fmtPrice(stats.low)} />
          <Stat label="24h涨跌" value={fmtPct(stats.chgPct)} tone={tone} />
          <Stat label="24h量" value={fmtCompact(stats.volume)} />
          <Stat label="24h额" value={fmtCompact(stats.turnover)} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 1 | -1 | 0 }) {
  const cls = tone === 1 ? 'up' : tone === -1 ? 'down' : '';
  return (
    <div className="mh-stat">
      <span className="mh-stat-label">{label}</span>
      <span className={`mh-stat-value ${cls}`}>{value}</span>
    </div>
  );
}
