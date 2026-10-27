import { query, closePool } from '../db.js';
import { PRAC } from '../config.js';

/**
 * 清空练习记录（sessions / trades / journal_entries）。
 *
 * 用途：
 *   - 自动化测试后把数据恢复到「从零开始」的状态；
 *   - 正式使用前清掉测试期间产生的脏记录。
 *
 * ⚠️ 只删 practice schema 里的**练习记录**三张表，
 *    绝不动 klines / symbols / setups / symbol_coverage，也绝不动原项目表。
 *
 * 用法：
 *   node src/scripts/reset-practice.js            # 先打印将要删除的行数，确认后执行
 *   node src/scripts/reset-practice.js --yes      # 跳过确认直接执行
 *   node src/scripts/reset-practice.js --market=spot   # 只清某个市场
 */

const args = process.argv.slice(2);
const skipConfirm = args.includes('--yes');
const marketArg = args.find((a) => a.startsWith('--market='));
const market = marketArg ? marketArg.split('=')[1] : null;

async function main() {
  const where = market ? "WHERE market = '" + market.replace(/'/g, '') + "'" : '';

  const counts = await query(
    `SELECT
       (SELECT count(*)::int FROM ${PRAC.schema}.journal_entries ${where}) AS journal,
       (SELECT count(*)::int FROM ${PRAC.schema}.trades ${where}) AS trades,
       (SELECT count(*)::int FROM ${PRAC.schema}.sessions ${where}) AS sessions`,
  );
  const c = counts.rows[0];

  console.log(
    `[reset] 将删除：journal_entries ${c.journal} / trades ${c.trades} / sessions ${c.sessions}` +
      (market ? `（market=${market}）` : '（全部市场）'),
  );

  if (!skipConfirm) {
    console.log('[reset] 提示：加 --yes 参数可跳过确认直接执行');
    await closePool();
    return;
  }

  // 顺序：journal → trades → sessions（外键级联，但显式删除更可控）
  await query(`DELETE FROM ${PRAC.schema}.journal_entries ${where}`);
  await query(`DELETE FROM ${PRAC.schema}.trades ${where}`);
  await query(`DELETE FROM ${PRAC.schema}.sessions ${where}`);

  const after = await query(
    `SELECT
       (SELECT count(*)::int FROM ${PRAC.schema}.journal_entries ${where}) AS journal,
       (SELECT count(*)::int FROM ${PRAC.schema}.trades ${where}) AS trades,
       (SELECT count(*)::int FROM ${PRAC.schema}.sessions ${where}) AS sessions`,
  );
  const a = after.rows[0];
  console.log(
    `[reset] 已清空：journal_entries ${c.journal}→${a.journal} / trades ${c.trades}→${a.trades} / sessions ${c.sessions}→${a.sessions}`,
  );
  console.log('[reset] K 线数据与白名单未受影响');
  await closePool();
}

main().catch(async (err) => {
  console.error('[reset] 失败:', err);
  await closePool();
  process.exit(1);
});
