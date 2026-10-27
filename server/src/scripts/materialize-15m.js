import { query, closePool } from '../db.js';
import { PRAC, SRC } from '../config.js';
import { initSchema, migrateMarketDimension, migrateV6 } from '../schema.js';
import { refreshCoverage } from '../services/klineService.js';

/**
 * 物化源表 biz.asset_klines 的 15m 到 practice.klines。
 *
 * 为什么单独一个脚本：
 *   v1~v6 的 `materialize.js` 只物化 1h，源表里的 15m（530 标的 × 41 天）
 *   一直躺在那儿没进 practice —— 于是**除 BTC/ETH 外几乎所有标的都没有 15m**。
 *
 * 为什么能这么快：
 *   走的是 `INSERT INTO practice ... SELECT FROM biz.asset_klines`，
 *   **纯数据库内部操作**，数据不跨机传输。
 *   对比走币安 API 回填：跨机写 515 行/秒 ⇒ 84 万行要 27 分钟；
 *   PG 内部插 84 万行只要几十秒。
 *
 * 增量语义（与 materializeSymbol 一致）：
 *   只插比该标的现有最大 open_time 更新的数据 ——
 *   BTC/ETH 已经有 2022-12 起的深历史（比源表 41 天深得多），不会被源表覆盖。
 *
 * 只读源表：SELECT，不 ALTER / DELETE / INSERT biz.*（铁律）。
 *
 * 用法：node src/scripts/materialize-15m.js [并发数] [--all]
 *
 * 默认只处理**练习白名单**里 enabled 的 perp 标的 ——
 * 源表 530 个标的里有大量垃圾币（1000000MOGUSDT 只有 106 根），
 * 而 UI 的标的列表本来就只来自 practice.symbols，物化全量是浪费。
 * 加 --all 则处理源表所有 15m 标的。
 */
async function main() {
  const args = process.argv.slice(2).filter((a) => !/^\d+$/.test(a));
  const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const concurrency = nums[0] || 6;
  const limit = nums[1] || 0;
  const all = args.includes('--all');

  await initSchema((sql) => query(sql));
  await migrateMarketDimension((sql) => query(sql));
  await migrateV6((sql) => query(sql));

  // 源表里所有有 15m 的标的
  const srcRows = await query(
    `SELECT DISTINCT symbol FROM ${SRC.schema}.${SRC.table}
      WHERE interval = '15m' ORDER BY symbol`,
  );
  const srcSymbols = srcRows.rows.map((r) => r.symbol);

  // 默认只取练习白名单里 enabled 的 perp 标的
  let symbols = srcSymbols;
  if (!all) {
    const wl = await query(
      `SELECT symbol FROM ${PRAC.schema}.symbols
        WHERE enabled = true AND market = 'perp' AND symbol = ANY($1)`,
      [srcSymbols],
    );
    symbols = wl.rows.map((r) => r.symbol);
    const missing = srcSymbols.filter((s) => !symbols.includes(s));
    console.log(
      `[mat15m] 源表 15m 覆盖 ${srcSymbols.length} 个标的；白名单命中 ${symbols.length} 个` +
        (missing.length ? `（白名单外 ${missing.length} 个未处理，加 --all 可全量）` : ''),
    );
  } else {
    console.log(`[mat15m] 源表 15m 覆盖 ${srcSymbols.length} 个标的（全量模式）`);
  }

  if (limit > 0) symbols = symbols.slice(0, limit);
  console.log(`[mat15m] 待物化 ${symbols.length} 个标的，并发 ${concurrency}`);

  let done = 0;
  let inserted = 0;
  let failed = 0;
  const t0 = Date.now();

  const worker = async (sym) => {
    const ts = Date.now();
    try {
      const r = await query(
        `INSERT INTO ${PRAC.schema}.klines
           (market, symbol, interval, open_time, open_px, high_px, low_px, close_px,
            base_vol, quote_vol, trade_count, source)
         SELECT 'perp', k.symbol, k.interval, k.open_time, k.open_px, k.high_px, k.low_px, k.close_px,
                k.base_vol, k.quote_vol, k.trade_count, 'binance_perp'
           FROM ${SRC.schema}.${SRC.table} k
          WHERE k.symbol = $1 AND k.interval = '15m'
            AND k.open_time > COALESCE(
                  (SELECT max(p.open_time) FROM ${PRAC.schema}.klines p
                    WHERE p.market = 'perp' AND p.symbol = $1 AND p.interval = '15m'),
                  '1970-01-01T00:00:00Z'::timestamptz)
          ON CONFLICT (market, symbol, interval, open_time) DO NOTHING`,
        [sym],
      );
      inserted += r.rowCount;
      done++;
      if (r.rowCount > 0) {
        console.log(`  ✓ ${sym} 插入 ${r.rowCount} 根 (${((Date.now() - ts) / 1000).toFixed(2)}s)`);
      }
    } catch (e) {
      failed++;
      console.error(`  ✗ ${sym}: ${e.message}`);
    }
  };

  const queue = [...symbols];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) await worker(queue.shift());
    }),
  );

  // 刷新白名单标的的覆盖度缓存
  const wl = await query(
    `SELECT symbol FROM ${PRAC.schema}.symbols WHERE enabled = true AND market = 'perp'`,
  );
  for (const r of wl.rows) {
    await refreshCoverage(r.symbol, '15m', 'perp');
  }

  const stats = await query(
    `SELECT count(DISTINCT symbol)::int AS symbols, count(*)::int AS bars,
            min(open_time) AS first_time, max(open_time) AS last_time
       FROM ${PRAC.schema}.klines WHERE interval = '15m'`,
  );
  console.log(
    `[mat15m] 完成 ${done} 个标的，插入 ${inserted} 行，失败 ${failed}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.log('[mat15m] 15m 总览:', stats.rows[0]);
  await closePool();
}

main().catch(async (err) => {
  console.error('[mat15m] 失败:', err);
  await closePool();
  process.exit(1);
});
