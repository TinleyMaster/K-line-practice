import { Router } from 'express';
import { queryRows, queryOne } from '../db.js';
import { PRAC } from '../config.js';

export const statsRouter = Router();

/**
 * GET /api/stats?symbol=&setup=&market=
 * 过程指标优先：守规则率 > R 倍数分布 > 胜率。
 * 刻意练习关心「我有没有按系统做」，而不是「今天赚没赚钱」。
 */
statsRouter.get('/', async (req, res) => {
  try {
    const filters = [];
    const params = [];
    if (req.query.symbol) {
      params.push(String(req.query.symbol).toUpperCase());
      filters.push(`t.symbol = $${params.length}`);
    }
    if (req.query.setup) {
      params.push(String(req.query.setup));
      filters.push(`t.setup = $${params.length}`);
    }
    if (req.query.market) {
      params.push(String(req.query.market).toLowerCase());
      filters.push(`t.market = $${params.length}`);
    }
    // v6：登录后只统计自己的数据（未登录看全部）
    if (req.user) {
      params.push(req.user.id);
      filters.push(`t.user_id = $${params.length}`);
    }
    const where = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const overall = await queryOne(
      `SELECT count(*)::int AS trades,
              count(*) FILTER (WHERE t.status='closed')::int AS closed,
              count(*) FILTER (WHERE t.status='closed' AND t.r_multiple > 0)::int AS wins,
              count(*) FILTER (WHERE t.status='closed' AND t.r_multiple <= 0)::int AS losses,
              coalesce(sum(t.r_multiple),0) AS total_r,
              coalesce(avg(t.r_multiple),0) AS avg_r,
              coalesce(sum(t.pnl) FILTER (WHERE t.pnl > 0),0) AS gross_profit,
              coalesce(-sum(t.pnl) FILTER (WHERE t.pnl < 0),0) AS gross_loss,
              coalesce(avg(extract(epoch from (t.exit_time::timestamptz - t.entry_time))), 0) AS avg_hold
         FROM ${PRAC.schema}.trades t
        WHERE t.status = 'closed' ${where}`,
      params,
    );

    const bySetup = await queryRows(
      `SELECT coalesce(t.setup,'(未标注)') AS setup,
              count(*)::int AS trades,
              count(*) FILTER (WHERE t.r_multiple > 0)::int AS wins,
              coalesce(sum(t.r_multiple),0) AS total_r,
              coalesce(avg(t.r_multiple),0) AS avg_r,
              coalesce(avg(extract(epoch from (t.exit_time::timestamptz - t.entry_time))), 0) AS avg_hold
         FROM ${PRAC.schema}.trades t
        WHERE t.status = 'closed' ${where}
        GROUP BY coalesce(t.setup,'(未标注)')
        ORDER BY total_r DESC`,
      params,
    );

    const bySymbol = await queryRows(
      `SELECT t.symbol, t.market,
              count(*)::int AS trades,
              count(*) FILTER (WHERE t.r_multiple > 0)::int AS wins,
              coalesce(sum(t.r_multiple),0) AS total_r,
              coalesce(avg(t.r_multiple),0) AS avg_r
         FROM ${PRAC.schema}.trades t
        WHERE t.status = 'closed' ${where}
        GROUP BY t.market, t.symbol
        ORDER BY total_r DESC
        LIMIT 50`,
      params,
    );

    const byExit = await queryRows(
      `SELECT coalesce(t.exit_reason,'(未知)') AS exit_reason,
              count(*)::int AS trades,
              coalesce(avg(t.r_multiple),0) AS avg_r
         FROM ${PRAC.schema}.trades t
        WHERE t.status = 'closed' ${where}
        GROUP BY coalesce(t.exit_reason,'(未知)')
        ORDER BY trades DESC`,
      params,
    );

    // R 分布
    const dist = await queryRows(
      `SELECT CASE
                WHEN t.r_multiple <= -1 THEN '<=-1R'
                WHEN t.r_multiple <= -0.5 THEN '-1R~-0.5R'
                WHEN t.r_multiple < 0 THEN '-0.5R~0R'
                WHEN t.r_multiple = 0 THEN '0R'
                WHEN t.r_multiple < 1 THEN '0~1R'
                WHEN t.r_multiple < 2 THEN '1~2R'
                WHEN t.r_multiple < 3 THEN '2~3R'
                ELSE '>=3R' END AS bucket,
              count(*)::int AS n
         FROM ${PRAC.schema}.trades t
        WHERE t.status = 'closed' ${where}
        GROUP BY 1`,
      params,
    );

    // 守规则率（复盘里标记 followed_plan 的比例）
    // 过滤条件与主查询保持一致，但用 j. 表别名、独立参数
    const jFilters = [];
    const jParams = [];
    if (req.query.symbol) {
      jParams.push(String(req.query.symbol).toUpperCase());
      jFilters.push(`j.symbol = $${jParams.length}`);
    }
    if (req.query.market) {
      jParams.push(String(req.query.market).toLowerCase());
      jFilters.push(`j.market = $${jParams.length}`);
    }
    if (req.user) {
      jParams.push(req.user.id);
      jFilters.push(`j.user_id = $${jParams.length}`);
    }
    const discipline = await queryOne(
      `SELECT count(*)::int AS journaled,
              count(*) FILTER (WHERE followed_plan IS TRUE)::int AS followed,
              count(*) FILTER (WHERE followed_plan IS FALSE)::int AS violated,
              count(*) FILTER (WHERE j.skipped)::int AS skipped
         FROM ${PRAC.schema}.journal_entries j
        WHERE 1=1 ${jFilters.length ? `AND ${jFilters.join(' AND ')}` : ''}`,
      jParams,
    );

    // 权益曲线（按平仓时间序）→ 最大回撤
    const curve = await queryRows(
      `SELECT t.exit_time, t.pnl, t.r_multiple, t.symbol, t.market, t.setup
         FROM ${PRAC.schema}.trades t
        WHERE t.status='closed' ${where}
        ORDER BY t.exit_time ASC`,
      params,
    );

    const grossProfit = Number(overall?.gross_profit ?? 0);
    const grossLoss = Number(overall?.gross_loss ?? 0);
    const closed = Number(overall?.closed ?? 0);
    const wins = Number(overall?.wins ?? 0);

    let equity = 10000;
    let peak = equity;
    let maxDd = 0;
    for (const c of curve) {
      equity += Number(c.pnl ?? 0);
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDd) maxDd = dd;
    }

    res.json({
      overall: {
        trades: Number(overall?.trades ?? 0),
        closed,
        wins,
        losses: Number(overall?.losses ?? 0),
        winRate: closed ? wins / closed : 0,
        totalR: Number(overall?.total_r ?? 0),
        avgR: Number(overall?.avg_r ?? 0),
        expectancy: closed ? Number(overall?.total_r ?? 0) / closed : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
        maxDrawdown: maxDd,
        avgHoldHours: Number(overall?.avg_hold ?? 0) / 3600,
      },
      bySetup: bySetup.map((r) => ({
        setup: r.setup,
        trades: r.trades,
        wins: r.wins,
        winRate: r.trades ? r.wins / r.trades : 0,
        totalR: Number(r.total_r),
        avgR: Number(r.avg_r),
        avgHoldHours: Number(r.avg_hold ?? 0) / 3600,
      })),
      bySymbol: bySymbol.map((r) => ({
        symbol: r.symbol,
        market: r.market ?? 'perp',
        trades: r.trades,
        wins: r.wins,
        winRate: r.trades ? r.wins / r.trades : 0,
        totalR: Number(r.total_r),
        avgR: Number(r.avg_r),
      })),
      byExitReason: byExit.map((r) => ({
        exitReason: r.exit_reason,
        trades: r.trades,
        avgR: Number(r.avg_r),
      })),
      rDistribution: dist.map((r) => ({ bucket: r.bucket, n: r.n })),
      discipline: {
        journaled: Number(discipline?.journaled ?? 0),
        followed: Number(discipline?.followed ?? 0),
        violated: Number(discipline?.violated ?? 0),
        skipped: Number(discipline?.skipped ?? 0),
        adherenceRate: Number(discipline?.journaled ?? 0)
          ? Number(discipline?.followed ?? 0) / Number(discipline?.journaled ?? 0)
          : null,
      },
      equityCurve: curve.map((c) => ({
        time: c.exit_time,
        pnl: Number(c.pnl ?? 0),
        r: Number(c.r_multiple ?? 0),
        symbol: c.symbol,
        market: c.market ?? 'perp',
        setup: c.setup,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
