import { useState } from 'react';
import { usePracticeStore } from '../store/usePracticeStore';
import { api } from '../api';

interface Trade {
  side: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  rMultiple: number;
  exitReason: string;
}

interface BacktestResult {
  params: Record<string, unknown>;
  bars: number;
  trades: Trade[];
  equity: { time: number; equity: number }[];
  trainStats?: BacktestResult['stats'];
  testStats?: BacktestResult['stats'];
  stats: {
    trades: number;
    wins: number;
    winRate: number;
    totalR: number;
    avgR: number;
    maxDrawdown: number;
    profitFactor: number | null;
  };
}

interface OptResult {
  totalCombos: number;
  runCombos: number;
  results: { params: Record<string, unknown>; stats: BacktestResult['stats'] }[];
}

export function BacktestView({
  onShowMarkers,
}: {
  onShowMarkers: (markers: { time: number; price: number; side: 'long' | 'short'; kind: 'entry' | 'exit' }[]) => void;
}) {
  const store = usePracticeStore();
  const [symbol, setSymbol] = useState(store.symbol || 'BTCUSDT');
  const [market, setMarket] = useState<string>(store.market || 'perp');
  const [minBody, setMinBody] = useState(10);
  const [maxShadow, setMaxShadow] = useState(30);
  const [minConsec, setMinConsec] = useState(2);
  const [emaFast, setEmaFast] = useState(21);
  const [emaMid, setEmaMid] = useState(55);
  const [emaSlow, setEmaSlow] = useState(144);
  const [stopMode, setStopMode] = useState('defense');
  const [stopPct, setStopPct] = useState(2);
  const [atrMult, setAtrMult] = useState(2);
  const [feeRate, setFeeRate] = useState(0.0004);
  const [slippageBps, setSlippageBps] = useState(0);
  const [minStopPct, setMinStopPct] = useState(0.5);
  const [maxStopPct, setMaxStopPct] = useState(8);
  const [cooldownBars, setCooldownBars] = useState(3);
  const [use4hFilter, setUse4hFilter] = useState(true);
  const [tpR, setTpR] = useState(2);
  const [tpMode, setTpMode] = useState('rMultiple');
  const [timeStop, setTimeStop] = useState('');
  const [side, setSide] = useState('both');
  const [signalMode, setSignalMode] = useState('loose');
  const [splitRatio, setSplitRatio] = useState('0.6');

  const [optMinBody, setOptMinBody] = useState('8,10,12');
  const [optMaxShadow, setOptMaxShadow] = useState('25,30,35');
  const [optMinConsec, setOptMinConsec] = useState('2,3');
  const [optTpR, setOptTpR] = useState('1.5,2,3');

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [optResult, setOptResult] = useState<OptResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = (await api.backtestRun({
        symbol,
        market,
        minBody,
        maxShadow,
        minConsec,
        emaFast,
        emaMid,
        emaSlow,
        stopMode,
        stopPct,
        atrMult,
        tpR,
        tpMode,
        timeStop: timeStop ? Number(timeStop) : null,
        side,
        signalMode,
        feeRate,
        slippageBps,
        minStopPct,
        maxStopPct,
        cooldownBars,
        use4hFilter,
        limit: 20000,
        splitRatio: splitRatio ? Number(splitRatio) : null,
      })) as unknown as BacktestResult;
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const optimize = async () => {
    setLoading(true);
    setError(null);
    try {
      const grid = {
        minBody: optMinBody.split(',').map((x) => Number(x.trim())).filter((n) => !isNaN(n)),
        maxShadow: optMaxShadow.split(',').map((x) => Number(x.trim())).filter((n) => !isNaN(n)),
        minConsec: optMinConsec.split(',').map((x) => Number(x.trim())).filter((n) => !isNaN(n)),
        tpR: optTpR.split(',').map((x) => Number(x.trim())).filter((n) => !isNaN(n)),
      };
      const r = (await api.backtestOptimize({
        baseParams: { symbol, market, emaFast, emaMid, emaSlow, stopMode, stopPct, atrMult, tpMode, timeStop: timeStop ? Number(timeStop) : null, side, signalMode, feeRate, slippageBps, minStopPct, maxStopPct, cooldownBars, use4hFilter },
        grid,
      })) as unknown as OptResult;
      setOptResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const showMarkers = () => {
    if (!result) return;
    const markers: { time: number; price: number; side: 'long' | 'short'; kind: 'entry' | 'exit' }[] = [];
    for (const t of result.trades) {
      markers.push({ time: t.entryTime, price: t.entryPrice, side: t.side as 'long' | 'short', kind: 'entry' });
      markers.push({ time: t.exitTime, price: t.exitPrice, side: t.side as 'long' | 'short', kind: 'exit' });
    }
    onShowMarkers(markers);
  };

  const fmt = (n: number) => (n == null ? '—' : n.toFixed(4));
  const fmtPct = (n: number) => (n == null ? '—' : (n * 100).toFixed(1) + '%');

  const p = (r: OptResult['results'][number]) => r.params as Record<string, number>;

  return (
    <div className="full-view" style={{ padding: 12 }}>
      <h2 style={{ margin: '0 0 12px' }}>回测</h2>
      {error && <div className="notice error banner">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 12 }}>
        <label>标的<input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></label>
        <label>市场<select className="input" value={market} onChange={(e) => setMarket(e.target.value)}><option value="perp">合约</option><option value="spot">现货</option></select></label>
        <label>实体最小%<input className="input" type="number" value={minBody} onChange={(e) => setMinBody(Number(e.target.value))} /></label>
        <label>影线最大%<input className="input" type="number" value={maxShadow} onChange={(e) => setMaxShadow(Number(e.target.value))} /></label>
        <label>连续趋势K<input className="input" type="number" value={minConsec} onChange={(e) => setMinConsec(Number(e.target.value))} /></label>
        <label>EMA快<input className="input" type="number" value={emaFast} onChange={(e) => setEmaFast(Number(e.target.value))} /></label>
        <label>EMA中<input className="input" type="number" value={emaMid} onChange={(e) => setEmaMid(Number(e.target.value))} /></label>
        <label>EMA慢<input className="input" type="number" value={emaSlow} onChange={(e) => setEmaSlow(Number(e.target.value))} /></label>
        <label>止损模式<select className="input" value={stopMode} onChange={(e) => setStopMode(e.target.value)}><option value="defense">防守位</option><option value="atr">ATR</option><option value="fixedPct">固定%</option></select></label>
        <label>止损%<input className="input" type="number" value={stopPct} onChange={(e) => setStopPct(Number(e.target.value))} /></label>
        <label>止盈R<input className="input" type="number" value={tpR} onChange={(e) => setTpR(Number(e.target.value))} /></label>
        <label>止盈模式<select className="input" value={tpMode} onChange={(e) => setTpMode(e.target.value)}><option value="rMultiple">R倍数</option><option value="none">无</option></select></label>
        <label>时间止损(根)<input className="input" value={timeStop} onChange={(e) => setTimeStop(e.target.value)} placeholder="空=不启用" /></label>
        <label>ATR倍数<input className="input" type="number" value={atrMult} onChange={(e) => setAtrMult(Number(e.target.value))} /></label>
        <label>手续费率<input className="input" type="number" step="0.0001" value={feeRate} onChange={(e) => setFeeRate(Number(e.target.value))} /></label>
        <label>滑点bp<input className="input" type="number" value={slippageBps} onChange={(e) => setSlippageBps(Number(e.target.value))} /></label>
        <label>最小止损%<input className="input" type="number" step="0.1" value={minStopPct} onChange={(e) => setMinStopPct(Number(e.target.value))} /></label>
        <label>最大止损%<input className="input" type="number" value={maxStopPct} onChange={(e) => setMaxStopPct(Number(e.target.value))} /></label>
        <label>冷却(根)<input className="input" type="number" value={cooldownBars} onChange={(e) => setCooldownBars(Number(e.target.value))} /></label>
        <label>4h过滤<input type="checkbox" checked={use4hFilter} onChange={(e) => setUse4hFilter(e.target.checked)} /></label>
        <label>方向<select className="input" value={side} onChange={(e) => setSide(e.target.value)}><option value="both">双向</option><option value="long">仅多</option><option value="short">仅空</option></select></label>
        <label>信号模式<select className="input" value={signalMode} onChange={(e) => setSignalMode(e.target.value)}><option value="loose">宽松(EMA+趋势K)</option><option value="strict">严格(趋势+回调+入场)</option></select></label>
        <label>样本外比例<input className="input" value={splitRatio} onChange={(e) => setSplitRatio(e.target.value)} placeholder="0.6=前60%训练" /></label>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className="btn primary" onClick={run} disabled={loading}>{loading ? '运行中…' : '运行回测'}</button>
        {result && <button className="btn" onClick={showMarkers}>在图表显示买卖点</button>}
      </div>

      {result && (
        <div style={{ marginBottom: 16 }}>
          <h3>结果统计（{result.bars} 根 1h）</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <div className="stat-card"><span>笔数</span><strong>{result.stats.trades}</strong></div>
            <div className="stat-card"><span>胜率</span><strong>{fmtPct(result.stats.winRate)}</strong></div>
            <div className="stat-card"><span>总 R</span><strong>{result.stats.totalR.toFixed(2)}</strong></div>
            <div className="stat-card"><span>平均 R</span><strong>{result.stats.avgR.toFixed(3)}</strong></div>
            <div className="stat-card"><span>最大回撤</span><strong>{fmtPct(result.stats.maxDrawdown)}</strong></div>
            <div className="stat-card"><span>盈亏比</span><strong>{result.stats.profitFactor == null ? '—' : result.stats.profitFactor.toFixed(2)}</strong></div>
          </div>
          {result.trainStats && result.testStats && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              样本外验证：训练集 {result.trainStats.trades}笔 / 胜率 {fmtPct(result.trainStats.winRate)} / 总R {result.trainStats.totalR.toFixed(2)} ｜ 测试集 {result.testStats.trades}笔 / 胜率 {fmtPct(result.testStats.winRate)} / 总R {result.testStats.totalR.toFixed(2)}
            </div>
          )}

          <h4 style={{ marginTop: 12 }}>交易明细（前 50 笔）</h4>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>方向</th><th>入场时间</th><th>入场价</th><th>出场价</th><th>止损</th><th>止盈</th><th>R</th><th>原因</th></tr></thead>
              <tbody>
                {result.trades.slice(0, 50).map((t, i) => (
                  <tr key={i}>
                    <td className={t.side === 'long' ? 'up' : 'down'}>{t.side === 'long' ? '多' : '空'}</td>
                    <td>{new Date(t.entryTime).toLocaleString()}</td>
                    <td>{fmt(t.entryPrice)}</td>
                    <td>{fmt(t.exitPrice)}</td>
                    <td>{fmt(t.stopLoss)}</td>
                    <td>{t.takeProfit == null ? '—' : fmt(t.takeProfit)}</td>
                    <td className={t.rMultiple > 0 ? 'up' : 'down'}>{t.rMultiple.toFixed(2)}</td>
                    <td>{t.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <hr style={{ margin: '20px 0', borderColor: 'var(--border)' }} />
      <h3>参数优化（网格搜索）</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginBottom: 12 }}>
        <label>实体% 列表<input className="input" value={optMinBody} onChange={(e) => setOptMinBody(e.target.value)} placeholder="8,10,12" /></label>
        <label>影线% 列表<input className="input" value={optMaxShadow} onChange={(e) => setOptMaxShadow(e.target.value)} placeholder="25,30,35" /></label>
        <label>连续K 列表<input className="input" value={optMinConsec} onChange={(e) => setOptMinConsec(e.target.value)} placeholder="2,3" /></label>
        <label>止盈R 列表<input className="input" value={optTpR} onChange={(e) => setOptTpR(e.target.value)} placeholder="1.5,2,3" /></label>
      </div>
      <button className="btn primary" onClick={optimize} disabled={loading}>{loading ? '优化中…' : '运行参数优化'}</button>

      {optResult && (
        <div style={{ marginTop: 12 }}>
          <div className="muted">共 {optResult.totalCombos} 组合，实际运行 {optResult.runCombos} 组，显示前 50</div>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>排名</th><th>实体%</th><th>影线%</th><th>连续K</th><th>止盈R</th><th>笔数</th><th>胜率</th><th>总R</th><th>平均R</th><th>最大回撤</th></tr></thead>
              <tbody>
                {optResult.results.map((r, i) => {
                  const pp = p(r);
                  return (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>{pp.minBody}</td>
                      <td>{pp.maxShadow}</td>
                      <td>{pp.minConsec}</td>
                      <td>{pp.tpR}</td>
                      <td>{r.stats.trades}</td>
                      <td>{fmtPct(r.stats.winRate)}</td>
                      <td className={r.stats.totalR > 0 ? 'up' : 'down'}>{r.stats.totalR.toFixed(2)}</td>
                      <td>{r.stats.avgR.toFixed(3)}</td>
                      <td>{fmtPct(r.stats.maxDrawdown)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
