import crypto from 'node:crypto';
import { query, queryOne, queryRows } from '../db.js';
import { PRAC } from '../config.js';

/**
 * 账号体系（v6）。
 *
 * 设计取舍：两人共用的练习台，不引入完整 RBAC —— 只有「注册 / 登录 / 登出」三件事。
 * 密码用 scrypt（N=16384）加盐哈希，不存明文，也不用 bcrypt/argon2 依赖
 * （node:crypto 内置，零新增依赖）。
 *
 * Token：随机 32 字节 hex，明文存库。理由是本项目只有两个人用，
 * 登出后能立刻作废比「无状态 JWT 难以撤销」更重要。
 */

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天

/** 生成随机 salt（hex） */
function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/** 口令 → scrypt 哈希（hex） */
export function hashPassword(password, salt) {
  const s = salt ?? newSalt();
  const hash = crypto
    .scryptSync(String(password), s, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
    })
    .toString('hex');
  return { hash, salt: s };
}

/** 校验口令（定长比较，防时序侧信道） */
export function verifyPassword(password, hash, salt) {
  const candidate = hashPassword(password, salt).hash;
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 用户名规范化：去空格 + 转小写（登录时也用同一套，避免大小写分裂成两个号） */
function normalizeUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/** 注册。返回 { user, token }，用户名已存在则抛错。 */
export async function register({ username, password, displayName }) {
  const uname = normalizeUsername(username);
  if (!/^[a-z0-9_.-]{3,32}$/.test(uname)) {
    throw new Error('用户名需为 3~32 位字母/数字/下划线/点/短横线');
  }
  if (String(password ?? '').length < 4) {
    throw new Error('密码至少 4 位');
  }

  const exists = await queryOne(
    `SELECT id FROM ${PRAC.schema}.users WHERE username = $1`,
    [uname],
  );
  if (exists) throw new Error('用户名已存在');

  const { hash, salt } = hashPassword(password);
  const row = await queryOne(
    `INSERT INTO ${PRAC.schema}.users (username, display_name, password_hash, salt)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, display_name, created_at`,
    [uname, String(displayName ?? '').trim() || uname, hash, salt],
  );

  const token = await issueToken(row.id);
  return { user: mapUser(row), token };
}

/** 登录。返回 { user, token }，口令错或用户不存在都返回同一句错误（不泄露用户是否存在）。 */
export async function login({ username, password }) {
  const uname = normalizeUsername(username);
  const row = await queryOne(
    `SELECT id, username, display_name, password_hash, salt, created_at
       FROM ${PRAC.schema}.users WHERE username = $1`,
    [uname],
  );
  if (!row || !verifyPassword(password ?? '', row.password_hash, row.salt)) {
    throw new Error('用户名或密码错误');
  }
  const token = await issueToken(row.id);
  return { user: mapUser(row), token };
}

/** 签发 token */
async function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + TOKEN_TTL_MS);
  await query(
    `INSERT INTO ${PRAC.schema}.auth_tokens (token, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [token, userId, expires.toISOString()],
  );
  // 顺手清掉该用户的过期 token
  await query(
    `DELETE FROM ${PRAC.schema}.auth_tokens WHERE user_id = $1 AND expires_at < now()`,
    [userId],
  );
  return token;
}

/** 登出：作废 token */
export async function logout(token) {
  if (!token) return false;
  const r = await query(`DELETE FROM ${PRAC.schema}.auth_tokens WHERE token = $1`, [token]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 由 token 解析用户。
 * 过期 token 顺手删掉。
 */
export async function resolveUser(token) {
  if (!token) return null;
  const row = await queryOne(
    `SELECT u.id, u.username, u.display_name, u.created_at, t.expires_at
       FROM ${PRAC.schema}.auth_tokens t
       JOIN ${PRAC.schema}.users u ON u.id = t.user_id
      WHERE t.token = $1`,
    [token],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query(`DELETE FROM ${PRAC.schema}.auth_tokens WHERE token = $1`, [token]);
    return null;
  }
  return mapUser(row);
}

/** 列出所有用户（用于 PK 页面） */
export async function listUsers() {
  const rows = await queryRows(
    `SELECT id, username, display_name, created_at FROM ${PRAC.schema}.users ORDER BY id`,
  );
  return rows.map(mapUser);
}

/** 把 user_id 反填给历史数据（存量数据没有 owner，按时间最早的账号归属，或留给 null） */
export async function countUsers() {
  const row = await queryOne(`SELECT count(*)::int AS n FROM ${PRAC.schema}.users`);
  return Number(row?.n ?? 0);
}

function mapUser(r) {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name || r.username,
    createdAt: r.created_at,
  };
}

/**
 * Express 中间件：从 Authorization 头解析用户，挂到 req.user。
 *
 * 设计：**不强制**。未登录时 req.user = null，请求照常放行。
 * 理由：练习台的核心是单机使用，两人才刚开始用账号体系；
 * 强制登录会让「打开就能练」这件事变复杂。数据隔离在**写入**时保证
 * （写入必带 user_id），读取时按 user_id 过滤（未登录只看自己或全部）。
 */
export async function attachUser(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    req.authToken = token || null;
    req.user = token ? await resolveUser(token) : null;
  } catch {
    req.user = null;
  }
  next();
}
