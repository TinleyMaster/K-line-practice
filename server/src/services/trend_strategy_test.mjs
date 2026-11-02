// 趋势起点策略回测：基于 detectTrendMoves 同口径的趋势起点条件
//   - MACD 锚定摆动点出现「更高低 / 更低高」（结构确认）
//   - RSI 极值（起点 RSI 低=涨、高=跌）
//   - 量能放大（量 > 均量 × volMult）
// 止损放在该摆动低点/高点（结构破位即出场，等价骑到趋势结束）。
// 通过 HTTP 调 /api/backtest/run（在服务端进程内跑，不占额外 DB 连接）。

const base = {
  symbol: 'BTCUSDT', market: 'perp', limit: 12000, since: '2024-01-01',
  signalMode: 'trend', stopMode: 'defense', tpMode: 'rMultiple',
  side: 'both', cooldownBars: 3, feeRate: 0.0004, slippageBps: 0,
  riskPct: 1, atrMult: 2, minStopPct: 0.5, maxStopPct: 8,
  emaFast: 21, emaMid: 55, emaSlow: 144, rsiPeriod: 14, volPeriod: 20,
};

const configs = [
  { name: 'A ATR止损(atrMult2) 骑到结束tpR100 4h关', use4hFilter: false, stopMode: 'atr', atrMult: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 0 },
  { name: 'B 同上+追踪trailR=2', use4hFilter: false, stopMode: 'atr', atrMult: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 2 },
  { name: 'C ATR2+trail3 开4h过滤', use4hFilter: true, stopMode: 'atr', atrMult: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 3 },
  { name: 'D ATR3 无追踪 切3R', use4hFilter: false, stopMode: 'atr', atrMult: 3, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 3, trailR: 0 },
  { name: 'E ATR2 放宽RSI(0-75/25-100)无量能', use4hFilter: false, stopMode: 'atr', atrMult: 2, rsiLongLo: 0, rsiLongHi: 75, rsiShortLo: 25, rsiShortHi: 100, volMult: 1.0, tpR: 100, trailR: 0 },
  { name: 'F ATR2+trail2 仅多(long)', use4hFilter: false, side: 'long', stopMode: 'atr', atrMult: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 2 },
  { name: 'G ATR2+trail2 仅空(short)', use4hFilter: false, side: 'short', stopMode: 'atr', atrMult: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 2 },
  // 诊断：用「远离的 MACD 极值低点」作宽止损，骑到趋势结束（等价于吃满整段），看入场时机本身是否赚钱。
  { name: 'H 宽止损(极值低,maxStop50) 骑到结束', use4hFilter: false, stopMode: 'defense', atrMult: 2, maxStopPct: 50, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 0 },
  { name: 'I 宽止损+4h过滤', use4hFilter: true, stopMode: 'defense', atrMult: 2, maxStopPct: 50, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 0 },
  // 诊断：骑到结构破位（首个更低高/更高低）才出场，止损设极宽(50%)基本不触发，看「入场时机本身」能不能吃到趋势。
  { name: 'J 骑到结构破位(tp=trendend,stop50%) 4h关', use4hFilter: false, stopMode: 'pct', stopPct: 50, tpMode: 'trendend', atrMult: 2, maxStopPct: 60, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 0 },
  { name: 'K 骑到结构破位+4h过滤', use4hFilter: true, stopMode: 'pct', stopPct: 50, tpMode: 'trendend', atrMult: 2, maxStopPct: 60, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 0 },
  { name: 'L 骑到结构破位 仅多', use4hFilter: false, side: 'long', stopMode: 'pct', stopPct: 50, tpMode: 'trendend', atrMult: 2, maxStopPct: 60, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 0 },
  // 改进(1): 入场价改为摆动点本身(那根 low/high)，直接吃满整段，看 PF 能否>1
  { name: 'M swing入场 骑到结构破位(close对比J)', use4hFilter: false, side: 'both', trendEntry: 'swing', stopMode: 'pct', stopPct: 50, tpMode: 'trendend', atrMult: 2, maxStopPct: 60, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 0 },
  { name: 'N swing入场 ATR2+追踪2R 双向', use4hFilter: false, side: 'both', trendEntry: 'swing', stopMode: 'atr', atrMult: 2, trailR: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, maxStopPct: 60 },
  { name: 'O swing入场 骑到结构破位 仅多', use4hFilter: false, side: 'long', trendEntry: 'swing', stopMode: 'pct', stopPct: 50, tpMode: 'trendend', atrMult: 2, maxStopPct: 60, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, trailR: 0 },
  { name: 'P swing入场 ATR2+追踪3R+4h过滤', use4hFilter: true, side: 'both', trendEntry: 'swing', stopMode: 'atr', atrMult: 2, trailR: 3, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, maxStopPct: 60 },
  // swing 入场 + 去掉量能过滤（摆动低点附近量未必放大），扩大样本看是否真有优势
  { name: 'Q swing 无体积 骑到结构破位 双向', use4hFilter: false, side: 'both', trendEntry: 'swing', stopMode: 'pct', stopPct: 50, tpMode: 'trendend', atrMult: 2, maxStopPct: 60, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.0, tpR: 100, trailR: 0 },
  { name: 'R swing 无体积 ATR2+追踪2R 双向', use4hFilter: false, side: 'both', trendEntry: 'swing', stopMode: 'atr', atrMult: 2, trailR: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.0, tpR: 100, maxStopPct: 60 },
  { name: 'S swing 无体积 ATR2+追踪3R+4h 双向', use4hFilter: true, side: 'both', trendEntry: 'swing', stopMode: 'atr', atrMult: 2, trailR: 3, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.0, tpR: 100, maxStopPct: 60 },
  { name: 'T swing 无体积 ATR2+追踪2R 仅多', use4hFilter: false, side: 'long', trendEntry: 'swing', stopMode: 'atr', atrMult: 2, trailR: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.0, tpR: 100, maxStopPct: 60 },
  // 稳健性检验：训练/测试切分（splitRatio 0.5）与不同时间窗，看高 PF 是否过拟合
  { name: 'U R式 swing 训练/测试切分0.5', use4hFilter: false, side: 'both', trendEntry: 'swing', stopMode: 'atr', atrMult: 2, trailR: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.0, tpR: 100, maxStopPct: 60, splitRatio: 0.5 },
  { name: 'V F式 close多 训练/测试切分0.5', use4hFilter: false, side: 'long', stopMode: 'atr', atrMult: 2, trailR: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, maxStopPct: 60, splitRatio: 0.5 },
  { name: 'W R式 swing 不同窗 2025-06起', use4hFilter: false, side: 'both', trendEntry: 'swing', stopMode: 'atr', atrMult: 2, trailR: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.0, tpR: 100, maxStopPct: 60, since: '2025-06-01', limit: 6000 },
  { name: 'X F式 close多 不同窗 2025-06起', use4hFilter: false, side: 'long', stopMode: 'atr', atrMult: 2, trailR: 2, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, volMult: 1.5, tpR: 100, maxStopPct: 60, since: '2025-06-01', limit: 6000 },
];

async function run(cfg) {
  const body = { ...base, ...cfg };
  const r = await fetch('http://127.0.0.1:8787/api/backtest/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) return `ERR ${j.error}`;
  const s = j.stats || {};
  const t = j.trades || [];
  const longs = t.filter((x) => x.side === 'long');
  const shorts = t.filter((x) => x.side === 'short');
  const wr = (arr) => arr.length ? (arr.filter((x) => x.rMultiple > 0).length / arr.length * 100).toFixed(0) + '%' : '—';
  const f = (x) => x == null ? '—' : (typeof x === 'number' ? (Number.isFinite(x) ? x.toFixed(2) : '∞') : x);
  let out = `trades=${t.length} 胜率=${(s.winRate * 100).toFixed(0)}% PF=${f(s.profitFactor)} totalR=${f(s.totalR)} avgR=${f(s.avgR)} maxDD=${(s.maxDrawdown * 100).toFixed(1)}% | 多=${longs.length}(${wr(longs)}) 空=${shorts.length}(${wr(shorts)})`;
  if (j.trainStats && j.testStats) {
    const ts = j.trainStats, es = j.testStats;
    out += `\n    训练(${ts.trades}笔): 胜率=${(ts.winRate*100).toFixed(0)}% PF=${f(ts.profitFactor)} totalR=${f(ts.totalR)}`;
    out += `\n    测试(${es.trades}笔): 胜率=${(es.winRate*100).toFixed(0)}% PF=${f(es.profitFactor)} totalR=${f(es.totalR)}`;
  }
  return out;
}

for (const cfg of configs) {
  const res = await run(cfg);
  console.log(`[${cfg.name}]\n  ${res}\n`);
}
process.exit(0);
