import { query, closePool } from '../db.js';
import { PRAC } from '../config.js';
import { initSchema, migrateMarketDimension } from '../schema.js';
import { materializeSymbol, refreshCoverage } from '../services/klineService.js';

/**
 * 批量物化练习白名单里的标的 1h K 线到 practice.klines。
 * 源表 1340 万行直接取数要 26s/3000根，物化后本地读取 <50ms。
 * 用法：node src/scripts/materialize.js [并发数] [只物化前N个]
 * 只处理 market='perp'（现货与链上美股走 backfill.js 外部回填）
 */
async function main() {
  const concurrency = Number(process.argv[2]) || 4;
  const limit = Number(process.argv[3]) || 0;

  await initSchema((sql) => query(sql));
  await migrateMarketDimension((sql) => query(sql));

  const { rows } = await query(
    `SELECT symbol FROM ${PRAC.schema}.symbols
      WHERE enabled = true AND market = 'perp' ORDER BY sort_rank NULLS LAST`,
  );
  const symbols = limit > 0 ? rows.slice(0, limit).map((r) => r.symbol) : rows.map((r) => r.symbol);
  console.log(`[materialize] 待物化 ${symbols.length} 个标的，并发 ${concurrency}`);

  let done = 0;
  const t0 = Date.now();
  let failed = 0;

  const worker = async (sym) => {
    const ts = Date.now();
    try {
      await materializeSymbol(sym);
      await refreshCoverage(sym, '1h', 'perp');
      console.log(`  ✓ ${sym} (${((Date.now() - ts) / 1000).toFixed(1)}s)`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${sym}: ${e.message}`);
    } finally {
      done++;
    }
  };

  const queue = [...symbols];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const sym = queue.shift();
      await worker(sym);
    }
  });
  await Promise.all(workers);

  const stats = await query(
    `SELECT count(*)::int AS symbols, sum(bars)::bigint AS bars, min(first_time) AS first_time, max(last_time) AS last_time
       FROM ${PRAC.schema}.symbol_coverage WHERE interval='1h'`,
  );
  console.log(`[materialize] 完成 ${done} 个，失败 ${failed}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('[materialize] 缓存总览:', stats.rows[0]);
  await closePool();
}

main().catch(async (err) => {
  console.error('[materialize] 失败:', err);
  await closePool();
  process.exit(1);
});
