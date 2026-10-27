import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(serverRoot, '..');

// 优先读 server/.env，其次读项目根 .env
loadEnv({ path: path.join(serverRoot, '.env') });
loadEnv({ path: path.join(projectRoot, '.env') });

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  databaseUrl: process.env.DATABASE_URL || '',

  sourceSchema: process.env.SOURCE_SCHEMA || 'biz',
  sourceTable: process.env.SOURCE_TABLE || 'asset_klines',

  practiceSchema: process.env.PRACTICE_SCHEMA || 'practice',

  dataSource: process.env.DATA_SOURCE || 'binance_perp',

  // 出口代理（可选）：留空 = 直连。例：http://127.0.0.1:7890
  // 仅在数据源需要代理时设置（如 GeckoTerminal / 境外接口在本地网络不可达）
  fetchProxy: process.env.FETCH_PROXY || '',

  autoInitDb: String(process.env.AUTO_INIT_DB ?? 'true').toLowerCase() === 'true',

  // 启动预热：把已登记标的提前拉进内存缓存（跨机 DB RTT 高时收益明显）
  prewarm: String(process.env.PREWARM ?? 'true').toLowerCase() === 'true',
  prewarmLimit: Number(process.env.PREWARM_LIMIT || 1200),
  prewarmConcurrency: Number(process.env.PREWARM_CONCURRENCY || 8),

  // 15m 预热标的（逗号分隔）。15m 数据量是 1h 的 4 倍，只给核心标的做。
  prewarmDeepSymbols: String(process.env.PREWARM_DEEP_SYMBOLS || 'BTCUSDT,ETHUSDT')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  prewarmDeepLimit: Number(process.env.PREWARM_DEEP_LIMIT || 4800),

  // 内存缓存存活时长（毫秒）。超过后走 stale-while-revalidate：
  // 先返回旧数据，后台静默刷新，用户不卡顿。
  cacheTtlMs: Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000),

  projectRoot,
  serverRoot,
  webDist: path.join(projectRoot, 'web', 'dist'),
};

// 标识符安全校验：schema/table 名不允许被注入
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
export function safeIdent(name, label) {
  if (!IDENT_RE.test(String(name))) {
    throw new Error(`非法标识符 ${label}: ${name}`);
  }
  return name;
}

export const SRC = {
  schema: safeIdent(config.sourceSchema, 'SOURCE_SCHEMA'),
  table: safeIdent(config.sourceTable, 'SOURCE_TABLE'),
};

export const PRAC = {
  schema: safeIdent(config.practiceSchema, 'PRACTICE_SCHEMA'),
};

if (!config.databaseUrl) {
  console.error('[config] 缺少 DATABASE_URL，请复制 .env.example 为 .env 并填入真实连接串');
}
