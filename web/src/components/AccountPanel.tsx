import type { ClosedTrade, OpenTrade } from '../types';
import { fmtPrice } from '../engine/bars';
import { dir, fmtSigned } from '../engine/format';

interface Props {
  equity: number;
  equityStart: number;
  openTrade: OpenTrade | null;
  closedTrades: ClosedTrade[];
  maxDrawdown: number;
  currentPrice: number;
}

/**
 * 侧栏「练习账户」概览。
 *
 * 币安的下单面板下方就是账户与持仓摘要，这里做同样的事：
 * 一眼看清「这次练习现在赚没赚、做了几笔、胜率多少」。
 */
export function AccountPanel({
  equity,
  equityStart,
  openTrade,
  closedTrades,
  maxDrawdown,
  currentPrice,
}: Props) {
  const realized = closedTrades.reduce((s, t) => s + t.pnl, 0);
  const totalR = closedTrades.reduce((s, t) => s + t.rMultiple, 0);
  const wins = closedTrades.filter((t) => t.pnl > 0).length;
  const winRate = closedTrades.length ? (wins / closedTrades.length) * 100 : 0;
  const floating = openTrade
    ? (openTrade.side === 'long'
        ? (currentPrice - openTrade.entryPrice) * openTrade.qty
        : (openTrade.entryPrice - currentPrice) * openTrade.qty)
    : 0;
  const total = equity - equityStart;
  const tone = dir(total);

  return (
    <div className="panel account-panel">
      <div className="panel-head">
        <h3>练习账户</h3>
        <span className="muted small">{closedTrades.length} 笔已平</span>
      </div>

      <div className="account-equity">
        <span className="muted small">当前权益</span>
        <strong className={tone === 1 ? 'up' : tone === -1 ? 'down' : ''}>
          ${fmtPrice(equity)}
        </strong>
        <span className={`account-pnl ${tone === 1 ? 'up' : tone === -1 ? 'down' : ''}`}>
          {fmtSigned(total)}（{equityStart > 0 ? ((total / equityStart) * 100).toFixed(2) : '0.00'}%）
        </span>
      </div>

      <div className="account-grid">
        <div>
          <span className="muted small">已实现</span>
          <strong className={dir(realized) === 1 ? 'up' : dir(realized) === -1 ? 'down' : ''}>
            {fmtSigned(realized)}
          </strong>
        </div>
        <div>
          <span className="muted small">浮动</span>
          <strong className={dir(floating) === 1 ? 'up' : dir(floating) === -1 ? 'down' : ''}>
            {fmtSigned(floating)}
          </strong>
        </div>
        <div>
          <span className="muted small">累计R</span>
          <strong className={dir(totalR) === 1 ? 'up' : dir(totalR) === -1 ? 'down' : ''}>
            {fmtSigned(totalR)}
          </strong>
        </div>
        <div>
          <span className="muted small">胜率</span>
          <strong>{closedTrades.length ? `${winRate.toFixed(0)}%` : '—'}</strong>
        </div>
        <div>
          <span className="muted small">最大回撤</span>
          <strong>{(maxDrawdown * 100).toFixed(2)}%</strong>
        </div>
        <div>
          <span className="muted small">持仓</span>
          <strong>{openTrade ? (openTrade.side === 'long' ? '多' : '空') : '空仓'}</strong>
        </div>
      </div>
    </div>
  );
}
