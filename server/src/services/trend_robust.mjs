const base = {
  symbol: 'BTCUSDT', market: 'perp', limit: 8000, since: '2024-01-01',
  signalMode: 'trend', stopMode: 'atr', atrMult: 2, trailR: 2,
  side: 'both', cooldownBars: 3, feeRate: 0.0004, slippageBps: 0,
  riskPct: 1, minStopPct: 0.5, maxStopPct: 60,
  emaFast: 21, emaMid: 55, emaSlow: 144, rsiPeriod: 14, volPeriod: 20,
  tpMode: 'rMultiple', tpR: 100,
  rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80,
};

const configs = [
  { name: 'U2 swing 限8000 2024-01起', trendEntry: 'swing', volMult: 1.0 },
  { name: 'W2 swing 限6000 2025-06起', trendEntry: 'swing', volMult: 1.0, since: '2025-06-01', limit: 6000 },
  { name: 'Y2 swing 限6000 2024-01起', trendEntry: 'swing', volMult: 1.0, since: '2024-01-01', limit: 6000 },
  { name: 'F2 close 限8000 2024-01起(baseline)', trendEntry: 'close', volMult: 1.5 },
  { name: 'F3 close 仅多 限8000', trendEntry: 'close', volMult: 1.5, side: 'long' },
];

async function run(cfg) {
  const body = { ...base, ...cfg };
  const r = await fetch('http://127.0.0.1:8787/api/backtest/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) return `ERR ${j.error}`;
  const s = j.stats || {};
  const f = (x) => x == null ? '—' : (typeof x === 'number' ? (Number.isFinite(x) ? x.toFixed(2) : '∞') : x);
  const t = j.trades || [];
  const longs = t.filter((x) => x.side === 'long');
  const shorts = t.filter((x) => x.side === 'short');
  const wr = (arr) => arr.length ? (arr.filter((x) => x.rMultiple > 0).length / arr.length * 100).toFixed(0) + '%' : '—';
  return `[${cfg.name}]\n  整体(${t.length}笔): 胜率=${(s.winRate*100).toFixed(0)}% PF=${f(s.profitFactor)} totalR=${f(s.totalR)} avgR=${f(s.avgR)} maxDD=${(s.maxDrawdown*100).toFixed(1)}% | 多=${longs.length}(${wr(longs)}) 空=${shorts.length}(${wr(shorts)})`;
}

for (const cfg of configs) {
  const res = await run(cfg);
  console.log(res + '\n');
}
process.exit(0);
