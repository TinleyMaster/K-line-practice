/**
 * 清理验证脚本产生的测试数据（需求 5）。
 *
 * 安全原则：
 *   1. **先统计后删除** —— 打印将要删除的每一项，用户能核对
 *   2. **白名单保留** —— 用户自己的账号（tinley）及其全部数据一律不动
 *   3. **只删 practice schema 的业务表** —— 绝不碰 K 线行情数据、用户账号表
 *   4. **可重复执行** —— 跑第二遍不会误删
 *
 * 要删的两类：
 *   A. 测试账号（username 命中测试命名模式，且不在保留名单里）
 *      → sessions / trades / journal_entries 由外键 ON DELETE CASCADE 自动带走
 *   B. 未登录态的历史练习记录（user_id IS NULL）
 *      → 验证脚本在未登录时写入的残留
 */
/**
 * 清理验证脚本产生的测试数据（正式工具）。
 *
 * 用法：
 *   node scripts/tools/cleanup-test-data.js          # 预览（只统计不删）
 *   node scripts/tools/cleanup-test-data.js --yes    # 真删
 */
import { query, closePool } from '../../server/src/db.js';

/** 用户自己的账号 —— 一律保留 */
const KEEP_USERNAMES = ['tinley'];

/** 验证脚本的账号命名模式（子串匹配，大小写不敏感） */
const TEST_PATTERNS = ['v6ui_', 'v6test_', 'e2e_', 'test_', 'pk_', 'verify_', 'check_'];

const t = async (sql, params) => (await query(sql, params)).rows;

function isTestUser(username) {
  const u = String(username).toLowerCase();
  return TEST_PATTERNS.some((p) => u.includes(p.toLowerCase()));
}

console.log('\n═══ 清理前统计 ═══\n');

const users = await t(`SELECT id, username, display_name, created_at FROM practice.users ORDER BY id`);
console.log('── 账号 ──');
console.table(users);

const countOf = async (table, where = '') => {
  const r = await t(`SELECT count(*)::int AS n FROM practice.${table} ${where}`);
  return r[0].n;
};

const before = {
  sessions: await countOf('sessions'),
  trades: await countOf('trades'),
  journal: await countOf('journal_entries'),
  authTokens: await countOf('auth_tokens'),
};
console.log('── 数据量（清理前）──');
console.table(before);

// A. 测试账号
const testUsers = users.filter((u) => !KEEP_USERNAMES.includes(u.username) && isTestUser(u.username));
const otherUsers = users.filter((u) => !KEEP_USERNAMES.includes(u.username) && !isTestUser(u.username));
if (otherUsers.length) {
  console.log('\n⚠️ 以下账号既不在保留名单、也不匹配测试模式 —— **不动**，请人工确认：');
  console.table(otherUsers);
}

// B. 未登录态记录
const anon = {
  sessions: await countOf('sessions', 'WHERE user_id IS NULL'),
  trades: await countOf('trades', 'WHERE user_id IS NULL'),
  journal: await countOf('journal_entries', 'WHERE user_id IS NULL'),
};
console.log('\n── 未登录态（user_id IS NULL）记录 ──');
console.table(anon);

const keepUserIds = users.filter((u) => KEEP_USERNAMES.includes(u.username)).map((u) => u.id);
console.log(`\n保留账号 id：${keepUserIds.length ? keepUserIds.join(', ') : '(无)'}`);

if (!process.argv.includes('--yes')) {
  console.log('\n⚠️ 上面是预览。加 --yes 参数才会真正执行删除。');
  await closePool();
  process.exit(0);
}

console.log('\n═══ 执行删除 ═══');

for (const u of testUsers) {
  await query(`DELETE FROM practice.users WHERE id = $1`, [u.id]);
  console.log(`  已删除测试账号：${u.username}（id=${u.id}，级联清掉其会话/交易/复盘）`);
}

// 未登录态记录：按外键顺序（journal → trades → sessions）
const delJournal = await query(`DELETE FROM practice.journal_entries WHERE user_id IS NULL`);
console.log(`  已删除未登录复盘 ${delJournal.rowCount} 条`);
const delTrades = await query(`DELETE FROM practice.trades WHERE user_id IS NULL`);
console.log(`  已删除未登录交易 ${delTrades.rowCount} 条`);
const delSessions = await query(`DELETE FROM practice.sessions WHERE user_id IS NULL`);
console.log(`  已删除未登录会话 ${delSessions.rowCount} 条`);

const after = {
  sessions: await countOf('sessions'),
  trades: await countOf('trades'),
  journal: await countOf('journal_entries'),
  authTokens: await countOf('auth_tokens'),
};
console.log('\n── 数据量（清理后）──');
console.table(after);

const left = await t(`SELECT id, username FROM practice.users ORDER BY id`);
console.log('── 剩余账号 ──');
console.table(left);

console.log('\n✅ 清理完成（K 线行情数据未触碰）');
await closePool();
