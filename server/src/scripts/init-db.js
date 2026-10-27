import { query, closePool } from '../db.js';
import { initSchema, migrateMarketDimension, migrateV6 } from '../schema.js';

async function main() {
  console.log('[init-db] 开始建表...');
  await initSchema((sql) => query(sql));
  console.log('[init-db] 检查 market 维度主键...');
  await migrateMarketDimension((sql) => query(sql));
  // v6 迁移：账号维度 + 开仓设置扩展列。
  //
  // 必须在这里跑 —— initSchema 的 CREATE TABLE IF NOT EXISTS 对**已存在的表是 no-op**，
  // 老库（v1~v5 已部署）光跑 initSchema 拿不到这 13 个新列，
  // 升级上来后登录 / 开仓扩展字段直接 500。全幂等，重复执行安全。
  console.log('[init-db] 执行 v6 增量迁移...');
  await migrateV6((sql) => query(sql));
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
