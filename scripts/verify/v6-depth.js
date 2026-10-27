/**
 * v6.3 历史深度验证（DB 层）
 *
 * 为什么单独一个脚本、而不是塞进 v6-api.js：
 *   v6-api.js 是**纯 HTTP 层**验证，而「数据最早能回溯到什么时候」是数据库层事实 ——
 *   API 的 limit 有上限（拿最近 N 根），**永远问不出最早的时间点**。
 *   问错层 ⇒ 断言的是「最近有多少根」而不是「历史有多深」，属于验证对象错位。
 *
 * 契约（BTC/ETH 必须"足够齐全"，v6.3）：
 *   · 15m 与 1h 的起点都要够深，且 **15m 不得比 1h 浅**（15m 是更细的粒度，
 *     理应能回溯到不晚于 1h 的位置；若 15m 起点更晚 = 精入场视图缺历史）
 *   · 起点不得晚于币安的物理下限（现货 2017-08-17 / 合约 2019-09-08）
 *   · 15m 与 1h 在重叠区桶对齐（每个 1h 桶 4 根 15m）
 *
 * 币安物理下限（2026-10-27 实测 startTime=0）：
 *   现货 BTCUSDT / ETHUSDT 15m → 2017-08-17
 *   合约 BTCUSDT 15m → 2019-09-08，ETHUSDT 15m → 2019-11-27
 */
import { query, closePool } from '../../server/src/db.js';

let pass = 0;
let fail = 0;
function log(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** 期望的起点上限（不得晚于这个时间） */
const EXPECT = {
  'perp:BTCUSDT:15m': { notLaterThan: '2020-01-01', label: '合约 BTC 15m' },
  'perp:ETHUSDT:15m': { notLaterThan: '2020-01-01', label: '合约 ETH 15m' },
  'perp:BTCUSDT:1h': { notLaterThan: '2020-01-01', label: '合约 BTC 1h' },
  'perp:ETHUSDT:1h': { notLaterThan: '2020-01-01', label: '合约 ETH 1h' },
  'spot:BTCUSDT:15m': { notLaterThan: '2018-01-01', label: '现货 BTC 15m' },
  'spot:ETHUSDT:15m': { notLaterThan: '2018-01-01', label: '现货 ETH 15m' },
  'spot:BTCUSDT:1h': { notLaterThan: '2018-01-01', label: '现货 BTC 1h' },
  'spot:ETHUSDT:1h': { notLaterThan: '2018-01-01', label: '现货 ETH 1h' },
};

console.log('\n═══ v6.3 BTC/ETH 历史深度（DB 层）═══\n');

const r = await query(`
  SELECT market, symbol, interval,
         count(*)::int AS n,
         min(open_time) AS first,
         max(open_time) AS last
    FROM practice.klines
   WHERE symbol IN ('BTCUSDT','ETHUSDT')
   GROUP BY market, symbol, interval
   ORDER BY market, symbol, interval`);

const byKey = new Map();
for (const row of r.rows) byKey.set(`${row.market}:${row.symbol}:${row.interval}`, row);

const stats = {};

// ── ① 深度：起点不得晚于期望上限 ───────────────────────────────
console.log('── ① 历史深度（起点不晚于币安物理下限）──');
for (const [key, exp] of Object.entries(EXPECT)) {
  const row = byKey.get(key);
  if (!row) {
    log(`${exp.label} 存在且深度足够`, false, '库中查无此序列');
    continue;
  }
  const first = new Date(row.first);
  stats[key] = { n: row.n, first: row.first, last: row.last };
  const ok = first.getTime() <= Date.parse(`${exp.notLaterThan}T00:00:00Z`);
  log(
    `${exp.label} 起点 ≤ ${exp.notLaterThan}`,
    ok,
    `${first.toISOString().slice(0, 10)} · ${row.n} 根 · 至 ${new Date(row.last).toISOString().slice(0, 10)}`,
  );
}

// ── ② 15m 不得比 1h 浅（容差 1 小时）─────────────────────────
//
// 容差说明（别把这个容差当成"放宽标准"）：
//   币安**合约**的首根 1h 桶只覆盖到 :45 才有 15m 明细 ——
//   实测 perp/BTCUSDT：1h 首根 2019-09-08T17:00，15m 首根 2019-09-08T17:45。
//   也就是说那根 1h 的前 45 分钟，源数据里根本没有对应的 15m ——
//   这是**数据源的物理事实**，不是回填漏了。
//   所以判定用「15m 起点不晚于 1h 起点 + 1 小时」。
console.log('\n── ② 15m 起点不晚于同标的 1h（更细粒度理应能回溯得更早）──');
for (const market of ['perp', 'spot']) {
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    const b15 = byKey.get(`${market}:${symbol}:15m`);
    const b1h = byKey.get(`${market}:${symbol}:1h`);
    if (!b15 || !b1h) {
      log(`${market}/${symbol} 15m 与 1h 均存在`, false, '缺序列');
      continue;
    }
    const t15 = new Date(b15.first).getTime();
    const t1h = new Date(b1h.first).getTime();
    const ok = t15 <= t1h + 3600000;
    log(
      `${market}/${symbol} 15m 起点 ≤ 1h 起点 +1h`,
      ok,
      `15m=${new Date(b15.first).toISOString().slice(0, 16)} · 1h=${new Date(b1h.first).toISOString().slice(0, 16)}`,
    );
  }
}

// ── ③ 重叠区桶对齐（15m 与 1h 同源时必须严丝合缝）──────────────
console.log('\n── ③ 重叠区桶对齐（每个 1h 桶应有 4 根 15m）──');
for (const [market, symbol] of [
  ['perp', 'BTCUSDT'],
  ['perp', 'ETHUSDT'],
  ['spot', 'BTCUSDT'],
  ['spot', 'ETHUSDT'],
]) {
  // 取最近 1200 个 1h 桶（跨机拉，别拉太多）
  const h = await query(
    `SELECT open_time FROM practice.klines
      WHERE market = $1 AND symbol = $2 AND interval = '1h'
      ORDER BY open_time DESC LIMIT 1200`,
    [market, symbol],
  );
  if (!h.rows.length) {
    log(`${market}/${symbol} 桶对齐率 ≥ 99%`, false, '无 1h 数据');
    continue;
  }
  const since = new Date(h.rows[h.rows.length - 1].open_time).getTime();
  const m = await query(
    `SELECT open_time FROM practice.klines
      WHERE market = $1 AND symbol = $2 AND interval = '15m' AND open_time >= $3`,
    [market, symbol, new Date(since).toISOString()],
  );
  const cnt = new Map();
  for (const row of m.rows) {
    const k = Math.floor(new Date(row.open_time).getTime() / 3600000);
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  let full = 0;
  let partial = 0;
  for (const row of h.rows) {
    const k = Math.floor(new Date(row.open_time).getTime() / 3600000);
    const c = cnt.get(k) ?? 0;
    if (c === 4) full++;
    else if (c > 0) partial++;
  }
  const overlap = full + partial;
  const rate = overlap ? full / overlap : 0;
  log(
    `${market}/${symbol} 重叠区桶对齐率 ≥ 99%`,
    rate >= 0.99,
    `full=${full} partial=${partial} → ${(rate * 100).toFixed(2)}%`,
  );
}

// ── ④ 全库存量（回归基线，防止误删）───────────────────────────
console.log('\n── ④ 全库存量 ──');
const tot = await query(`
  SELECT market, interval, count(*)::int AS n,
         count(DISTINCT symbol)::int AS syms
    FROM practice.klines GROUP BY market, interval ORDER BY market, interval`);
for (const row of tot.rows) {
  console.log(`  · ${row.market}/${row.interval}: ${row.n} 根 / ${row.syms} 标的`);
}

console.log(`\n═══ 深度验证结果：${pass} 通过 / ${fail} 失败 ═══`);
await closePool();
if (fail > 0) process.exitCode = 1;
