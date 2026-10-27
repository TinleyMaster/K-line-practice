import { PRAC } from './config.js';

/**
 * v6 账号体系 DDL（单独抽一份）。
 *
 * 为什么单独抽：migrateV6 要给 sessions / trades / journal_entries 加
 * `user_id bigint REFERENCES ...users(id)` 外键列 —— **外键引用的表必须先存在**。
 * 而老库（v1~v5 已部署）根本没有 users 表，
 * 所以迁移必须自己先把前置表建出来，不能假设 initSchema 跑过。
 */
export const ACCOUNT_TABLES = [
  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.users (
     id            bigserial PRIMARY KEY,
     username      text UNIQUE NOT NULL,
     display_name  text NOT NULL DEFAULT '',
     password_hash text NOT NULL,
     salt          text NOT NULL,
     created_at    timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.auth_tokens (
     token      text PRIMARY KEY,
     user_id    bigint NOT NULL REFERENCES ${PRAC.schema}.users(id) ON DELETE CASCADE,
     created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL
   )`,
];

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

  /* ================= v6：账号体系 =================
   * 两人共用一套练习台，各自的练习数据必须分开存 —— 否则 PK 就没有意义。
   * 密码用 scrypt 加盐哈希（不存明文），token 明文存库但只在登录时签发。
   * （DDL 见上方 ACCOUNT_TABLES，migrateV6 也要用）
   */
  ...ACCOUNT_TABLES,

  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.sessions (
     id           bigserial PRIMARY KEY,
     user_id      bigint REFERENCES ${PRAC.schema}.users(id) ON DELETE CASCADE,
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
     user_id       bigint REFERENCES ${PRAC.schema}.users(id) ON DELETE CASCADE,
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
     /* ---- v6：开仓设置扩展（见 TradeDraft 注释）---- */
     entry_mode    text NOT NULL DEFAULT 'market',   -- market=市价 / limit=限价挂单
     limit_price   numeric(24,10),
     stop_type     text NOT NULL DEFAULT 'price',    -- price / pct / atr
     stop_value    numeric(24,10),
     tp_type       text NOT NULL DEFAULT 'price',    -- price / ratio / none
     tp_value      numeric(24,10),
     size_mode     text NOT NULL DEFAULT 'risk',     -- risk=按风险% / notional=按名义金额
     size_value    numeric(24,10),
     fee_rate      numeric(12,8) NOT NULL DEFAULT 0,  -- 单边费率（小数，0.0004=4bp）
     slippage_bps  numeric(12,4) NOT NULL DEFAULT 0,
     time_stop_hrs integer,                          -- 时间止损（小时）
     confidence    integer,                          -- 信号置信度 1~5
     notes         text,
     created_at    timestamptz NOT NULL DEFAULT now(),
     updated_at    timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS ${PRAC.schema}.journal_entries (
     id            bigserial PRIMARY KEY,
     session_id    bigint REFERENCES ${PRAC.schema}.sessions(id) ON DELETE CASCADE,
     trade_id      bigint REFERENCES ${PRAC.schema}.trades(id) ON DELETE CASCADE,
     user_id       bigint REFERENCES ${PRAC.schema}.users(id) ON DELETE CASCADE,
     symbol        text,
     market        text NOT NULL DEFAULT 'perp',
     setup         text,
     followed_plan boolean,
     emotion       text,
     mistake_tag   text,
     content       text NOT NULL DEFAULT '',
     snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
     /* 跳过的复盘：关掉了弹窗但没写内容 —— 纪律统计里算「未复盘」 */
     skipped       boolean NOT NULL DEFAULT false,
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

/**
 * v6 迁移：账号维度 + 开仓设置扩展字段。
 *
 * 幂等：全部用 ADD COLUMN IF NOT EXISTS，重复执行安全。
 */
export async function migrateV6(exec) {
  // 前置：账号表必须先存在。
  // 下面给 sessions/trades/journal_entries 加的 user_id 列带
  // `REFERENCES users(id)` 外键 —— 引用的表不存在时 PG 直接报
  // `relation "users" does not exist`，整个迁移中断。
  // 老库（v1~v5）恰恰没有 users 表，所以这里自己建。
  for (const ddl of ACCOUNT_TABLES) await exec(ddl);

  // sessions / trades / journal_entries 是 v1 就有的表，老库必然在。
  // 但「全新库只跑了 db:migrate 没跑 db:init」时它们不存在 ——
  // 建表是 db:init 的职责，迁移只管补列，所以这里跳过不存在的表（而不是让整个迁移报错中断）。
  const probe = await exec(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = '${PRAC.schema}'
        AND table_name IN ('sessions','trades','journal_entries')`,
  );
  const exist = new Set((probe?.rows || []).map((r) => r.table_name));

  // 账号维度：练习记录按 user_id 隔离
  for (const t of ['sessions', 'trades', 'journal_entries']) {
    if (!exist.has(t)) continue;
    await exec(
      `ALTER TABLE ${PRAC.schema}.${t}
         ADD COLUMN IF NOT EXISTS user_id bigint REFERENCES ${PRAC.schema}.users(id) ON DELETE CASCADE`,
    );
  }

  // 开仓设置扩展字段
  const TRADE_COLS = [
    ['entry_mode', `text NOT NULL DEFAULT 'market'`],
    ['limit_price', `numeric(24,10)`],
    ['stop_type', `text NOT NULL DEFAULT 'price'`],
    ['stop_value', `numeric(24,10)`],
    ['tp_type', `text NOT NULL DEFAULT 'price'`],
    ['tp_value', `numeric(24,10)`],
    ['size_mode', `text NOT NULL DEFAULT 'risk'`],
    ['size_value', `numeric(24,10)`],
    ['fee_rate', `numeric(12,8) NOT NULL DEFAULT 0`],
    ['slippage_bps', `numeric(12,4) NOT NULL DEFAULT 0`],
    ['time_stop_hrs', `integer`],
    ['confidence', `integer`],
    ['notes', `text`],
  ];
  for (const [name, type] of TRADE_COLS) {
    if (!exist.has('trades')) break;
    await exec(
      `ALTER TABLE ${PRAC.schema}.trades ADD COLUMN IF NOT EXISTS ${name} ${type}`,
    );
  }

  // 跳过的复盘标记（关掉弹窗但没写内容）
  if (exist.has('journal_entries')) {
    await exec(
      `ALTER TABLE ${PRAC.schema}.journal_entries
         ADD COLUMN IF NOT EXISTS skipped boolean NOT NULL DEFAULT false`,
    );
  }

  console.log('[schema] v6 迁移完成（账号维度 + 开仓设置扩展字段）');
}
