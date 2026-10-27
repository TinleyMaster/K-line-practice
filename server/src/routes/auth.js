import { Router } from 'express';
import { register, login, logout, listUsers } from '../services/authService.js';
import { queryRows, queryOne } from '../db.js';
import { PRAC } from '../config.js';

export const authRouter = Router();

/**
 * 账号路由（v6）。
 *
 * 刻意做得极简：注册 / 登录 / 登出 / 当前用户 / 用户列表。
 * 两个人用，不需要邮箱验证、找回密码、角色权限。
 */

/** POST /api/auth/register { username, password, displayName? } */
authRouter.post('/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body || {};
    const out = await register({ username, password, displayName });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/auth/login { username, password } */
authRouter.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const out = await login({ username, password });
    res.json(out);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/** POST /api/auth/logout —— 作废当前 token */
authRouter.post('/logout', async (req, res) => {
  try {
    const ok = await logout(req.authToken);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/auth/me —— 当前登录用户（未登录返回 user=null，不报 401） */
authRouter.get('/me', (req, res) => {
  res.json({ user: req.user ?? null });
});

/** GET /api/auth/users —— 用户列表（PK 页面用） */
authRouter.get('/users', async (_req, res) => {
  try {
    res.json(await listUsers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/pk —— 胜率 PK 对比。
 *
 * 维度选择：刻意**不只比胜率**。
 * 胜率高但赔率差的打法（1:0.5 盈亏比）长期期望为负，光看胜率会误导。
 * 所以同时给：期望 R（最关键）、累计 R、盈亏比、最大回撤、守规则率、平均持仓。
 *
 * 每个维度算一个「领先方」，前端做对比条。
 */
authRouter.get('/pk', async (_req, res) => {
  try {
    const users = await listUsers();
    if (users.length === 0) {
      return res.json({ players: [], generatedAt: new Date().toISOString() });
    }

    /**
     * 统计聚合。
     *
     * 踩过的坑：最初写成
     *   LEFT JOIN trades t ON t.user_id = u.id
     *   LEFT JOIN journal_entries j ON j.user_id = u.id
     * 两个 LEFT JOIN 同时挂在一个 users 上 → 行数变成「交易数 × 复盘数」的笛卡尔积，
     * 于是 count(t.id) 和 sum(r_multiple) 都被成倍放大。
     * 症状很隐蔽：胜率看起来正常（分子分母同倍放大），但「累计R」「已平仓笔数」直接翻倍。
     *
     * 正解：先各自按 user_id 聚合，再做一次 JOIN —— 每个子表每个用户只出一行。
     */
    const rows = await queryRows(
      `SELECT u.id, u.username, u.display_name,
              coalesce(t.closed, 0)::int      AS closed,
              coalesce(t.wins, 0)::int        AS wins,
              coalesce(t.losses, 0)::int      AS losses,
              coalesce(t.total_r, 0)          AS total_r,
              coalesce(t.avg_r, 0)            AS avg_r,
              coalesce(t.gross_profit, 0)     AS gross_profit,
              coalesce(t.gross_loss, 0)       AS gross_loss,
              coalesce(t.avg_hold, 0)         AS avg_hold,
              coalesce(j.journaled, 0)::int   AS journaled,
              coalesce(j.followed, 0)::int    AS followed,
              coalesce(j.violated, 0)::int    AS violated,
              coalesce(j.skipped, 0)::int     AS skipped
         FROM ${PRAC.schema}.users u
         LEFT JOIN (
           SELECT user_id,
                  count(*) FILTER (WHERE status = 'closed')::int AS closed,
                  count(*) FILTER (WHERE status = 'closed' AND r_multiple > 0)::int AS wins,
                  count(*) FILTER (WHERE status = 'closed' AND r_multiple <= 0)::int AS losses,
                  coalesce(sum(r_multiple) FILTER (WHERE status = 'closed'), 0) AS total_r,
                  coalesce(avg(r_multiple) FILTER (WHERE status = 'closed'), 0) AS avg_r,
                  coalesce(sum(pnl) FILTER (WHERE status = 'closed' AND pnl > 0), 0) AS gross_profit,
                  coalesce(-sum(pnl) FILTER (WHERE status = 'closed' AND pnl < 0), 0) AS gross_loss,
                  coalesce(avg(extract(epoch FROM (exit_time::timestamptz - entry_time))) FILTER (WHERE status = 'closed'), 0) AS avg_hold
             FROM ${PRAC.schema}.trades
            WHERE user_id IS NOT NULL
            GROUP BY user_id
         ) t ON t.user_id = u.id
         LEFT JOIN (
           SELECT user_id,
                  count(*)::int AS journaled,
                  count(*) FILTER (WHERE followed_plan IS TRUE)::int AS followed,
                  count(*) FILTER (WHERE followed_plan IS FALSE)::int AS violated,
                  count(*) FILTER (WHERE skipped)::int AS skipped
             FROM ${PRAC.schema}.journal_entries
            WHERE user_id IS NOT NULL
            GROUP BY user_id
         ) j ON j.user_id = u.id
        ORDER BY u.id`,
    );

    // 权益曲线 → 最大回撤（按用户分开算）
    const curveRows = await queryRows(
      `SELECT t.user_id, t.exit_time, t.pnl
         FROM ${PRAC.schema}.trades t
        WHERE t.status = 'closed' AND t.user_id IS NOT NULL
        ORDER BY t.user_id, t.exit_time ASC`,
    );
    const byUser = new Map();
    for (const r of curveRows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push(Number(r.pnl ?? 0));
    }
    const maxDd = (userId) => {
      const pnl = byUser.get(userId) ?? [];
      let equity = 10000;
      let peak = equity;
      let dd = 0;
      for (const p of pnl) {
        equity += p;
        if (equity > peak) peak = equity;
        const d = peak > 0 ? (peak - equity) / peak : 0;
        if (d > dd) dd = d;
      }
      return dd;
    };

    const players = rows.map((r) => {
      const closed = Number(r.closed ?? 0);
      const wins = Number(r.wins ?? 0);
      const grossProfit = Number(r.gross_profit ?? 0);
      const grossLoss = Number(r.gross_loss ?? 0);
      const journaled = Number(r.journaled ?? 0);
      const followed = Number(r.followed ?? 0);
      return {
        userId: r.id,
        username: r.username,
        displayName: r.display_name || r.username,
        closed,
        wins,
        losses: Number(r.losses ?? 0),
        winRate: closed ? wins / closed : 0,
        totalR: Number(r.total_r ?? 0),
        avgR: Number(r.avg_r ?? 0),
        expectancy: closed ? Number(r.total_r ?? 0) / closed : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
        maxDrawdown: maxDd(r.id),
        avgHoldHours: Number(r.avg_hold ?? 0) / 3600,
        journaled,
        followed,
        violated: Number(r.violated ?? 0),
        skipped: Number(r.skipped ?? 0),
        adherenceRate: journaled ? followed / journaled : null,
      };
    });

    // 维度定义：key / 标签 / 取值方向（越大越好还是越小越好）
    const DIMENSIONS = [
      { key: 'winRate', label: '胜率', better: 'high', fmt: (v) => `${(v * 100).toFixed(1)}%` },
      { key: 'expectancy', label: '单笔期望', better: 'high', fmt: (v) => `${v.toFixed(3)}R` },
      { key: 'totalR', label: '累计R', better: 'high', fmt: (v) => `${v.toFixed(2)}R` },
      { key: 'avgR', label: '平均R', better: 'high', fmt: (v) => `${v.toFixed(3)}R` },
      { key: 'profitFactor', label: '盈亏比', better: 'high', fmt: (v) => (v === null ? '—' : v.toFixed(2)) },
      { key: 'maxDrawdown', label: '最大回撤', better: 'low', fmt: (v) => `${(v * 100).toFixed(1)}%` },
      { key: 'adherenceRate', label: '守规则率', better: 'high', fmt: (v) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`) },
      { key: 'closed', label: '已平仓笔数', better: 'high', fmt: (v) => String(v) },
      { key: 'avgHoldHours', label: '平均持仓(h)', better: 'none', fmt: (v) => v.toFixed(1) },
    ];

    const comparisons = DIMENSIONS.map((d) => {
      const vals = players.map((p) => p[d.key]);
      const nums = vals.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
      let leader = null;
      if (d.better !== 'none' && nums.length >= 2) {
        const best = d.better === 'high' ? Math.max(...nums) : Math.min(...nums);
        // 并列时 leader = null（前端显示「平」）
        const winners = players.filter((p) => {
          const v = p[d.key];
          return v !== null && v !== undefined && Number.isFinite(v) && Math.abs(v - best) < 1e-9;
        });
        leader = winners.length === 1 ? winners[0].userId : null;
      }
      return {
        key: d.key,
        label: d.label,
        better: d.better,
        leader,
        values: players.map((p) => ({
          userId: p.userId,
          value: p[d.key],
          display: d.fmt(p[d.key]),
        })),
      };
    });

    res.json({ players, comparisons, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/auth/pending-journal —— 各账号待补复盘数 */
authRouter.get('/pending-journal', async (_req, res) => {
  try {
    const row = await queryOne(
      `SELECT count(*)::int AS n FROM ${PRAC.schema}.journal_entries WHERE skipped = true`,
    );
    res.json({ pending: Number(row?.n ?? 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
