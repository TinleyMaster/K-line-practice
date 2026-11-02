import { runBacktestOnBars } from './backtestService.js';

const url = 'http://127.0.0.1:8787/api/klines?symbol=BTCUSDT&market=perp&interval=1h&limit=8000';
const j = await (await fetch(url)).json();
const bars = (j.bars || j.bars1h || []).map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 }));

const base = {
  signalMode: 'trend', side: 'both', tpMode: 'rMultiple', tpR: 100, trailR: 2, atrMult: 2,
  volMult: 1.5, use4hFilter: false, cooldownBars: 3, feeRate: 0.0004, slippageBps: 0,
  riskPct: 1, minStopPct: 0.3, maxStopPct: 12,
  rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80,
  vpWindow: 168, vaPct: 0.7, vpNB: 80, vpStopBuf: 0.3,
};
for (const stopMode of ['atr', 'vp', 'defense', 'pct']) {
  try {
    const r = runBacktestOnBars(bars, { ...base, stopMode });
    const s = r.stats || {};
    console.log(`  trend + ${stopMode}: 笔数=${s.trades} 胜率=${(s.winRate*100).toFixed(0)}% PF=${s.profitFactor!=null?s.profitFactor.toFixed(2):'?'} 总R=${s.totalR!=null?s.totalR.toFixed(1):'?'} 回撤=${(s.maxDrawdown*100).toFixed(1)}%`);
  } catch (e) {
    console.log(`  trend + ${stopMode}: ERROR ${e.message}\n${e.stack}`);
  }
}
process.exit(0);
