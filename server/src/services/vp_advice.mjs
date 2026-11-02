// (A) 图表 VP 指标的"策略友好 LVN 提醒"：把回测结论变成每天看盘可执行的仓位建议。
// 用法：node src/services/vp_advice.mjs
import { vpPositionAdvice } from './backtestService.js';

const API = 'http://127.0.0.1:8787';
const SYMBOL = 'BTCUSDT', MARKET = 'perp', INTERVAL = '1h';

async function fetchBars(limit) {
  for (let a = 0; a < 4; a++) {
    try {
      const j = await (await fetch(`${API}/api/klines?symbol=${SYMBOL}&market=${MARKET}&interval=${INTERVAL}&limit=${limit}`)).json();
      const bars = (j.bars || j.bars1h || []).map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 }));
      if (bars.length) return bars;
    } catch (e) { if (a < 3) { await new Promise((r) => setTimeout(r, 1000)); continue; } throw e; }
  }
  return [];
}

async function recentStats(lvnReduce, sinceISO) {
  const cfg = {
    symbol: SYMBOL, market: MARKET, limit: 5000, since: sinceISO,
    signalMode: 'trend', side: 'both', stopMode: 'defense', tpMode: 'rMultiple', tpR: 100, trailR: 2,
    volMult: 1.5, use4hFilter: false, cooldownBars: 3, feeRate: 0.0004, slippageBps: 0, riskPct: 1,
    minStopPct: 0.3, maxStopPct: 12, rsiLongLo: 20, rsiLongHi: 70, rsiShortLo: 30, rsiShortHi: 80,
    lvnWindow: 336, lvnBandPct: 0.4, lvnReduce,
  };
  for (let a = 0; a < 4; a++) {
    try {
      const j = await (await fetch(`${API}/api/backtest/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) })).json();
      if (j.error) return null;
      const s = j.stats || {};
      return { pf: s.profitFactor, dd: s.maxDrawdown, trades: s.trades, winRate: s.winRate };
    } catch (e) { if (a < 3) { await new Promise((r) => setTimeout(r, 1200)); continue; } return null; }
  }
  return null;
}

const fmtPx = (x) => '$' + Number(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
const f2 = (x) => (x == null ? '—' : (Number.isFinite(x) ? x.toFixed(2) : '∞'));

const bars = await fetchBars(1000);
if (!bars.length) { console.log('无数据'); process.exit(1); }
const adv = vpPositionAdvice(bars, { vpWindow: 336 });

// 近 90 天 halve / none 实况，填入"本行情类型下 halve 表现"（90d 样本更稳定）
const since90 = new Date(Date.now() - 90 * 86400000).toISOString();
const stHalve = await recentStats('halve', since90);
const stNone = await recentStats('none', since90);
const statLine = (s) => s ? `PF ${f2(s.pf)} / DD ${(s.dd*100).toFixed(1)}% / ${s.trades}笔/胜率${(s.winRate*100).toFixed(0)}%` : '数据不足';

console.log(`\n## ⚠️ 仓位建议（基于 defense + LVN halve）\n`);
if (adv.inLVN) {
  console.log(`当前价格 ${fmtPx(adv.price)} 处于 1h LVN 区间 (${fmtPx(adv.lvnLow)} - ${fmtPx(adv.lvnHigh)})`);
  console.log(`  ├─ 建议：减半仓位（防御型），穿越 LVN 后再恢复`);
  console.log(`  ├─ 原因：LVN 内流动性差，价格加速穿越风险高`);
} else {
  console.log(`当前价格 ${fmtPx(adv.price)} 不在 LVN 真空带（位于 VA 区间或 HVN 附近）`);
  console.log(`  ├─ 建议：正常仓位`);
  console.log(`  ├─ 原因：当前处于成交密集区，穿越风险低`);
}
console.log(`  └─ 当前 VP 窗口 336 (14d)，近90天实况 → halve：${statLine(stHalve)}；none：${statLine(stNone)}\n`);
console.log(`defense 止损位：多 ${fmtPx(adv.stopLong)}（1h 下方最近 HVN 外 0.5%） / 空 ${fmtPx(adv.stopShort)}（上方最近 HVN 外 0.5%）`);
console.log(`VA 区间：${fmtPx(adv.vaLow)} - ${fmtPx(adv.vaHigh)}   POC：${fmtPx(adv.pocPrice)}`);
console.log(`当前 halve 状态：${adv.inLVN ? '已减半（防御）' : '正常'}\n`);
process.exit(0);
