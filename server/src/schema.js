import { PRAC } from './config.js';

/**
 * practice schema 建表 DDL。
 * 铁律：这里所有对象都落在 practice schema 内，
 * 原项目表（biz.asset_klines 等）永远只读，不 ALTER / 不 DELETE / 不 INSERT。
 */
export const DDL = [
  `CREATE SCHEMA IF NOT EXISTS ${PRAC.schema}`,

  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.symbols (
     symbol       text NOT NULL,
     market       text NOT NULL DEFAULT 'perp',
     base         text NOT NULL,
     quote        text NOT NULL DEFAULT 'USDT',
     category     text NOT NULL DEFAULT 'crypto_perp',
     enabled      boolean NOT NULL DEFAULT true,
     sort_rank    integer,
     note         text,
     source_symbol text,
     external_ref  jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at   timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (market, symbol)
   )`,

  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.setups (
     id               bigserial PRIMARY KEY,
     name             text UNIQUE NOT NULL,
     description      text NOT NULL DEFAULT '',
     market_condition text NOT NULL DEFAULT '',
     entry_rules      jsonb NOT NULL DEFAULT '[]'::jsonb,
     exit_rules       jsonb NOT NULL DEFAULT '[]'::jsonb,
     color            text NOT NULL DEFAULT '#5470c6',
     enabled          boolean NOT NULL DEFAULT true,
     created_at       timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.sessions (
     id           bigserial PRIMARY KEY,
     symbol       text NOT NULL,
     market       text NOT NULL DEFAULT 'perp',
     base_interval text NOT NULL DEFAULT '1h',
     trend_interval text NOT NULL DEFAULT '4h',
     mode         text NOT NULL DEFAULT 'replay',
     start_time   timestamptz,
     end_time     timestamptz,
     cursor_time  timestamptz,
     status       text NOT NULL DEFAULT 'active',
     equity_start numeric(20,4) NOT NULL DEFAULT 10000,
     equity_end   numeric(20,4),
     bars_played  integer NOT NULL DEFAULT 0,
     meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at   timestamptz NOT NULL DEFAULT now(),
     updated_at   timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.trades (
     id            bigserial PRIMARY KEY,
     session_id    bigint NOT NULL REFERENCES ${PRAC.schema}.sessions(id) ON DELETE CASCADE,
     symbol        text NOT NULL,
     market        text NOT NULL DEFAULT 'perp',
     side          text NOT NULL,
     setup         text,
     entry_time    timestamptz NOT NULL,
     entry_price   numeric(24,10) NOT NULL,
     exit_time     timestamptz,
     exit_price    numeric(24,10),
     stop_loss     numeric(24,10),
     take_profit   numeric(24,10),
     risk_amount   numeric(20,4) NOT NULL DEFAULT 0,
     qty           numeric(24,12) NOT NULL DEFAULT 0,
     r_multiple    numeric(12,4),
     pnl           numeric(20,4),
     status        text NOT NULL DEFAULT 'open',
     exit_reason   text,
     checklist     jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at    timestamptz NOT NULL DEFAULT now(),
     updated_at    timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.journal_entries (
     id            bigserial PRIMARY KEY,
     session_id    bigint REFERENCES ${PRAC.schema}.sessions(id) ON DELETE CASCADE,
     trade_id      bigint REFERENCES ${PRAC.schema}.trades(id) ON DELETE CASCADE,
     symbol        text,
     market        text NOT NULL DEFAULT 'perp',
     setup         text,
     followed_plan boolean,
     emotion       text,
     mistake_tag   text,
     content       text NOT NULL DEFAULT '',
     snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at    timestamptz NOT NULL DEFAULT now()
   )`,

  // 缺口回填数据（v2 起承载 spot / 链上美股；v1 加密合约从原表物化过来）
  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.klines (
     symbol      text NOT NULL,
     market      text NOT NULL DEFAULT 'perp',
     interval    text NOT NULL,
     open_time   timestamptz NOT NULL,
     open_px     numeric(24,10) NOT NULL,
     high_px     numeric(24,10) NOT NULL,
     low_px      numeric(24,10) NOT NULL,
     close_px    numeric(24,10) NOT NULL,
     base_vol    numeric(30,10) NOT NULL DEFAULT 0,
     quote_vol   numeric(30,10) NOT NULL DEFAULT 0,
     trade_count bigint NOT NULL DEFAULT 0,
     source      text NOT NULL DEFAULT 'binance',
     PRIMARY KEY (market, symbol, interval, open_time)
   )`,

  // 覆盖度缓存：源表 1340 万行实时聚合要 8s，物化后写这里，读取瞬时
  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.symbol_coverage (
     symbol      text NOT NULL,
     market      text NOT NULL DEFAULT 'perp',
     interval    text NOT NULL,
     bars        integer NOT NULL DEFAULT 0,
     first_time  timestamptz,
     last_time   timestamptz,
     updated_at  timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (market, symbol, interval)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_practice_sessions_symbol_time
     ON ${PRAC.schema}.sessions (symbol, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_practice_trades_session
     ON ${PRAC.schema}.trades (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_practice_trades_setup
     ON ${PRAC.schema}.trades (setup) WHERE setup IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_practice_trades_closed
     ON ${PRAC.schema}.trades (status, exit_time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_practice_journal_session
     ON ${PRAC.schema}.journal_entries (session_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_practice_journal_trade
     ON ${PRAC.schema}.journal_entries (trade_id)`,
];

export async function initSchema(exec) {
  for (const stmt of DDL) {
    await exec(stmt);
  }
}

/**
 * market 维度迁移（v2 引入 perp / spot / stock 三类市场）。
 *
 * 背景：同一个 symbol（例如 BTCUSDT）在「合约」与「现货」两个市场都存在，
 * 主键里必须带 market 才不会互相覆盖。
 *
 * 幂等：先读当前主键列，已是目标形态就跳过；
 * 只有结构不对时才 DROP + ADD PRIMARY KEY（klines 约 150 万行，重建索引需数十秒）。
 */
export async function migrateMarketDimension(exec) {
  const PLAN = [
    { table: 'symbols', pk: ['market', 'symbol'] },
    { table: 'klines', pk: ['market', 'symbol', 'interval', 'open_time'] },
    { table: 'symbol_coverage', pk: ['market', 'symbol', 'interval'] },
  ];

  const changed = [];

  // 第 1 步：补列。
  // CREATE TABLE IF NOT EXISTS 对已存在的表是 no-op，所以存量库必须显式 ADD COLUMN。
  // PG 11+ 对「有默认值 + NOT NULL」的 ADD COLUMN 走 fast path，不重写整表。
  for (const p of PLAN) {
    await exec(
      `ALTER TABLE ${PRAC.schema}.${p.table}
         ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'perp'`,
    );
  }
  // 练习记录（会话/交易/复盘）也要带市场维度，
  // 否则同一个 BTCUSDT 在合约与现货的交易会被统计混在一起。
  for (const t of ['sessions', 'trades', 'journal_entries']) {
    await exec(
      `ALTER TABLE ${PRAC.schema}.${t}
         ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'perp'`,
    );
  }
  // symbols 的上游映射字段（链上美股要存合约地址 / 池信息）
  await exec(
    `ALTER TABLE ${PRAC.schema}.symbols ADD COLUMN IF NOT EXISTS source_symbol text`,
  );
  await exec(
    `ALTER TABLE ${PRAC.schema}.symbols
       ADD COLUMN IF NOT EXISTS external_ref jsonb NOT NULL DEFAULT '{}'::jsonb`,
  );

  // 第 2 步：重建主键（若列已就位则跳过）
  for (const p of PLAN) {
    const res = await exec(
      `SELECT c.conname AS name, a.attname AS col
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = '${PRAC.schema}.${p.table}'::regclass
          AND c.contype = 'p'
        ORDER BY array_position(c.conkey, a.attnum)`,
    );
    const rows = res?.rows ?? [];

    // 没有主键约束（例如上一次迁移在 DROP 之后中断）→ 直接补建
    if (rows.length === 0) {
      console.log(`[schema] ${p.table} 缺少主键约束，新建 (${p.pk.join(', ')})`);
      await exec(
        `ALTER TABLE ${PRAC.schema}.${p.table} ADD PRIMARY KEY (${p.pk.join(', ')})`,
      );
      changed.push(p.table);
      continue;
    }

    const cols = rows.map((r) => r.col);
    const alreadyOk =
      cols.length === p.pk.length && p.pk.every((c, i) => c === cols[i]);
    if (alreadyOk) continue;

    const conName = rows[0].name;
    console.log(
      `[schema] ${p.table} 主键迁移: (${cols.join(', ')}) -> (${p.pk.join(', ')})`,
    );
    await exec(`ALTER TABLE ${PRAC.schema}.${p.table} DROP CONSTRAINT ${conName}`);
    await exec(
      `ALTER TABLE ${PRAC.schema}.${p.table} ADD PRIMARY KEY (${p.pk.join(', ')})`,
    );
    changed.push(p.table);
  }

  if (changed.length === 0) {
    console.log('[schema] market 维度主键已是最新，无需重建');
  } else {
    console.log('[schema] market 维度主键重建完成:', changed.join(', '));
  }
  return changed;
}
