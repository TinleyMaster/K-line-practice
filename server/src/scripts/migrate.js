import { query, closePool } from '../db.js';
import { migrateMarketDimension, migrateV6 } from '../schema.js';

/**
 * 只跑增量迁移，不建表。
 *
 * 用途：老库升级（v1~v5 → v6）时单独补列，
 * 不想碰「建表」逻辑（生产上 CREATE TABLE 归 db:init 管）。
 *
 * 全幂等：所有迁移都用 IF NOT EXISTS，重复执行安全。
 */
async function main() {
  console.log('[migrate] 检查 market 维度主键...');
  await migrateMarketDimension((sql) => query(sql));

  console.log('[migrate] 执行 v6 增量迁移（账号维度 + 开仓设置扩展列）...');
  await migrateV6((sql) => query(sql));

  // 迁移后自检：确认关键列真的在
  const cols = await query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'practice'
        AND (table_name, column_name) IN (
          ('trades','entry_mode'), ('trades','stop_type'), ('trades','fee_rate'),
          ('trades','confidence'), ('trades','notes'), ('trades','user_id'),
          ('sessions','user_id'), ('journal_entries','user_id'),
          ('journal_entries','skipped')
        )
      ORDER BY table_name, column_name`,
  );
  const got = cols.rows.map((r) => `${r.table_name}.${r.column_name}`);
  const expect = [
    'journal_entries.skipped', 'journal_entries.user_id',
    'sessions.user_id',
    'trades.confidence', 'trades.entry_mode', 'trades.fee_rate',
    'trades.notes', 'trades.stop_type', 'trades.user_id',
  ];
  const missing = expect.filter((c) => !got.includes(c));
  if (missing.length) {
    console.error('[migrate] ❌ 自检失败，以下列缺失:', missing.join(', '));
    await closePool();
    process.exit(1);
  }
  console.log('[migrate] ✅ 自检通过：9 个 v6 关键列全部就位');
  console.log('[migrate] 完成。');
  await closePool();
}

main().catch(async (err) => {
  console.error('[migrate] 失败:', err);
  await closePool();
  process.exit(1);
});
