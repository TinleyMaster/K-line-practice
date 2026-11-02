const base = {
  symbol: 'BTCUSDT', market: 'perp', limit: 8000, since: '2024-01-01',
  signalMode: 'vp', tpMode: 'rMultiple', tpR: 100,
  side: 'both', cooldownBars: 3, feeRate: 0.0004, slippageBps: 0,
  riskPct: 1, minStopPct: 0.3, maxStopPct: 12,
  emaFast: 21, emaMid: 55, emaSlow: 144, rsiPeriod: 14, volPeriod: 20,
  vpWindow: 150, vaPct: 0.7, vpNB: 80, vpStopBuf: 0.3,
};

const configs = [
  { name: 'VP 突破 放量1.5 无追踪 双向', use4hFilter: false, volMult: 1.5, trailR: 0 },
  { name: 'VP 突破 放量1.5 追踪2R 双向', use4hFilter: false, volMult: 1.5, trailR: 2 },
  { name: 'VP 突破 放量1.5 追踪3R 双向', use4hFilter: false, volMult: 1.5, trailR: 3 },
  { name: 'VP 突破 放量1.2 无追踪 双向', use4hFilter: false, volMult: 1.2, trailR: 0 },
  { name: 'VP 突破 放量1.5 4h过滤 双向', use4hFilter: true, volMult: 1.5, trailR: 2 },
  { name: 'VP 突破 放量1.5 仅多', use4hFilter: false, volMult: 1.5, trailR: 2, side: 'long' },
  { name: 'VP 突破 放量1.5 仅空', use4hFilter: false, volMult: 1.5, trailR: 2, side: 'short' },
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
  return `[${cfg.name}] trades=${t.length} 胜率=${(s.winRate*100).toFixed(0)}% PF=${f(s.profitFactor)} 总R=${f(s.totalR)} 均R=${f(s.avgR)} maxDD=${(s.maxDrawdown*100).toFixed(1)}% | 多${longs.length}(${wr(longs)}) 空${shorts.length}(${wr(shorts)})`;
}

for (const cfg of configs) {
  console.log(await run(cfg));
}
process.exit(0);
