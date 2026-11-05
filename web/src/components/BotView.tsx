import { useState } from 'react';
import { api } from '../api';
import { usePracticeStore } from '../store/usePracticeStore';
import type { Bar, ChartPeriod, Market } from '../types';
import {
  getStrategy,
  pinbarTrendStrategy,
  runBacktest,
  SIGNAL_MODULES,
  type BacktestResult,
  type StrategyParams,
} from '../engine/strategy';

interface Props {
  onShowMarkers: (
    markers: { time: number; price: number; side: 'long' | 'short'; kind: 'entry' | 'exit' }[],
  ) => void;
}

const DEFAULT_PARAMS: StrategyParams = {
  signals: { pinbar: true },
  trendEnabled: true,
  trendPeriod: 60,
  requireTrendAligned: true,
  stopType: 'signal',
  atrPeriod: 14,
  atrMult: 2,
  takeProfitR: 2,
  riskPct: 1,
  maxConcurrent: 1,
  startEquity: 10000,
  feeRate: 0.0004,
  slippageBps: 0,
};

function fmt(n: number, d = 2): string {
  if (!Number.isFinite(n)) return '∞';
  return n.toFixed(d);
}
function fmtPct(n: number, d = 1): string {
  if (!Number.isFinite(n)) return '∞';
  return (n * 100).toFixed(d) + '%';
}

/** 内联 SVG 权益曲线 */
function EquityCurve({ curve }: { curve: { time: number; equity: number }[] }) {
  if (curve.length < 2) return <div className="muted">样本不足，无法绘制曲线</div>;
  const w = 640;
  const h = 180;
  const pad = 8;
  const vals = curve.map((c) => c.equity);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const xs = (i: number) => pad + (i / (curve.length - 1)) * (w - pad * 2);
  const ys = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = curve.map((c, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(c.equity).toFixed(1)}`).join(' ');
  const baseY = ys(curve[0].equity);
  const up = curve[curve.length - 1].equity >= curve[0].equity;
  const color = up ? '#0ECB81' : '#F6465D';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="bot-equity" preserveAspectRatio="none">
      <line x1={pad} y1={baseY} x2={w - pad} y2={baseY} stroke="#2b3139" strokeDasharray="3 3" />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

export function BotView({ onShowMarkers }: Props) {
  const store = usePracticeStore();
  const [symbol, setSymbol] = useState(store.symbol || 'BTCUSDT');
  const [market, setMarket] = useState<string>(store.market || 'perp');
  const [period, setPeriod] = useState<ChartPeriod>('1h');
  const [params, setParams] = useState<StrategyParams>(DEFAULT_PARAMS);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ran, setRan] = useState(false);

  const patch = (p: Partial<StrategyParams>) => setParams((s) => ({ ...s, ...p }));

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const sym = symbol.trim().toUpperCase();
      if (!sym) throw new Error('请填写标的');
      const resp = await api.klines(sym, market as Market, 1500);
      const bars: Bar[] | undefined =
        period === '1h' ? resp.bars1h : period === '4h' ? resp.bars4h : resp.bars15m;
      if (!bars || bars.length < params.trendPeriod + 10) {
        throw new Error(
          `该标的/周期历史不足（仅有 ${bars?.length ?? 0} 根，需 > ${params.trendPeriod + 10}）。`,
        );
      }
      const strat = getStrategy(pinbarTrendStrategy.name);
      const res = runBacktest(bars, strat, params, { symbol: sym, market: market as Market, period });
      setResult(res);
      setRan(true);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const showMarkers = () => {
    if (!result) return;
    const markers: { time: number; price: number; side: 'long' | 'short'; kind: 'entry' | 'exit' }[] =
      [];
    for (const t of result.trades) {
      markers.push({ time: t.entryTime, price: t.entryPrice, side: t.side, kind: 'entry' });
      markers.push({ time: t.exitTime, price: t.exitPrice, side: t.side, kind: 'exit' });
    }
    onShowMarkers(markers);
  };

  const s = result?.stats;

  return (
    <div className="full-view bot-view">
      <div className="bot-head">
        <h2>自动交易（模拟盘）</h2>
        <span className="muted">
          代码按「信号 → 决策 → 执行」分层自动开平仓，不夹带情绪。先看模拟闭环，实盘适配层后续接入。
        </span>
      </div>

      {error && <div className="notice error banner">{error}</div>}

      <div className="bot-grid">
        {/* 左：标的选择 + 参数 */}
        <div className="bot-panel">
          <h3>标的选择</h3>
          <div className="bot-row">
            <label>
              标的
              <input
                className="input"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="BTCUSDT"
              />
            </label>
            <label>
              市场
              <select className="input" value={market} onChange={(e) => setMarket(e.target.value)}>
                <option value="perp">合约</option>
                <option value="spot">现货</option>
                <option value="stock">链上美股</option>
              </select>
            </label>
            <label>
              周期
              <select
                className="input"
                value={period}
                onChange={(e) => setPeriod(e.target.value as ChartPeriod)}
              >
                <option value="1h">1h</option>
                <option value="4h">4h</option>
                <option value="15m">15m</option>
              </select>
            </label>
          </div>

          <h3>信号（可插拔）</h3>
          <div className="bot-signals">
            {SIGNAL_MODULES.map((m) => (
              <label key={m.name} className="bot-check" title={m.description}>
                <input
                  type="checkbox"
                  checked={!!params.signals[m.name]}
                  onChange={(e) => patch({ signals: { ...params.signals, [m.name]: e.target.checked } })}
                />
                {m.label}
              </label>
            ))}
          </div>

          <h3>趋势过滤</h3>
          <div className="bot-row">
            <label className="bot-check">
              <input
                type="checkbox"
                checked={params.trendEnabled}
                onChange={(e) => patch({ trendEnabled: e.target.checked })}
              />
              启用
            </label>
            <label>
              均线周期
              <input
                className="input num"
                type="number"
                value={params.trendPeriod}
                disabled={!params.trendEnabled}
                onChange={(e) => patch({ trendPeriod: Number(e.target.value) })}
              />
            </label>
            <label className="bot-check">
              <input
                type="checkbox"
                checked={params.requireTrendAligned}
                disabled={!params.trendEnabled}
                onChange={(e) => patch({ requireTrendAligned: e.target.checked })}
              />
              仅顺势
            </label>
          </div>

          <h3>止损 / 止盈</h3>
          <div className="bot-row">
            <label>
              止损方式
              <select
                className="input"
                value={params.stopType}
                onChange={(e) => patch({ stopType: e.target.value as StrategyParams['stopType'] })}
              >
                <option value="signal">信号鼻线</option>
                <option value="atr">ATR 倍数</option>
              </select>
            </label>
            {params.stopType === 'atr' && (
              <>
                <label>
                  ATR 周期
                  <input
                    className="input num"
                    type="number"
                    value={params.atrPeriod}
                    onChange={(e) => patch({ atrPeriod: Number(e.target.value) })}
                  />
                </label>
                <label>
                  ATR 倍数
                  <input
                    className="input num"
                    type="number"
                    value={params.atrMult}
                    onChange={(e) => patch({ atrMult: Number(e.target.value) })}
                  />
                </label>
              </>
            )}
            <label>
              止盈 (R)
              <input
                className="input num"
                type="number"
                step="0.5"
                value={params.takeProfitR}
                onChange={(e) => patch({ takeProfitR: Number(e.target.value) })}
              />
            </label>
          </div>

          <h3>仓位 / 成本</h3>
          <div className="bot-row">
            <label>
              单笔风险 %
              <input
                className="input num"
                type="number"
                step="0.1"
                value={params.riskPct}
                onChange={(e) => patch({ riskPct: Number(e.target.value) })}
              />
            </label>
            <label>
              起始权益
              <input
                className="input num"
                type="number"
                value={params.startEquity}
                onChange={(e) => patch({ startEquity: Number(e.target.value) })}
              />
            </label>
            <label>
              手续费 %
              <input
                className="input num"
                type="number"
                step="0.01"
                value={params.feeRate * 100}
                onChange={(e) => patch({ feeRate: Number(e.target.value) / 100 })}
              />
            </label>
            <label>
              滑点 (bp)
              <input
                className="input num"
                type="number"
                value={params.slippageBps}
                onChange={(e) => patch({ slippageBps: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="bot-actions">
            <button className="btn primary" onClick={run} disabled={loading}>
              {loading ? '回测中…' : '运行模拟'}
            </button>
            <button className="btn ghost" onClick={showMarkers} disabled={!result}>
              在图表上标记
            </button>
          </div>
        </div>

        {/* 右：结果 */}
        <div className="bot-panel">
          <h3>回测结果</h3>
          {!ran && !loading && <div className="muted">配置参数后点「运行模拟」，这里会显示 R / 胜率 / 回撤。</div>}
          {loading && <div className="muted">正在跑模拟…</div>}
          {result && s && (
            <>
              <div className="bot-stats">
                <Stat label="交易笔数" value={String(s.trades)} />
                <Stat label="胜率" value={fmtPct(s.winRate)} />
                <Stat label="总 R" value={fmt(s.totalR)} highlight={s.totalR >= 0} />
                <Stat label="平均 R" value={fmt(s.avgR)} highlight={s.avgR >= 0} />
                <Stat label="盈亏比" value={s.profitFactor == null ? '—' : fmt(s.profitFactor)} />
                <Stat label="最大回撤" value={fmtPct(s.maxDrawdown)} />
                <Stat label="期望 R" value={fmt(s.expectancy)} highlight={s.expectancy >= 0} />
                <Stat label="平均持仓" value={`${fmt(s.avgHoldBars, 1)} 根`} />
              </div>

              <h4>权益曲线（起始 {fmt(params.startEquity, 0)}）</h4>
              <EquityCurve curve={result.equityCurve} />

              <h4>成交明细（{result.trades.length}）</h4>
              <div className="bot-trades">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>方向</th>
                      <th>信号</th>
                      <th>入场</th>
                      <th>出场</th>
                      <th>原因</th>
                      <th>R</th>
                      <th>盈亏</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.slice(0, 120).map((t, i) => (
                      <tr key={t.id}>
                        <td>{i + 1}</td>
                        <td className={t.side === 'long' ? 'up' : 'down'}>
                          {t.side === 'long' ? '多' : '空'}
                        </td>
                        <td>{t.signal}</td>
                        <td>{t.entryPrice.toFixed(2)}</td>
                        <td>{t.exitPrice.toFixed(2)}</td>
                        <td>
                          {t.exitReason === 'stop'
                            ? '止损'
                            : t.exitReason === 'target'
                              ? '止盈'
                              : '收尾'}
                        </td>
                        <td className={t.rMultiple >= 0 ? 'up' : 'down'}>{fmt(t.rMultiple)}R</td>
                        <td className={t.pnl >= 0 ? 'up' : 'down'}>{fmt(t.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.trades.length > 120 && (
                  <div className="muted">仅显示前 120 笔，共 {result.trades.length} 笔。</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`bot-stat ${highlight === true ? 'pos' : highlight === false ? 'neg' : ''}`}>
      <span className="bot-stat-v">{value}</span>
      <span className="bot-stat-l">{label}</span>
    </div>
  );
}
