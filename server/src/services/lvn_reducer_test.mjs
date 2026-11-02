// LVN 减仓触发器诊断：验证 "进入 LVN 真空带 → 减半/平仓" 能否降低回撤、维持 PF。
// 严格 OOS：训练集(2022-2024)选参数，测试集(2025-now)只跑一次不改参数。
// 用 /api/backtest/run（走 DB loadBars，无 5000 上限）。

const API = 'http://127.0.0.1:8787/api/backtest/run';

// 复用已验证较好的基线：趋势 + defense 结构止损 + 2R 追踪（本地测得 PF~1.24）
const base = {
  symbol: 'BTCUSDT', market: 'perp', signalMode: 'trend', side: 'both',
  stopMode: 'defense', tpMode: 'rMultiple', tpR: 100, trailR: 2,
  volMult: 1.5, use4hFilter: false, cooldownBars: 3,
  feeRate: 0.0004, slippageBps: 0, riskPct: 1, minStopPct: 0.3, maxStopPct: 12,
  rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80,
  lvnWindow: 168, lvnBandPct: 0.4,
};

async function run(cfg) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      const j = await r.json();
      if (j.error) return { err: j.error };
      const trades = j.trades || [];
      const s = j.stats || {};
      const wins = trades.filter((t) => t.rMultiple > 0);
      const losses = trades.filter((t) => t.rMultiple <= 0);
      const avgWin = wins.length ? wins.reduce((a, t) => a + t.rMultiple, 0) / wins.length : 0;
      const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.rMultiple, 0)) / losses.length : 0;
      const plRatio = avgLoss > 0 ? avgWin / avgLoss : (wins.length ? Infinity : 0);
      return {
        trades: s.trades, winRate: s.winRate, pf: s.profitFactor, totalR: s.totalR,
        dd: s.maxDrawdown, plRatio,
      };
    } catch (e) {
      if (attempt < 3) { await new Promise((r) => setTimeout(r, 1200)); continue; }
      return { err: e.message };
    }
  }
}

function fmt(x, d = 2) { return x == null ? '—' : (Number.isFinite(x) ? x.toFixed(d) : '∞'); }

const windows = [
  { name: '训练集 2022-2024', since: '2022-01-01', until: '2024-12-31' },
  { name: '测试集 2025-now', since: '2025-01-01', until: undefined },
];
const reduces = ['none', 'halve', 'flatten'];
const lvnWindows = [168, 336];

for (const w of windows) {
  console.log(`\n=== ${w.name} (since=${w.since}${w.until ? ' until=' + w.until : ''}) ===`);
  console.log(`  ${'lvnWin'.padStart(6)} ${'reduce'.padStart(8)} ${'笔数'.padStart(5)} ${'胜率'.padStart(6)} ${'PF'.padStart(6)} ${'总R'.padStart(8)} ${'回撤%'.padStart(7)} ${'盈亏比'.padStart(7)}`);
  for (const lw of lvnWindows) {
    for (const red of reduces) {
      const cfg = { ...base, lvnWindow: lw, lvnReduce: red, since: w.since };
      if (w.until) cfg.until = w.until;
      const r = await run(cfg);
      if (r.err) { console.log(`  ${String(lw).padStart(6)} ${red.padStart(8)} ERR ${r.err}`); continue; }
      console.log(`  ${String(lw).padStart(6)} ${red.padStart(8)} ${String(r.trades).padStart(5)} ${(r.winRate*100).toFixed(0).padStart(5)}% ${fmt(r.pf).padStart(6)} ${fmt(r.totalR).padStart(8)} ${(r.dd*100).toFixed(1).padStart(7)} ${fmt(r.plRatio).padStart(7)}`);
    }
  }
}

// 额外：ATR 止损（高回撤版本，DD 曾达 24-37%）上叠加 halve，直接验证"把高 DD 策略变可接受"
console.log('\n=== 附加：ATR 止损 + halve（高 DD 基线，看减仓能否砍回撤）===');
console.log(`  ${'window'.padStart(8)} ${'reduce'.padStart(8)} ${'笔数'.padStart(5)} ${'胜率'.padStart(6)} ${'PF'.padStart(6)} ${'总R'.padStart(8)} ${'回撤%'.padStart(7)} ${'盈亏比'.padStart(7)}`);
const atrBase = { ...base, stopMode: 'atr', atrMult: 2, lvnWindow: 336 };
for (const w of windows) {
  for (const red of ['none', 'halve']) {
    const cfg = { ...atrBase, lvnReduce: red, since: w.since };
    if (w.until) cfg.until = w.until;
    const r = await run(cfg);
    if (r.err) { console.log(`  ${w.name.padStart(8)} ${red.padStart(8)} ERR ${r.err}`); continue; }
    console.log(`  ${w.name.padStart(8)} ${red.padStart(8)} ${String(r.trades).padStart(5)} ${(r.winRate*100).toFixed(0).padStart(5)}% ${fmt(r.pf).padStart(6)} ${fmt(r.totalR).padStart(8)} ${(r.dd*100).toFixed(1).padStart(7)} ${fmt(r.plRatio).padStart(7)}`);
  }
}

console.log('\n判据（以同窗口 none 为基线）：PF ≥ 基线×0.9 且 回撤↓≥5% 且 盈亏比≥基线×1.1 且 胜率差<3% → LVN 减仓有效');
process.exit(0);
