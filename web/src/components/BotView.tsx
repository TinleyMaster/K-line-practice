import { useState } from 'react';
import { api } from '../api';
import { usePracticeStore } from '../store/usePracticeStore';
import type { Bar, ChartPeriod, Market } from '../types';
import {
  getStrategy,
  runBacktest,
  runMultiBacktest,
  sweepParams,
  SIGNAL_MODULES,
  STRATEGIES,
  type BacktestResult,
  type BacktestStats,
  type MultiResult,
  type StrategyParams,
  type SweepRow,
} from '../engine/strategy';

interface Props {
  onShowMarkers: (
    markers: { time: number; price: number; side: 'long' | 'short'; kind: 'entry' | 'exit' }[],
  ) => void;
}

type Mode = 'single' | 'batch' | 'sweep';

const DEFAULT_PARAMS: StrategyParams = {
  signals: { pinbar: false, trend_pullback: true, mean_reversion: true, funding_extreme: false },
  trendEnabled: true,
  trendPeriod: 60,
  requireTrendAligned: true,
  stopType: 'signal',
  atrPeriod: 20,
  atrMult: 2,
  takeProfitR: 2,
  exitType: 'target',
  maxConcurrent: 1,
  regimeWindow: 30,
  regimeHi: 0.4,
  regimeLo: 0.2,
  fundingWindow: 60,
  fundingZ: 2.5,
  fundingMode: 'contrarian',
  riskPct: 1,
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

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`bot-stat ${highlight === true ? 'pos' : highlight === false ? 'neg' : ''}`}>
      <span className="bot-stat-v">{value}</span>
      <span className="bot-stat-l">{label}</span>
    </div>
  );
}

function StatsGrid({ s }: { s: BacktestStats }) {
  return (
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
  );
}

async function fetchBars(
  symbol: string,
  market: string,
  period: ChartPeriod,
): Promise<Bar[] | null> {
  const resp = await api.klines(symbol, market as Market, 1500);
  const bars =
    period === '1h' ? resp.bars1h : period === '4h' ? resp.bars4h : resp.bars15m;
  return bars && bars.length ? bars : null;
}

export function BotView({ onShowMarkers }: Props) {
  const store = usePracticeStore();
  const [symbol, setSymbol] = useState(store.symbol || 'BTCUSDT');
  const [market, setMarket] = useState<string>(store.market || 'perp');
  const [period, setPeriod] = useState<ChartPeriod>('1h');
  const [params, setParams] = useState<StrategyParams>(DEFAULT_PARAMS);
  const [mode, setMode] = useState<Mode>('single');
  const [strategyName, setStrategyName] = useState<string>('regime_switch');

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [multi, setMulti] = useState<MultiResult | null>(null);
  const [sweep, setSweep] = useState<SweepRow[] | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ran, setRan] = useState(false);

  // 批量模式：标的列表（逗号分隔）+ 样本外切分开关
  const [symbolsText, setSymbolsText] = useState('BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT');
  const [split, setSplit] = useState(true);

  const patch = (p: Partial<StrategyParams>) => setParams((s) => ({ ...s, ...p }));
  const clearResults = () => {
    setResult(null);
    setMulti(null);
    setSweep(null);
  };

  const strategy = getStrategy(strategyName);

  const run = async () => {
    setLoading(true);
    setError(null);
    clearResults();
    try {
      if (mode === 'single' || mode === 'sweep') {
        const sym = symbol.trim().toUpperCase();
        if (!sym) throw new Error('请填写标的');
        const bars = await fetchBars(sym, market, period);
        if (!bars || bars.length < params.trendPeriod + 10) {
          throw new Error(`该标的/周期历史不足（仅有 ${bars?.length ?? 0} 根）。`);
        }
        const ctx = { symbol: sym, market: market as Market, period };
        if (mode === 'single') {
          setResult(runBacktest(bars, strategy, params, ctx));
        } else {
          const ranges = [
            { key: 'takeProfitR' as const, values: [1.5, 2, 3] },
            { key: 'trendPeriod' as const, values: [40, 60, 90] },
          ];
          setSweep(sweepParams(bars, ctx, strategy, params, ranges));
        }
      } else {
        const syms = symbolsText
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
        if (syms.length === 0) throw new Error('请填写至少一个标的');
        const specs = [];
        for (const sym of syms) {
          try {
            const bars = await fetchBars(sym, market, period);
            if (bars) specs.push({ bars, ctx: { symbol: sym, market: market as Market, period } });
          } catch {
            /* 单个失败不影响其他 */
          }
        }
        if (specs.length === 0) throw new Error('没有可用历史（检查市场/周期/网络）。');
        setMulti(runMultiBacktest(specs, strategy, params, { split }));
      }
      setRan(true);
    } catch (e) {
      setError((e as Error).message);
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
        <h2>自动交易（模拟盘验证）</h2>
        <span className="muted">
          代码按「信号 → 决策 → 执行」分层自动开平仓，不夹带情绪。先验证有没有正期望，实盘适配层后续接入。
        </span>
      </div>

      <div className="bot-modes">
        <button className={`bot-mode ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>
          单标的回测
        </button>
        <button className={`bot-mode ${mode === 'batch' ? 'active' : ''}`} onClick={() => setMode('batch')}>
          多标的验证
        </button>
        <button className={`bot-mode ${mode === 'sweep' ? 'active' : ''}`} onClick={() => setMode('sweep')}>
          参数扫描
        </button>
      </div>

      {error && <div className="notice error banner">{error}</div>}

      <div className="bot-grid">
        {/* 左：标的选择 + 参数（三种模式共用） */}
        <div className="bot-panel">
          <h3>标的选择</h3>
          {mode === 'batch' ? (
            <label className="bot-full">
              标的列表（逗号分隔）
              <input
                className="input"
                value={symbolsText}
                onChange={(e) => setSymbolsText(e.target.value)}
                placeholder="BTCUSDT, ETHUSDT, SOLUSDT"
              />
            </label>
          ) : (
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
          )}

          {mode === 'batch' && (
            <div className="bot-row" style={{ marginTop: 8 }}>
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
              <label className="bot-check">
                <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
                样本外切分
              </label>
            </div>
          )}
          {mode === 'batch' && (
            <div className="muted bot-hint">
              切分：前 60% 训练段 / 后 40% 测试段，用同一参数跑两段。训练赚、测试亏 = 过拟合预警。
            </div>
          )}

          <h3>策略（分层引擎）</h3>
          <div className="bot-row">
            <label>
              策略
              <select
                className="input"
                value={strategyName}
                onChange={(e) => setStrategyName(e.target.value)}
              >
                {STRATEGIES.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {strategyName === 'regime_switch' && (
            <div className="bot-hint muted">
              按"效率比"判定趋势/震荡市：趋势市放行顺势信号、震荡市放行均值回归。需同时勾选两类信号。
            </div>
          )}

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

          <h3>Regime 切换（仅元策略用）</h3>
          <div className="bot-row">
            <label>
              效率比窗口
              <input
                className="input num"
                type="number"
                value={params.regimeWindow}
                onChange={(e) => patch({ regimeWindow: Number(e.target.value) })}
              />
            </label>
            <label>
              趋势阈值 ≥
              <input
                className="input num"
                type="number"
                step="0.05"
                value={params.regimeHi}
                onChange={(e) => patch({ regimeHi: Number(e.target.value) })}
              />
            </label>
            <label>
              震荡阈值 ≤
              <input
                className="input num"
                type="number"
                step="0.05"
                value={params.regimeLo}
                onChange={(e) => patch({ regimeLo: Number(e.target.value) })}
              />
            </label>
          </div>

          <h3>资金费率信号（更根本的 edge）</h3>
          <div className="bot-row">
            <label>
              逻辑
              <select
                className="input"
                value={params.fundingMode}
                onChange={(e) => patch({ fundingMode: e.target.value as StrategyParams['fundingMode'] })}
              >
                <option value="contrarian">极端反向（crowd 站错边）</option>
                <option value="carry">收租（顺势收 funding）</option>
              </select>
            </label>
            <label>
              z 窗口
              <input
                className="input num"
                type="number"
                value={params.fundingWindow}
                onChange={(e) => patch({ fundingWindow: Number(e.target.value) })}
              />
            </label>
            <label>
              触发 |z| ≥
              <input
                className="input num"
                type="number"
                step="0.1"
                value={params.fundingZ}
                onChange={(e) => patch({ fundingZ: Number(e.target.value) })}
              />
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
                disabled={params.exitType === 'trail'}
                onChange={(e) => patch({ takeProfitR: Number(e.target.value) })}
              />
            </label>
            <label>
              出场方式
              <select
                className="input"
                value={params.exitType}
                onChange={(e) => patch({ exitType: e.target.value as StrategyParams['exitType'] })}
              >
                <option value="target">固定 R 止盈</option>
                <option value="trail">趋势翻转离场（让利润奔跑）</option>
              </select>
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
              {loading ? '运行中…' : '运行'}
            </button>
            {mode === 'single' && (
              <button className="btn ghost" onClick={showMarkers} disabled={!result}>
                在图表上标记
              </button>
            )}
          </div>
        </div>

        {/* 右：结果 */}
        <div className="bot-panel">
          <h3>结果</h3>
          {!ran && !loading && <div className="muted">配置参数后点「运行」，这里显示验证结果。</div>}
          {loading && <div className="muted">正在运行…</div>}

          {/* 单标的 */}
          {result && s && (
            <>
              <StatsGrid s={s} />
              <h4>权益曲线（起始 {fmt(params.startEquity, 0)}）</h4>
              <EquityCurve curve={result.equityCurve} />
              <h4>成交明细（{result.trades.length}）</h4>
              <TradesTable trades={result.trades} limit={120} />
            </>
          )}

          {/* 多标的验证 */}
          {multi && (
            <>
              <h4>组合聚合</h4>
              <StatsGrid s={multi.aggregate} />
              {multi.split && multi.aggregateTrain && multi.aggregateTest && (
                <div className="bot-consistency">
                  <span>训练段总 R：<b className={multi.aggregateTrain.totalR >= 0 ? 'up' : 'down'}>{fmt(multi.aggregateTrain.totalR)}</b></span>
                  <span>测试段总 R：<b className={multi.aggregateTest.totalR >= 0 ? 'up' : 'down'}>{fmt(multi.aggregateTest.totalR)}</b></span>
                  <span className={multi.aggregateTrain.totalR > 0 && multi.aggregateTest.totalR > 0 ? 'up' : multi.aggregateTrain.totalR > 0 && multi.aggregateTest.totalR <= 0 ? 'down' : ''}>
                    {multi.aggregateTrain.totalR > 0 && multi.aggregateTest.totalR > 0
                      ? '✓ 训练测试同向为正，edge 较稳'
                      : multi.aggregateTrain.totalR > 0 && multi.aggregateTest.totalR <= 0
                        ? '⚠ 训练赚测试亏，疑似过拟合'
                        : '—'}
                  </span>
                </div>
              )}
              <h4>分标的</h4>
              <div className="bot-trades">
                <table>
                  <thead>
                    <tr>
                      <th>标的</th>
                      <th>交易</th>
                      <th>胜率</th>
                      <th>总R</th>
                      <th>回撤</th>
                      <th>盈亏比</th>
                      {multi.split && <th>训练R</th>}
                      {multi.split && <th>测试R</th>}
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {multi.rows.map((r) => (
                      <tr key={r.symbol}>
                        <td>{r.symbol}</td>
                        <td>{r.full.trades}</td>
                        <td>{fmtPct(r.full.winRate)}</td>
                        <td className={r.full.totalR >= 0 ? 'up' : 'down'}>{fmt(r.full.totalR)}</td>
                        <td>{fmtPct(r.full.maxDrawdown)}</td>
                        <td>{r.full.profitFactor == null ? '—' : fmt(r.full.profitFactor)}</td>
                        {multi.split && <td className={(r.train?.totalR ?? 0) >= 0 ? 'up' : 'down'}>{r.train ? fmt(r.train.totalR) : '—'}</td>}
                        {multi.split && <td className={(r.test?.totalR ?? 0) >= 0 ? 'up' : 'down'}>{r.test ? fmt(r.test.totalR) : '—'}</td>}
                        <td>{r.skipped ?? 'OK'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* 参数扫描 */}
          {sweep && (
            <>
              <h4>参数敏感度（按总 R 降序，{sweep.length} 组）</h4>
              <div className="bot-trades">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>止盈R</th>
                      <th>均线</th>
                      <th>交易</th>
                      <th>胜率</th>
                      <th>总R</th>
                      <th>盈亏比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sweep.map((row, i) => (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td>{row.params.takeProfitR}</td>
                        <td>{row.params.trendPeriod}</td>
                        <td>{row.stats.trades}</td>
                        <td>{fmtPct(row.stats.winRate)}</td>
                        <td className={row.stats.totalR >= 0 ? 'up' : 'down'}>{fmt(row.stats.totalR)}</td>
                        <td>{row.stats.profitFactor == null ? '—' : fmt(row.stats.profitFactor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="muted bot-hint">
                看总 R 在 止盈R / 均线 两列上的波动：若总 R 随参数剧烈跳变，说明策略在该样本上脆弱（好参数可能只是过拟合）；若多数组稳定为正，edge 更可信。
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TradesTable({ trades, limit }: { trades: BacktestResult['trades']; limit: number }) {
  return (
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
          {trades.slice(0, limit).map((t, i) => (
            <tr key={t.id}>
              <td>{i + 1}</td>
              <td className={t.side === 'long' ? 'up' : 'down'}>{t.side === 'long' ? '多' : '空'}</td>
              <td>{t.signal}</td>
              <td>{t.entryPrice.toFixed(2)}</td>
              <td>{t.exitPrice.toFixed(2)}</td>
              <td>
                {t.exitReason === 'stop' ? '止损' : t.exitReason === 'target' ? '止盈' : '收尾'}
              </td>
              <td className={t.rMultiple >= 0 ? 'up' : 'down'}>{fmt(t.rMultiple)}R</td>
              <td className={t.pnl >= 0 ? 'up' : 'down'}>{fmt(t.pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {trades.length > limit && <div className="muted">仅显示前 {limit} 笔，共 {trades.length} 笔。</div>}
    </div>
  );
}
