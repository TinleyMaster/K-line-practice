/**
 * 多市场端到端闭环验证：perp / spot / stock 各跑一遍
 * 建会话 → 开仓 → 平仓 → 复盘 → 读回校验 → 统计核对
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

const j = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
  return data;
};

const rows = [];
const log = (m, ok, detail = '') => {
  rows.push({ m, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${m}${detail ? ' — ' + detail : ''}`);
};

async function runMarket(market) {
  console.log(`\n──────── ${market} ────────`);

  // 1. 选一个有数据的标的
  const symbols = await j('GET', '/api/symbols');
  const cands = symbols.filter((s) => s.market === market && s.bars > 0);
  if (!cands.length) {
    log(`${market} 有数据的标的`, false, '无');
    return;
  }
  const sym = cands[0].symbol;
  log(`${market} 标的`, true, `${sym} (${cands[0].bars}根)`);

  // 2. 拉 K 线
  const k = await j('GET', `/api/klines?symbol=${sym}&market=${market}&interval=both&limit=1200`);
  const bars1h = k.bars1h;
  if (!bars1h?.length) { log(`${market} 拉K线`, false); return; }
  const gap = checkGap(bars1h);
  log(`${market} 拉K线`, true, `1h=${bars1h.length}根 4h=${k.bars4h.length}根 首=${k.firstTime} 末=${k.lastTime}`);
  if (market === 'stock') {
    // 链上美股：短空洞已前向填充，剩余缺口必须全是 >6h 的长空洞
    const longOnly = gap.all.every((g) => g.hours > 6);
    log(`${market} 1h 连续性(ffill后)`, longOnly,
      `${gap.gaps} 处缺口，全部 >6h=${longOnly}`);
  } else {
    log(`${market} 1h 连续性`, gap.gaps === 0, gap.gaps === 0 ? '0 缺口' : `${gap.gaps} 处缺口`);
  }

  // 4h 必须严格由 1h 按 4h 桶（UTC 对齐）派生：
  // 服务端返回的 4h 根数必须等于「本地算出的、有 1h 成员的 4h 桶数」。
  const buckets = new Set(bars1h.map((b) => Math.floor(b.time / 14400000)));
  const spanHours = (bars1h[bars1h.length - 1].time - bars1h[0].time) / 3600000;
  const theoretical = Math.floor(spanHours / 4) + 1;
  log(`${market} 4h 派生对齐`, buckets.size === k.bars4h.length,
    `服务端=${k.bars4h.length} 本地桶=${buckets.size} 理论上限=${theoretical} 桶覆盖=${((buckets.size / theoretical) * 100).toFixed(1)}%`);

  // 3. 建会话
  const cursor = Math.min(480, Math.max(120, Math.floor(bars1h.length * 0.4)));
  const bar = bars1h[cursor];
  const session = await j('POST', '/api/sessions', {
    symbol: sym, market, startTime: bar.time, equityStart: 10000, meta: { source: 'e2e', market },
  });
  log(`${market} 建会话`, session.market === market && session.symbol === sym, `id=${session.id} market=${session.market}`);

  // 4. 开仓（做多，止损 1%）
  const entry = bar.close;
  const stop = entry * 0.99;
  const risk = 100;
  const qty = risk / (entry - stop);
  const trade = await j('POST', '/api/trades', {
    sessionId: session.id, symbol: sym, market, side: 'long', setup: 'E2E-测试',
    entryTime: bar.time, entryPrice: entry, stopLoss: stop, takeProfit: entry * 1.02,
    riskAmount: risk, qty, checklist: { trendAligned: true, entryConfirmed: true },
  });
  log(`${market} 开仓落库`, trade.market === market && trade.symbol === sym, `id=${trade.id} market=${trade.market} qty=${trade.qty.toFixed(4)}`);

  // 5. 平仓（+2% 目标价 → +2R）
  const exitBar = bars1h[Math.min(cursor + 3, bars1h.length - 1)];
  const exitPrice = entry * 1.02;
  const r = (exitPrice - entry) / (entry - stop);
  const pnl = (exitPrice - entry) * qty;
  const closed = await j('PATCH', `/api/trades/${trade.id}`, {
    exitTime: exitBar.time, exitPrice, exitReason: 'take_profit', status: 'closed',
    rMultiple: r, pnl,
  });
  const expectR = 2.0;
  log(`${market} 平仓落库`, Math.abs(closed.rMultiple - expectR) < 0.001, `R=${closed.rMultiple} (期望${expectR}) PnL=${Number(closed.pnl).toFixed(2)}`);

  // 6. 复盘
  const journal = await j('POST', '/api/journal', {
    sessionId: session.id, tradeId: trade.id, symbol: sym, market, setup: 'E2E-测试',
    followedPlan: true, emotion: '平静', mistakeTag: null, content: 'E2E 多市场闭环验证',
    snapshot: { entry, stop, target: entry * 1.02, exit: exitPrice, r, side: 'long' },
  });
  log(`${market} 复盘落库`, journal.market === market && journal.tradeId === trade.id, `id=${journal.id} market=${journal.market}`);

  // 7. 读回会话详情
  const detail = await j('GET', `/api/sessions/${session.id}`);
  log(`${market} 会话读回`, detail.market === market && detail.trades.length === 1 && detail.journal.length === 1,
    `trades=${detail.trades.length} journal=${detail.journal.length} tradeMarket=${detail.trades[0]?.market}`);

  // 8. 统计接口按市场过滤
  const st = await j('GET', `/api/stats?market=${market}`);
  const mine = st.bySymbol.filter((x) => x.market === market);
  log(`${market} 统计过滤`, st.overall.trades >= 1 && mine.length >= 1,
    `overall.trades=${st.overall.trades} totalR=${st.overall.totalR.toFixed(2)} bySymbol=${JSON.stringify(mine.map((x) => x.symbol + ':' + x.market))}`);

  // 9. 市场隔离：另一个市场的统计不应包含本次交易
  const others = ['perp', 'spot', 'stock'].filter((x) => x !== market);
  for (const o of others) {
    const so = await j('GET', `/api/stats?market=${o}`);
    const leak = so.bySymbol.some((x) => x.symbol === sym && x.market === market);
    log(`${market}→${o} 市场隔离`, !leak, leak ? '存在串市场数据' : '无串数据');
  }
}

function checkGap(bars) {
  const all = [];
  for (let i = 1; i < bars.length; i++) {
    const d = (bars[i].time - bars[i - 1].time) / 3600000;
    if (d !== 1) all.push({ at: bars[i].time, hours: d });
  }
  return { gaps: all.length, all };
}

(async () => {
  for (const m of ['perp', 'spot', 'stock']) {
    try { await runMarket(m); }
    catch (e) { log(`${m} 异常`, false, e.message); }
  }
  const bad = rows.filter((r) => !r.ok);
  console.log(`\n════ 汇总：${rows.length - bad.length}/${rows.length} 通过 ════`);
  if (bad.length) {
    console.log('失败项：');
    for (const b of bad) console.log('  -', b.m, '|', b.detail);
    process.exit(1);
  }
})();
