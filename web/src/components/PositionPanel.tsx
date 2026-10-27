import type { ClosedTrade, OpenTrade } from '../types';
import { fmtPrice } from '../engine/bars';
import { unrealizedPnl, unrealizedR, targetR } from '../engine/trading';

interface Props {
  openTrade: OpenTrade | null;
  closedTrades: ClosedTrade[];
  equity: number;
  equityStart: number;
  maxDrawdown: number;
  currentPrice: number;
  equityCurve: Array<{ time: number; equity: number }>;
  onClose: () => void;
}

export function PositionPanel({
  openTrade,
  closedTrades,
  equity,
  equityStart,
  maxDrawdown,
  currentPrice,
  equityCurve,
  onClose,
}: Props) {
  const totalR = closedTrades.reduce((s, t) => s + t.rMultiple, 0);
  const wins = closedTrades.filter((t) => t.rMultiple > 0).length;
  const pnl = openTrade ? unrealizedPnl(openTrade, currentPrice) : 0;
  const rNow = openTrade ? unrealizedR(openTrade, currentPrice) : 0;
  const upnlClass = pnl >= 0 ? 'up' : 'down';

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>持仓 / 绩效</h3>
        <span className="muted">{closedTrades.length} 笔已平</span>
      </div>

      {openTrade ? (
        <div className="position-box">
          <div className="position-head">
            <span className={`side-badge ${openTrade.side}`}>
              {openTrade.side === 'long' ? '多' : '空'} {openTrade.symbol}
            </span>
            {openTrade.setup && <span className="muted">· {openTrade.setup}</span>}
          </div>
          <div className="kv-grid">
            <div><span className="muted">入场</span><strong>{fmtPrice(openTrade.entryPrice)}</strong></div>
            <div><span className="muted">止损</span><strong className="down">{fmtPrice(openTrade.stopLoss)}</strong></div>
            <div>
              <span className="muted">目标</span>
              <strong className="up">{openTrade.takeProfit === null ? '未设' : fmtPrice(openTrade.takeProfit)}</strong>
            </div>
            <div><span className="muted">数量</span><strong>{openTrade.qty.toFixed(4)}</strong></div>
            <div><span className="muted">风险额</span><strong>${openTrade.riskAmount.toFixed(2)}</strong></div>
            <div>
              <span className="muted">计划目标</span>
              <strong>{targetR(openTrade) === null ? '—' : `${targetR(openTrade)!.toFixed(2)}R`}</strong>
            </div>
          </div>
          <div className="position-pnl">
            <div>
              <span className="muted">浮动盈亏</span>
              <strong className={upnlClass}>
                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
              </strong>
            </div>
            <div>
              <span className="muted">浮动 R</span>
              <strong className={upnlClass}>
                {rNow >= 0 ? '+' : ''}{rNow.toFixed(2)}R
              </strong>
            </div>
          </div>
          <button className="btn danger wide" onClick={onClose}>
            市价平仓
          </button>
        </div>
      ) : (
        <div className="empty">当前无持仓</div>
      )}

      <div className="stat-row">
        <div><span className="muted">权益</span><strong>${equity.toFixed(2)}</strong></div>
        <div>
          <span className="muted">累计 R</span>
          <strong className={totalR >= 0 ? 'up' : 'down'}>{totalR >= 0 ? '+' : ''}{totalR.toFixed(2)}R</strong>
        </div>
        <div>
          <span className="muted">胜率</span>
          <strong>
            {closedTrades.length ? `${((wins / closedTrades.length) * 100).toFixed(0)}%` : '—'}
          </strong>
        </div>
        <div>
          <span className="muted">最大回撤</span>
          <strong className="down">{(maxDrawdown * 100).toFixed(1)}%</strong>
        </div>
      </div>

      <EquityCurve equityStart={equityStart} points={equityCurve} />
    </div>
  );
}

function EquityCurve({
  equityStart,
  points,
}: {
  equityStart: number;
  points: Array<{ time: number; equity: number }>;
}) {
  if (points.length < 2) {
    return <div className="muted small">起始权益 ${equityStart.toFixed(2)}</div>;
  }
  const W = 320;
  const H = 90;
  const values = points.map((p) => p.equity);
  const min = Math.min(...values, equityStart);
  const max = Math.max(...values, equityStart);
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / span) * H;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
  const baseY = y(equityStart);
  const last = values[values.length - 1];
  const up = last >= equityStart;

  return (
    <div className="equity-curve">
      <div className="equity-curve-head">
        <span className="muted">权益曲线</span>
        <strong className={up ? 'up' : 'down'}>
          {up ? '+' : ''}${((last - equityStart) / equityStart * 100).toFixed(2)}%
        </strong>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="equity-svg">
        <line x1="0" y1={baseY} x2={W} y2={baseY} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" />
        <path d={d} fill="none" stroke={up ? '#ef4d4d' : '#22c55e'} strokeWidth="1.6" />
      </svg>
    </div>
  );
}
