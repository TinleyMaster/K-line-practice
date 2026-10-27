import { Router } from 'express';
import { queryRows, queryOne, query } from '../db.js';
import { PRAC } from '../config.js';
import { MARKETS } from '../services/klineService.js';
import { fetchRwaTokens } from '../services/sources/alpha.js';

export const symbolsRouter = Router();

/** 市场元信息（前端用来渲染市场切换 Tab） */
symbolsRouter.get('/markets', (req, res) => {
  res.json(
    Object.entries(MARKETS).map(([key, v]) => ({
      market: key,
      label: v.label,
      category: v.category,
      source: v.source,
    })),
  );
});

/** 练习标的列表（practice.symbols 白名单 + 本地物化覆盖度缓存） */
symbolsRouter.get('/', async (req, res) => {
  try {
    const market = String(req.query.market || '').toLowerCase();
    const params = [];
    let where = '';
    if (market && MARKETS[market]) {
      params.push(market);
      where = 'WHERE s.market = $1';
    }

    const rows = await queryRows(
      `SELECT s.symbol, s.market, s.base, s.quote, s.category, s.enabled, s.sort_rank, s.note,
              s.external_ref, c.bars, c.first_time, c.last_time
         FROM ${PRAC.schema}.symbols s
         LEFT JOIN ${PRAC.schema}.symbol_coverage c
                ON c.market = s.market AND c.symbol = s.symbol AND c.interval = '1h'
         ${where}
        ORDER BY s.market, s.sort_rank NULLS LAST, s.symbol`,
      params,
    );
    res.json(
      rows.map((r) => ({
        symbol: r.symbol,
        market: r.market,
        marketLabel: MARKETS[r.market]?.label ?? r.market,
        base: r.base,
        quote: r.quote,
        category: r.category,
        enabled: r.enabled,
        sortRank: r.sort_rank,
        note: r.note,
        bars: r.bars ?? 0,
        firstTime: r.first_time,
        lastTime: r.last_time,
        // 链上美股的数据健康度（真实成交比例等），由 backfill 审计写入 external_ref
        dataHealth: r.external_ref?.dataHealth ?? null,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/symbols/sync-stock —— 从 Binance Alpha 同步链上美股（RWA 代币）清单。
 * body: { limit?: number }  限制同步数量（按市值排序）
 */
symbolsRouter.post('/sync-stock', async (req, res) => {
  try {
    const limit = Math.min(Number(req.body?.limit) || 40, 200);
    const tokens = await fetchRwaTokens();

    // 按市值降序取前 N
    const picked = tokens
      .filter((t) => t.marketCap > 0)
      .sort((a, b) => b.marketCap - a.marketCap)
      .slice(0, limit);

    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < picked.length; i++) {
      const t = picked[i];
      const sym = String(t.symbol).toUpperCase();
      const base = deriveBase(sym);
      const ref = {
        network: t.network,
        chain: t.chain,
        contractAddress: t.contractAddress,
        upstreamSymbol: t.symbol,
        underlyingName: t.name,
        marketCap: t.marketCap,
        volume24h: t.volume24h,
      };
      const r = await query(
        `INSERT INTO ${PRAC.schema}.symbols
           (market, symbol, base, quote, category, enabled, sort_rank, source_symbol, external_ref, note)
         VALUES ('stock', $1, $2, 'USD', 'onchain_stock', true, $3, $4, $5::jsonb, $6)
         ON CONFLICT (market, symbol) DO UPDATE
            SET external_ref = EXCLUDED.external_ref,
                note = EXCLUDED.note
         RETURNING (xmax = 0) AS is_insert`,
        [sym, base, i + 1, t.contractAddress, JSON.stringify(ref), t.name],
      );
      if (r.rows?.[0]?.is_insert) inserted += 1;
      else updated += 1;
    }

    res.json({
      ok: true,
      totalRwa: tokens.length,
      picked: picked.length,
      inserted,
      updated,
      symbols: picked.map((t) => ({
        symbol: String(t.symbol).toUpperCase(),
        name: t.name,
        network: t.network,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 从链上代币符号推导标的代码：AAPLON → AAPL、TSLAON → TSLA。
 * 注意：Ondo 的代币后缀是 'on'，但 'COINON' 这类需要去掉末尾 ON 才能还原真实 ticker。
 */
export function deriveBase(sym) {
  const s = String(sym).toUpperCase();
  if (s.endsWith('ON') && s.length > 3) return s.slice(0, -2);
  return s;
}

/** 开启/关闭一个标的 */
symbolsRouter.patch('/:symbol', async (req, res) => {
  try {
    const { enabled, sortRank, note, market = 'perp' } = req.body || {};
    const row = await queryOne(
      `UPDATE ${PRAC.schema}.symbols
          SET enabled = COALESCE($3, enabled),
              sort_rank = COALESCE($4, sort_rank),
              note = COALESCE($5, note)
        WHERE market = $1 AND symbol = $2
        RETURNING symbol, market, base, quote, category, enabled, sort_rank, note`,
      [market, req.params.symbol, enabled ?? null, sortRank ?? null, note ?? null],
    );
    if (!row) return res.status(404).json({ error: 'symbol 不在白名单中' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
