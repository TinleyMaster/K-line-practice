import { vpProfile } from './backtestService.js';

const url = 'http://127.0.0.1:8787/api/klines?symbol=BTCUSDT&market=perp&interval=1h&limit=8000';
const j = await (await fetch(url)).json();
const bars = (j.bars || j.bars1h || []).map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 }));
const n = bars.length;
console.log(`bars=${n}`);

// ---- 诊断1+3a：VP 突破假突破率（事件法，避免连续根重复计数） ----
function falseBreakRate(window) {
  let fb = 0, tb = 0, lastInside = true;
  for (let i = window; i < n; i++) {
    const prof = vpProfile(bars, i - window, i - 1, 80, 0.7);
    if (!prof) { lastInside = true; continue; }
    const broke = bars[i].close > prof.vaHigh;
    if (broke && lastInside) {
      let returned = false;
      for (let k = i + 1; k <= Math.min(n - 1, i + 5); k++) {
        if (bars[k].close < prof.vaHigh && bars[k].close > prof.vaLow) { returned = true; break; }
      }
      if (returned) fb++; else tb++;
      lastInside = false;
    } else if (!broke) {
      lastInside = bars[i].close >= prof.vaLow && bars[i].close <= prof.vaHigh;
    }
  }
  const tot = fb + tb;
  return { fb, tb, rate: tot ? fb / tot : 0 };
}
console.log('\n【诊断1】VP 突破(收破 VA 上沿)后 5 根内回到 VA 内 = 假突破');
for (const w of [168, 240, 336]) {
  const r = falseBreakRate(w);
  console.log(`  VP窗口=${w}(${w/24}天): 假突破=${r.fb} 真突破=${r.tb} 假突破率=${(r.rate*100).toFixed(1)}%`);
}

// ---- 诊断2：相同趋势入场，VP 止损 vs ATR 止损 ----
async function trendWith(stopMode, vpWindow = 168) {
  const body = {
    symbol: 'BTCUSDT', market: 'perp', limit: 8000, since: '2024-01-01',
    signalMode: 'trend', side: 'both', stopMode, tpMode: 'rMultiple', tpR: 100,
    trailR: 2, atrMult: 2, volMult: 1.5, use4hFilter: false, cooldownBars: 3,
    feeRate: 0.0004, slippageBps: 0, riskPct: 1, minStopPct: 0.3, maxStopPct: 12,
    rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80, // 用与 PF~1.13 基线相同的入场，只隔离止损
    vpWindow, vaPct: 0.7, vpNB: 80, vpStopBuf: 0.3,
  };
  const r = await fetch('http://127.0.0.1:8787/api/backtest/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const jr = await r.json();
  if (jr.error) return `ERR ${jr.error}`;
  const s = jr.stats || {};
  const f = (x) => x == null ? '—' : (Number.isFinite(x) ? x.toFixed(2) : '∞');
  return `笔数=${s.trades} 胜率=${(s.winRate*100).toFixed(0)}% PF=${f(s.profitFactor)} 总R=${f(s.totalR)} 回撤=${(s.maxDrawdown*100).toFixed(1)}%`;
}
console.log('\n【诊断2】相同趋势入场(signalMode=trend)，只换止损方式');
console.log(`  ATR 止损(atr2+追踪2R): ${await trendWith('atr')}`);
console.log(`  VP  止损(vp+追踪2R):  ${await trendWith('vp')}`);

// ---- 诊断3b：VP 突破回测本身，窗口敏感性 ----
async function vpBacktest(vpWindow) {
  const body = {
    symbol: 'BTCUSDT', market: 'perp', limit: 8000, since: '2024-01-01',
    signalMode: 'vp', side: 'both', stopMode: 'atr', tpMode: 'rMultiple', tpR: 100,
    trailR: 2, volMult: 1.5, use4hFilter: false, cooldownBars: 3,
    feeRate: 0.0004, slippageBps: 0, riskPct: 1, minStopPct: 0.3, maxStopPct: 12,
    vpWindow, vaPct: 0.7, vpNB: 80, vpStopBuf: 0.3,
  };
  const r = await fetch('http://127.0.0.1:8787/api/backtest/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const jr = await r.json();
  if (jr.error) return `ERR ${jr.error}`;
  const s = jr.stats || {};
  const f = (x) => x == null ? '—' : (Number.isFinite(x) ? x.toFixed(2) : '∞');
  return `笔数=${s.trades} 胜率=${(s.winRate*100).toFixed(0)}% PF=${f(s.profitFactor)} 总R=${f(s.totalR)} 回撤=${(s.maxDrawdown*100).toFixed(1)}%`;
}
console.log('\n【诊断3】VP 突破回测本身，窗口敏感性（trailR=2）');
for (const w of [168, 240, 336]) console.log(`  VP窗口=${w}: ${await vpBacktest(w)}`);

process.exit(0);
