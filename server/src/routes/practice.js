import { Router } from 'express';
import { queryRows, queryOne } from '../db.js';
import { PRAC } from '../config.js';

export const practiceRouter = Router();

/* ===================== Sessions ===================== */

practiceRouter.get('/sessions', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await queryRows(
      `SELECT s.*,
              (SELECT count(*)::int FROM ${PRAC.schema}.trades t WHERE t.session_id = s.id) AS trade_count,
              (SELECT count(*)::int FROM ${PRAC.schema}.trades t WHERE t.session_id = s.id AND t.status='closed') AS closed_count,
              (SELECT coalesce(sum(t.r_multiple),0) FROM ${PRAC.schema}.trades t WHERE t.session_id = s.id AND t.status='closed') AS total_r
         FROM ${PRAC.schema}.sessions s
        ORDER BY s.created_at DESC
        LIMIT $1`,
      [limit],
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
         (symbol, market, base_interval, trend_interval, mode, start_time, end_time, cursor_time, equity_start, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9::jsonb)
       RETURNING *`,
      [
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
    const row = await queryOne(
      `UPDATE ${PRAC.schema}.sessions SET
         cursor_time = COALESCE($2::timestamptz, cursor_time),
         status     = COALESCE($3, status),
         equity_end = COALESCE($4::numeric, equity_end),
         bars_played= COALESCE($5::int, bars_played),
         meta       = COALESCE($6::jsonb, meta),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        cursorTime ? new Date(cursorTime).toISOString() : null,
        status ?? null,
        equityEnd ?? null,
        barsPlayed ?? null,
        meta ? JSON.stringify(meta) : null,
      ],
    );
    if (!row) return res.status(404).json({ error: 'session 不存在' });
    res.json(mapSession(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

practiceRouter.get('/sessions/:id', async (req, res) => {
  try {
    const row = await queryOne(`SELECT * FROM ${PRAC.schema}.sessions WHERE id = $1`, [req.params.id]);
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
    } = req.body || {};
    if (!sessionId || !symbol || !side || !entryTime || !entryPrice) {
      return res.status(400).json({ error: '缺少必填字段: sessionId/symbol/side/entryTime/entryPrice' });
    }
    if (!['long', 'short'].includes(side)) return res.status(400).json({ error: 'side 必须是 long|short' });

    const row = await queryOne(
      `INSERT INTO ${PRAC.schema}.trades
         (session_id, symbol, market, side, setup, entry_time, entry_price, stop_loss, take_profit, risk_amount, qty, checklist)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10,$11,$12::jsonb)
       RETURNING *`,
      [
        sessionId,
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
      ],
    );
    res.status(201).json(mapTrade(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

practiceRouter.patch('/trades/:id', async (req, res) => {
  try {
    const { exitTime, exitPrice, exitReason, status = 'closed', rMultiple, pnl, checklist } = req.body || {};
    const row = await queryOne(
      `UPDATE ${PRAC.schema}.trades SET
         exit_time   = COALESCE($2::timestamptz, exit_time),
         exit_price  = COALESCE($3::numeric, exit_price),
         exit_reason = COALESCE($4, exit_reason),
         status      = COALESCE($5, status),
         r_multiple  = COALESCE($6::numeric, r_multiple),
         pnl         = COALESCE($7::numeric, pnl),
         checklist   = COALESCE($8::jsonb, checklist),
         updated_at  = now()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        exitTime ? new Date(exitTime).toISOString() : null,
        exitPrice ?? null,
        exitReason ?? null,
        status ?? null,
        rMultiple ?? null,
        pnl ?? null,
        checklist ? JSON.stringify(checklist) : null,
      ],
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
    const rows = await queryRows(
      `SELECT * FROM ${PRAC.schema}.journal_entries ORDER BY created_at DESC LIMIT $1`,
      [limit],
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
    } = req.body || {};
    if (!content && !tradeId) return res.status(400).json({ error: '需要 content 或 tradeId' });
    const row = await queryOne(
      `INSERT INTO ${PRAC.schema}.journal_entries
         (session_id, trade_id, symbol, market, setup, followed_plan, emotion, mistake_tag, content, snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING *`,
      [
        sessionId,
        tradeId,
        symbol,
        normalizeMarket(market),
        setup,
        followedPlan,
        emotion,
        mistakeTag,
        content,
        JSON.stringify(snapshot ?? {}),
      ],
    );
    res.status(201).json(mapJournal(row));
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
    createdAt: r.created_at,
  };
}

function mapJournal(r) {
  return {
    id: r.id,
    sessionId: r.session_id,
    tradeId: r.trade_id,
    symbol: r.symbol,
    market: r.market ?? 'perp',
    setup: r.setup,
    followedPlan: r.followed_plan,
    emotion: r.emotion,
    mistakeTag: r.mistake_tag,
    content: r.content,
    snapshot: r.snapshot ?? {},
    createdAt: r.created_at,
  };
}
