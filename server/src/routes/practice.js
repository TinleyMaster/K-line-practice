import { Router } from 'express';
import { queryRows, queryOne } from '../db.js';
import { PRAC } from '../config.js';

export const practiceRouter = Router();

/**
 * 账号隔离。
 *
 * 规则：
 *   - **写入必带 user_id**（登录状态下）。
 *   - **读取按 user_id 过滤**：登录用户只看自己的；未登录看全部（保留单机使用习惯）。
 *
 * 为什么不是「强制登录」：本项目核心是单人练习台，
 * 两个人共用是后加的需求。强制登录会让「打开就能练」变复杂，
 * 而数据隔离在写入侧保证就够了 —— 两个人各自登录后互不干扰。
 *
 * ⚠️ offset 参数（踩过的坑）：
 *   user_id 的 SQL 占位符必须和它在 params 数组里的**真实位置**一致。
 *   之前这里固定写死 $1，而多数调用点的 params 是 [id, ...] —— 于是 SQL 变成
 *   `WHERE id = $1 AND user_id = $1`。pg 会把重复出现的 $1 展开成 $1,$2，
 *   于是报 "bind message supplies 2 parameters, but prepared statement requires 1"，
 *   越权防护（404）直接变成 500。
 *   现在显式传 offset，调用方声明「user_id 排在 params 的第几位」。
 *
 * @param req
 * @param alias  表别名（'' 表示无别名）
 * @param offset user_id 参数在 params 数组中的位置（1-based）。
 *                未登录时返回 '1=1' 且无参数，offset 不参与。
 */
function userFilter(req, alias = '', offset = 1) {
  const p = alias ? `${alias}.` : '';
  if (req.user) {
    return { sql: `${p}user_id = $${offset}`, params: [req.user.id] };
  }
  return { sql: '1=1', params: [] };
}

/* ===================== Sessions ===================== */

practiceRouter.get('/sessions', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const uf = userFilter(req, 's');
    const params = [...uf.params, limit];
    const rows = await queryRows(
      `SELECT s.*,
              (SELECT count(*)::int FROM ${PRAC.schema}.trades t WHERE t.session_id = s.id) AS trade_count,
              (SELECT count(*)::int FROM ${PRAC.schema}.trades t WHERE t.session_id = s.id AND t.status='closed') AS closed_count,
              (SELECT coalesce(sum(t.r_multiple),0) FROM ${PRAC.schema}.trades t WHERE t.session_id = s.id AND t.status='closed') AS total_r
         FROM ${PRAC.schema}.sessions s
        WHERE ${uf.sql}
        ORDER BY s.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json(rows.map(mapSession));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

practiceRouter.post('/sessions', async (req, res) => {
  try {
    const {
      symbol,
      market = 'perp',
      startTime,
      endTime = null,
      baseInterval = '1h',
      trendInterval = '4h',
      mode = 'replay',
      equityStart = 10000,
      meta = {},
    } = req.body || {};
    if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
    const row = await queryOne(
      `INSERT INTO ${PRAC.schema}.sessions
         (user_id, symbol, market, base_interval, trend_interval, mode, start_time, end_time, cursor_time, equity_start, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10::jsonb)
       RETURNING *`,
      [
        req.user?.id ?? null,
        String(symbol).toUpperCase(),
        normalizeMarket(market),
        baseInterval,
        trendInterval,
        mode,
        startTime ? new Date(startTime).toISOString() : null,
        endTime ? new Date(endTime).toISOString() : null,
        Number(equityStart) || 10000,
        JSON.stringify(meta),
      ],
    );
    res.status(201).json(mapSession(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

practiceRouter.patch('/sessions/:id', async (req, res) => {
  try {
    const { cursorTime, status, equityEnd, barsPlayed, meta } = req.body || {};
    // user_id 排在 params 第 7 位（$1=id, $2..$6=body 字段, $7=user_id）
    const uf = userFilter(req, '', 7);
    const params = [
      req.params.id,
      cursorTime ? new Date(cursorTime).toISOString() : null,
      status ?? null,
      equityEnd ?? null,
      barsPlayed ?? null,
      meta ? JSON.stringify(meta) : null,
      ...uf.params,
    ];
    const row = await queryOne(
      `UPDATE ${PRAC.schema}.sessions SET
         cursor_time = COALESCE($2::timestamptz, cursor_time),
         status     = COALESCE($3, status),
         equity_end = COALESCE($4::numeric, equity_end),
         bars_played= COALESCE($5::int, bars_played),
         meta       = COALESCE($6::jsonb, meta),
         updated_at = now()
       WHERE id = $1 AND ${uf.sql}
       RETURNING *`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'session 不存在' });
    res.json(mapSession(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

practiceRouter.get('/sessions/:id', async (req, res) => {
  try {
    // user_id 排在 params 第 2 位（$1=id, $2=user_id）
    const uf = userFilter(req, '', 2);
    const row = await queryOne(
      `SELECT * FROM ${PRAC.schema}.sessions WHERE id = $1 AND ${uf.sql}`,
      [req.params.id, ...uf.params],
    );
    if (!row) return res.status(404).json({ error: 'session 不存在' });
    const trades = await queryRows(
      `SELECT * FROM ${PRAC.schema}.trades WHERE session_id = $1 ORDER BY entry_time`,
      [req.params.id],
    );
    const journal = await queryRows(
      `SELECT * FROM ${PRAC.schema}.journal_entries WHERE session_id = $1 ORDER BY created_at`,
      [req.params.id],
    );
    res.json({
      ...mapSession(row),
      trades: trades.map(mapTrade),
      journal: journal.map(mapJournal),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===================== Trades ===================== */

practiceRouter.post('/trades', async (req, res) => {
  try {
    const {
      sessionId,
      symbol,
      market = 'perp',
      side,
      setup = null,
      entryTime,
      entryPrice,
      stopLoss = null,
      takeProfit = null,
      riskAmount = 0,
      qty = 0,
      checklist = {},
      // v6：开仓设置扩展
      entryMode = 'market',
      limitPrice = null,
      stopType = 'price',
      stopValue = null,
      tpType = 'price',
      tpValue = null,
      sizeMode = 'risk',
      sizeValue = null,
      feeRate = 0,
      slippageBps = 0,
      timeStopHrs = null,
      confidence = null,
      notes = null,
    } = req.body || {};
    if (!sessionId || !symbol || !side || !entryTime || !entryPrice) {
      return res.status(400).json({ error: '缺少必填字段: sessionId/symbol/side/entryTime/entryPrice' });
    }
    if (!['long', 'short'].includes(side)) return res.status(400).json({ error: 'side 必须是 long|short' });

    const row = await queryOne(
      `INSERT INTO ${PRAC.schema}.trades
         (session_id, user_id, symbol, market, side, setup, entry_time, entry_price,
          stop_loss, take_profit, risk_amount, qty, checklist,
          entry_mode, limit_price, stop_type, stop_value, tp_type, tp_value,
          size_mode, size_value, fee_rate, slippage_bps, time_stop_hrs, confidence, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12,$13::jsonb,
               $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       RETURNING *`,
      [
        sessionId,
        req.user?.id ?? null,
        String(symbol).toUpperCase(),
        normalizeMarket(market),
        side,
        setup,
        new Date(entryTime).toISOString(),
        entryPrice,
        stopLoss,
        takeProfit,
        riskAmount,
        qty,
        JSON.stringify(checklist ?? {}),
        entryMode,
        limitPrice,
        stopType,
        stopValue,
        tpType,
        tpValue,
        sizeMode,
        sizeValue,
        feeRate,
        slippageBps,
        timeStopHrs,
        confidence,
        notes,
      ],
    );
    res.status(201).json(mapTrade(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

practiceRouter.patch('/trades/:id', async (req, res) => {
  try {
    const { exitTime, exitPrice, exitReason, status = 'closed', rMultiple, pnl, checklist, notes } =
      req.body || {};
    // user_id 排在 params 第 10 位（$1=id, $2..$9=body 字段, $10=user_id）
    const uf = userFilter(req, '', 10);
    const params = [
      req.params.id,
      exitTime ? new Date(exitTime).toISOString() : null,
      exitPrice ?? null,
      exitReason ?? null,
      status ?? null,
      rMultiple ?? null,
      pnl ?? null,
      checklist ? JSON.stringify(checklist) : null,
      notes ?? null,
      ...uf.params,
    ];
    const row = await queryOne(
      `UPDATE ${PRAC.schema}.trades SET
         exit_time   = COALESCE($2::timestamptz, exit_time),
         exit_price  = COALESCE($3::numeric, exit_price),
         exit_reason = COALESCE($4, exit_reason),
         status      = COALESCE($5, status),
         r_multiple  = COALESCE($6::numeric, r_multiple),
         pnl         = COALESCE($7::numeric, pnl),
         checklist   = COALESCE($8::jsonb, checklist),
         notes       = COALESCE($9, notes),
         updated_at = now()
       WHERE id = $1 AND ${uf.sql}
       RETURNING *`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'trade 不存在' });
    res.json(mapTrade(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===================== Journal ===================== */

practiceRouter.get('/journal', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const uf = userFilter(req, 'j');
    const params = [...uf.params, limit];
    const rows = await queryRows(
      `SELECT j.* FROM ${PRAC.schema}.journal_entries j
        WHERE ${uf.sql}
        ORDER BY j.created_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json(rows.map(mapJournal));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

practiceRouter.post('/journal', async (req, res) => {
  try {
    const {
      sessionId = null,
      tradeId = null,
      symbol = null,
      market = 'perp',
      setup = null,
      followedPlan = null,
      emotion = null,
      mistakeTag = null,
      content = '',
      snapshot = {},
      skipped = false,
    } = req.body || {};
    // 跳过的复盘允许空内容（它只是标记「这笔没写复盘」）
    if (!content && !tradeId && !skipped) {
      return res.status(400).json({ error: '需要 content 或 tradeId' });
    }
    const row = await queryOne(
      `INSERT INTO ${PRAC.schema}.journal_entries
         (session_id, trade_id, user_id, symbol, market, setup, followed_plan, emotion, mistake_tag, content, snapshot, skipped)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       RETURNING *`,
      [
        sessionId,
        tradeId,
        req.user?.id ?? null,
        symbol,
        normalizeMarket(market),
        setup,
        followedPlan,
        emotion,
        mistakeTag,
        content,
        JSON.stringify(snapshot ?? {}),
        skipped,
      ],
    );
    res.status(201).json(mapJournal(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/journal/:id —— 补写之前跳过的复盘。
 * 强制复盘被关掉后，允许稍后补上（补上后 skipped=false）。
 */
practiceRouter.put('/journal/:id', async (req, res) => {
  try {
    const { followedPlan = null, emotion = null, mistakeTag = null, content = '', snapshot = null } =
      req.body || {};
    // user_id 排在 params 第 7 位（$1=id, $2..$6=body 字段, $7=user_id）
    const uf = userFilter(req, 'j', 7);
    const params = [
      req.params.id,
      followedPlan,
      emotion,
      mistakeTag,
      content,
      snapshot ? JSON.stringify(snapshot) : null,
      ...uf.params,
    ];
    const row = await queryOne(
      `UPDATE ${PRAC.schema}.journal_entries j SET
         followed_plan = COALESCE($2, followed_plan),
         emotion       = COALESCE($3, emotion),
         mistake_tag   = COALESCE($4, mistake_tag),
         content       = COALESCE(NULLIF($5, ''), content),
         snapshot      = COALESCE($6::jsonb, snapshot),
         skipped       = false
       WHERE j.id = $1 AND ${uf.sql}
       RETURNING j.*`,
      params,
    );
    if (!row) return res.status(404).json({ error: '复盘记录不存在' });
    res.json(mapJournal(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===================== helpers ===================== */

/** 市场维度归一化：只认 perp / spot / stock，其余一律 perp */
function normalizeMarket(raw) {
  const m = String(raw ?? 'perp').toLowerCase();
  return ['perp', 'spot', 'stock'].includes(m) ? m : 'perp';
}

/* ===================== mappers ===================== */

function mapSession(r) {
  return {
    id: r.id,
    userId: r.user_id ?? null,
    symbol: r.symbol,
    market: r.market ?? 'perp',
    baseInterval: r.base_interval,
    trendInterval: r.trend_interval,
    mode: r.mode,
    startTime: r.start_time,
    endTime: r.end_time,
    cursorTime: r.cursor_time,
    status: r.status,
    equityStart: Number(r.equity_start),
    equityEnd: r.equity_end === null ? null : Number(r.equity_end),
    barsPlayed: r.bars_played,
    meta: r.meta ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    tradeCount: r.trade_count,
    closedCount: r.closed_count,
    totalR: r.total_r === undefined ? undefined : Number(r.total_r),
  };
}

function mapTrade(r) {
  return {
    id: r.id,
    sessionId: r.session_id,
    userId: r.user_id ?? null,
    symbol: r.symbol,
    market: r.market ?? 'perp',
    side: r.side,
    setup: r.setup,
    entryTime: r.entry_time,
    entryPrice: Number(r.entry_price),
    exitTime: r.exit_time,
    exitPrice: r.exit_price === null ? null : Number(r.exit_price),
    stopLoss: r.stop_loss === null ? null : Number(r.stop_loss),
    takeProfit: r.take_profit === null ? null : Number(r.take_profit),
    riskAmount: Number(r.risk_amount),
    qty: Number(r.qty),
    rMultiple: r.r_multiple === null ? null : Number(r.r_multiple),
    pnl: r.pnl === null ? null : Number(r.pnl),
    status: r.status,
    exitReason: r.exit_reason,
    checklist: r.checklist ?? {},
    // v6 扩展字段
    entryMode: r.entry_mode ?? 'market',
    limitPrice: r.limit_price === null ? null : Number(r.limit_price),
    stopType: r.stop_type ?? 'price',
    stopValue: r.stop_value === null ? null : Number(r.stop_value),
    tpType: r.tp_type ?? 'price',
    tpValue: r.tp_value === null ? null : Number(r.tp_value),
    sizeMode: r.size_mode ?? 'risk',
    sizeValue: r.size_value === null ? null : Number(r.size_value),
    feeRate: Number(r.fee_rate ?? 0),
    slippageBps: Number(r.slippage_bps ?? 0),
    timeStopHrs: r.time_stop_hrs ?? null,
    confidence: r.confidence ?? null,
    notes: r.notes ?? null,
    createdAt: r.created_at,
  };
}

function mapJournal(r) {
  return {
    id: r.id,
    sessionId: r.session_id,
    tradeId: r.trade_id,
    userId: r.user_id ?? null,
    symbol: r.symbol,
    market: r.market ?? 'perp',
    setup: r.setup,
    followedPlan: r.followed_plan,
    emotion: r.emotion,
    mistakeTag: r.mistake_tag,
    content: r.content,
    snapshot: r.snapshot ?? {},
    skipped: r.skipped ?? false,
    createdAt: r.created_at,
  };
}
