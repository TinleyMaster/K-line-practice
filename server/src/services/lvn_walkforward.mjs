// Walk-forward 稳健性验证：3 段非重叠测试区间，每段跑 defense-none vs defense-halve(336)。
// 训练=选参(in-sample)，测试=验证(OOS，零调参)。判定：3 段测试 halve PF≥1.2 且 DD≤10% → 真稳健。
const API = 'http://127.0.0.1:8787/api/backtest/run';

const base = {
  symbol: 'BTCUSDT', market: 'perp', signalMode: 'trend', side: 'both',
  stopMode: 'defense', tpMode: 'rMultiple', tpR: 100, trailR: 2,
  volMult: 1.5, use4hFilter: false, cooldownBars: 3,
  feeRate: 0.0004, slippageBps: 0, riskPct: 1, minStopPct: 0.3, maxStopPct: 12,
  rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80,
  lvnWindow: 336, lvnBandPct: 0.4,
};

async function run(cfg) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      const j = await r.json();
      if (j.error) return { err: j.error };
      const trades = j.trades || [];
      const s = j.stats || {};
      const wins = trades.filter((t) => t.rMultiple > 0);
      const losses = trades.filter((t) => t.rMultiple <= 0);
      const avgWin = wins.length ? wins.reduce((x, t) => x + t.rMultiple, 0) / wins.length : 0;
      const avgLoss = losses.length ? Math.abs(losses.reduce((x, t) => x + t.rMultiple, 0)) / losses.length : 0;
      return { trades: s.trades, winRate: s.winRate, pf: s.profitFactor, totalR: s.totalR, dd: s.maxDrawdown, plRatio: avgLoss > 0 ? avgWin / avgLoss : (wins.length ? Infinity : 0) };
    } catch (e) { if (a < 3) { await new Promise((r) => setTimeout(r, 1200)); continue; } return { err: e.message }; }
  }
}
const f = (x, d = 2) => x == null ? '—' : (Number.isFinite(x) ? x.toFixed(d) : '∞');
const row = (tag, red, r) => `  ${tag.padStart(7)} ${red.padStart(7)} ${String(r.trades).padStart(5)} ${(r.winRate*100).toFixed(0).padStart(5)}% ${f(r.pf).padStart(6)} ${f(r.totalR).padStart(8)} ${(r.dd*100).toFixed(1).padStart(7)} ${f(r.plRatio).padStart(7)}`;

// 3 段 walk-forward（训练=in-sample 选参，测试=OOS 验证）
const walks = [
  { name: 'Walk-1', train: { since: '2022-01-01', until: '2023-12-31' }, test: { since: '2024-01-01', until: '2024-06-30' }, note: '测试=2024H1 下跌转反弹' },
  { name: 'Walk-2', train: { since: '2022-01-01', until: '2024-12-31' }, test: { since: '2025-01-01', until: '2025-06-30' }, note: '测试=2024H2-2025H1 牛市主升' },
  { name: 'Walk-3', train: { since: '2022-01-01', until: '2025-06-30' }, test: { since: '2025-07-01', until: undefined }, note: '测试=2025H2-now' },
];

let passCount = 0;
for (const w of walks) {
  console.log(`\n=== ${w.name}  (${w.note}) ===`);
  console.log(`  ${'阶段'.padStart(7)} ${'配置'.padStart(7)} ${'笔数'.padStart(5)} ${'胜率'.padStart(6)} ${'PF'.padStart(6)} ${'总R'.padStart(8)} ${'回撤%'.padStart(7)} ${'盈亏比'.padStart(7)}`);
  const trNone = await run({ ...base, lvnReduce: 'none', since: w.train.since, until: w.train.until });
  const trHalve = await run({ ...base, lvnReduce: 'halve', since: w.train.since, until: w.train.until });
  const teNone = await run({ ...base, lvnReduce: 'none', since: w.test.since, until: w.test.until });
  const teHalve = await run({ ...base, lvnReduce: 'halve', since: w.test.since, until: w.test.until });
  const datasets = [['训练', 'none', trNone], ['训练', 'halve', trHalve], ['测试', 'none', teNone], ['测试', 'halve', teHalve]];
  for (const [tag, red, r] of datasets) {
    if (r.err) { console.log(`  ${tag.padStart(7)} ${red.padStart(7)} ERR ${r.err}`); continue; }
    console.log(row(tag, red, r));
  }
  if (!teHalve.err && !teNone.err) {
    const keep = teHalve.pf >= 0.9 * teNone.pf;
    const cut = teHalve.dd <= teNone.dd - 0.05;
    const robust = teHalve.pf >= 1.2 && teHalve.dd <= 0.10;
    if (robust) passCount++;
    console.log(`  → 测试 halve PF ${f(teHalve.pf)} vs none ${f(teNone.pf)} (维持≥0.9×:${keep?'✓':'✗'})；DD ${(teNone.dd*100).toFixed(1)}%→${(teHalve.dd*100).toFixed(1)}% (砍≥5%:${cut?'✓':'✗'})；稳健达标(PF≥1.2&DD≤10%):${robust?'✓':'✗'}`);
  }
}
console.log(`\n=== 总结：${passCount}/3 段测试集 halve 达稳健标准(PF≥1.2 且 DD≤10%) ===`);
process.exit(0);
