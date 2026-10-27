import pg from 'pg';
import { config } from './config.js';

// pg 默认把 int8 解析成字符串，这里统一成 number，避免前端拿到 "123"
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
// numeric -> number（保留精度足够用于 K 线展示）
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

let pool = null;

/** 连接类错误才值得重试（业务错误重试没意义） */
const RETRYABLE = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'Connection terminated',
  'connection timeout',
  'timeout exceeded',
  '57P01',
  '08006',
  '08003',
];

function isRetryable(err) {
  const msg = `${err?.message ?? ''} ${err?.code ?? ''}`;
  return RETRYABLE.some((k) => msg.includes(k));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 查询重试包装。
 * 实测：本机到 DB 的链路时延波动极大，偶发「连接被终止 / 超时」，
 * 跨机部署时更频繁。重试 3 次基本能盖住抖动，避免整个回填任务被打断。
 */
async function withRetry(fn, label = 'query') {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === 3) throw err;
      const wait = 700 * (attempt + 1);
      console.warn(
        `[db] ${label} 连接异常(${err.message.slice(0, 60)})，${wait}ms 后重试 (${attempt + 1}/3)`,
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * SSL 兼容处理（重要）：
 * pg 8.x 会用连接串里解析出的 ssl 配置 **覆盖** Pool 传入的 ssl 选项，
 * 且 pg-connection-string ≥2.7 把 sslmode=require/prefer/verify-ca 一律当 verify-full
 * （校验服务端证书 → 自签证书直接报 DEPTH_ZERO_SELF_SIGNED_CERT）。
 *
 * 这里把 require/prefer/verify-ca 翻译成 pg 专用的 no-verify：
 * 仍然走 TLS 加密，只是不校验证书链。内网自签场景这是标准做法。
 * 想严格校验证书：把连接串换成 sslmode=verify-full 并配置 sslrootcert。
 */
function resolveConnectionString(raw) {
  const override = process.env.DB_SSLMODE_OVERRIDE;
  if (override) {
    return raw.replace(/sslmode=[^&]*/i, `sslmode=${override}`);
  }
  return raw.replace(/sslmode=(require|prefer|verify-ca)/i, 'sslmode=no-verify');
}

export function getPool() {
  if (!pool) {
    const connectionString = resolveConnectionString(config.databaseUrl);
    const sslMode = (connectionString.match(/sslmode=([^&]*)/i)?.[1] || '').toLowerCase();
    pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 30_000,
      ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify-full' },
    });
    pool.on('error', (err) => {
      console.error('[db] 空闲连接异常:', err.message);
    });
  }
  return pool;
}

export async function query(text, params = []) {
  return withRetry(() => getPool().query(text, params), 'query');
}

export async function queryRows(text, params = []) {
  const res = await withRetry(() => getPool().query(text, params), 'queryRows');
  return res.rows;
}

export async function queryOne(text, params = []) {
  const res = await withRetry(() => getPool().query(text, params), 'queryOne');
  return res.rows[0] ?? null;
}

export async function healthCheck() {
  try {
    const row = await queryOne('SELECT now() AS now');
    return { ok: true, serverTime: row?.now ?? null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
