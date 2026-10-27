import { query, closePool } from '../db.js';
import { initSchema, migrateMarketDimension } from '../schema.js';

async function main() {
  console.log('[init-db] 开始建表...');
  await initSchema((sql) => query(sql));
  console.log('[init-db] 检查 market 维度主键...');
  await migrateMarketDimension((sql) => query(sql));
  const rows = await query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='practice' ORDER BY table_name`,
  );
  console.log('[init-db] practice schema 表清单:', rows.rows.map((r) => r.table_name).join(', ') || '(空)');
  console.log('[init-db] 完成。');
  await closePool();
}

main().catch(async (err) => {
  console.error('[init-db] 失败:', err);
  await closePool();
  process.exit(1);
});
