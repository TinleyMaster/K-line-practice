import { Router } from 'express';
import {
  fetch1h,
  derive4h,
  coverage,
  ensureMaterialized,
  get1h,
  getCacheStats,
  clearBarCache,
  backfillExternal,
  MARKETS,
} from '../services/klineService.js';

export const klinesRouter = Router();

const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 1200;

/** 校验市场维度 */
function parseMarket(raw) {
  const m = String(raw || 'perp').toLowerCase();
  if (!MARKETS[m]) return null;
  return m;
}

/**
 * GET /api/klines?symbol=BTCUSDT&market=perp|spot|stock&interval=1h|4h|both&limit=1200
 * 1h 来自本地物化缓存表（服务端内存二次缓存），4h 由 1h 派生，保证两个周期严格对齐。
 */
klinesRouter.get('/', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const market = parseMarket(req.query.market);
    const interval = String(req.query.interval || 'both').toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 50), MAX_LIMIT);

    if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
    if (!market) {
      return res.status(400).json({ error: `market 非法，可选：${Object.keys(MARKETS).join(' / ')}` });
    }
    // perp/spot 为全大写交易所符号；stock 为 Alpha 代币符号（统一大写规范）
    if (market === 'stock') {
      if (!/^[A-Z0-9]{2,24}$/.test(symbol)) {
        return res.status(400).json({ error: 'symbol 格式非法' });
      }
    } else if (!/^[A-Z0-9]{4,20}$/.test(symbol)) {
      return res.status(400).json({ error: 'symbol 格式非法' });
    }

    const bars1h = await get1h(symbol, { limit, market });
    if (bars1h.length === 0) {
      return res.status(404).json({
        error: `无 ${symbol} 的 1h 数据（market=${market}），可先执行回填`,
      });
    }
    const bars4h = derive4h(bars1h);

    const payload = {
      symbol,
      market,
      marketLabel: MARKETS[market].label,
      baseInterval: '1h',
      trendInterval: '4h',
      count1h: bars1h.length,
      count4h: bars4h.length,
      firstTime: bars1h[0].time,
      lastTime: bars1h[bars1h.length - 1].time,
    };

    if (interval === '1h') payload.bars = bars1h;
    else if (interval === '4h') payload.bars = bars4h;
    else {
      payload.bars1h = bars1h;
      payload.bars4h = bars4h;
    }

    res.set('Cache-Control', 'private, max-age=60');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/klines/backfill  { market: 'spot'|'stock', symbol: 'xxx', days?: number }
 * 从外部源回填并落库（现货走币安现货 API，链上美股走链上 OHLCV）。
 */
klinesRouter.post('/backfill', async (req, res) => {
  try {
    const { market, symbol, days = 365 } = req.body || {};
    const m = parseMarket(market);
    if (!m) return res.status(400).json({ error: `market 非法，可选：${Object.keys(MARKETS).join(' / ')}` });
    if (m === 'perp') {
      const n = await ensureMaterialized(String(symbol || '').trim(), { market: 'perp', force: true });
      return res.json({ ok: true, market: m, symbol, ...n });
    }
    const out = await backfillExternal({ market: m, symbol: String(symbol || '').trim(), days: Number(days) || 365 });
    clearBarCache(m, String(symbol).trim());
    res.json({ ok: true, market: m, symbol, ...out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/klines/:symbol/coverage —— 覆盖情况自查 */
klinesRouter.get('/:symbol/coverage', async (req, res) => {
  try {
    const symbol = String(req.params.symbol).trim();
    const market = parseMarket(req.query.market) ?? 'perp';
    const cov = await coverage(symbol, market);
    res.json({ symbol, market, ...cov });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/klines-cache —— 服务端内存缓存状态 */
klinesRouter.get('/_cache/stats', (req, res) => {
  res.json(getCacheStats());
});

/** DELETE /api/klines-cache/:symbol —— 手动清缓存 */
klinesRouter.delete('/_cache/:symbol', (req, res) => {
  clearBarCache(parseMarket(req.query.market), req.params.symbol);
  res.json({ ok: true, cleared: req.params.symbol });
});

export { ensureMaterialized, fetch1h };
