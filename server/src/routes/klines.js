import { Router } from 'express';
import {
  fetchBars,
  derive4h,
  coverage,
  ensureMaterialized,
  getBars,
  get1h,
  getHistoryBefore,
  getCacheStats,
  clearBarCache,
  backfillExternal,
  MARKETS,
  INTERVAL_SECONDS,
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
 * GET /api/klines?symbol=BTCUSDT&market=perp|spot|stock&interval=1h|4h|15m|both|all&limit=1200
 *
 * v6 起支持 15m：
 *   - 15m 是**独立存储的真实周期**（不是从 1h 派生的）——
 *     派生会丢掉 1h 桶内的真实路径，而练习入场恰恰看的就是这段路径。
 *   - 15m 只对 BTC/ETH 有数据（数据量是 1h 的 4 倍），其他标的返回空数组 + 明确提示。
 *   - 4h 仍由 1h 派生（保持与 v1~v5 一致的对齐语义）。
 */
klinesRouter.get('/', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const market = parseMarket(req.query.market);
    const interval = String(req.query.interval || 'both').toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 50), MAX_LIMIT);
    // 15m 需要更多根数才能覆盖同样的时间跨度（1 根 15m = 1/4 根 1h）
    const limit15 = Math.min(Math.max(Number(req.query.limit15) || limit * 4, 200), MAX_LIMIT);

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

    const bars1h = await getBars(symbol, { limit, market, interval: '1h' });
    if (bars1h.length === 0) {
      return res.status(404).json({
        error: `无 ${symbol} 的 1h 数据（market=${market}），可先执行回填`,
      });
    }
    const bars4h = derive4h(bars1h);

    // 15m：只有核心标的有。没有就返回空数组 + 说明，不报错（前端要能优雅降级）
    // wants15 的判定：除了显式要「只要 1h / 只要 4h」，其余（both / all / 15m）都要带上 15m。
    // 踩过的坑：前端固定用 interval=both，如果 both 不带 15m，前端永远拿不到 15m 数据。
    let bars15m = [];
    let note15m = null;
    const wants15 = interval !== '1h' && interval !== '4h';
    if (wants15) {
      try {
        bars15m = await getBars(symbol, { limit: limit15, market, interval: '15m' });
        if (bars15m.length === 0) {
          note15m = `${symbol} 暂无 15m 数据（当前仅 BTC/ETH 覆盖 15m），可切回 1h/4h`;
        }
      } catch (err) {
        note15m = `15m 数据读取失败：${err.message}`;
      }
    }

    const payload = {
      symbol,
      market,
      marketLabel: MARKETS[market].label,
      baseInterval: '1h',
      trendInterval: '4h',
      count1h: bars1h.length,
      count4h: bars4h.length,
      count15m: bars15m.length,
      note15m,
      firstTime: bars1h[0].time,
      lastTime: bars1h[bars1h.length - 1].time,
    };

    if (interval === '1h') payload.bars = bars1h;
    else if (interval === '4h') payload.bars = bars4h;
    else if (interval === '15m') payload.bars = bars15m;
    else {
      payload.bars1h = bars1h;
      payload.bars4h = bars4h;
      if (wants15) payload.bars15m = bars15m;
    }

    res.set('Cache-Control', 'private, max-age=60');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/klines/backfill
 *   { market: 'spot'|'stock', symbol: 'xxx', days?: number, interval?: '1h'|'15m' }
 * 从外部源回填并落库（现货走币安现货 API，链上美股走链上 OHLCV）。
 */
klinesRouter.post('/backfill', async (req, res) => {
  try {
    const { market, symbol, days = 365, interval = '1h' } = req.body || {};
    const m = parseMarket(market);
    if (!m) return res.status(400).json({ error: `market 非法，可选：${Object.keys(MARKETS).join(' / ')}` });
    if (!INTERVAL_SECONDS[interval]) {
      return res.status(400).json({ error: `interval 非法，可选：${Object.keys(INTERVAL_SECONDS).join(' / ')}` });
    }
    if (m === 'perp') {
      const n = await ensureMaterialized(String(symbol || '').trim(), {
        market: 'perp',
        interval,
        force: true,
      });
      clearBarCache('perp', String(symbol).trim());
      return res.json({ ok: true, market: m, symbol, interval, ...n });
    }
    const out = await backfillExternal({
      market: m,
      symbol: String(symbol || '').trim(),
      days: Number(days) || 365,
      interval,
    });
    clearBarCache(m, String(symbol).trim());
    res.json({ ok: true, market: m, symbol, ...out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/klines/:symbol/history?market=perp&interval=1h|15m&before=<epochMs>&limit=500
 *
 * 向左无限加载历史 K 线（练习起始时间之前的上下文）。
 * 返回 open_time < before 的最近 limit 根，按时间升序，并带 exhausted 标记。
 * 与根路径 / 的「最近 N 根」不同：这里按 before 时间窗取，用于滚动到左边缘时增量补齐。
 */
klinesRouter.get('/:symbol/history', async (req, res) => {
  try {
    const symbol = String(req.params.symbol).trim();
    const market = parseMarket(req.query.market);
    const interval = String(req.query.interval || '1h').toLowerCase();
    const before = Number(req.query.before);
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), MAX_LIMIT);

    if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
    if (!market) {
      return res.status(400).json({ error: `market 非法，可选：${Object.keys(MARKETS).join(' / ')}` });
    }
    if (!['1h', '15m', '4h'].includes(interval)) {
      return res.status(400).json({ error: 'interval 仅支持 1h / 15m / 4h' });
    }
    if (!Number.isFinite(before)) {
      return res.status(400).json({ error: 'before 必须是 epoch 毫秒' });
    }

    const { bars, exhausted } = await getHistoryBefore(symbol, { market, interval, beforeTime: before, limit });
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ symbol, market, interval, before, limit, count: bars.length, exhausted, bars });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/klines/:symbol/coverage —— 覆盖情况自查（可查 15m） */
klinesRouter.get('/:symbol/coverage', async (req, res) => {
  try {
    const symbol = String(req.params.symbol).trim();
    const market = parseMarket(req.query.market) ?? 'perp';
    const interval = String(req.query.interval || '1h');
    const cov = await coverage(symbol, market, interval);
    res.json({ symbol, market, interval, ...cov });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/klines-cache —— 服务端内存缓存状态 */
klinesRouter.get('/_cache/stats', (req, res) => {
  res.json(getCacheStats());
});

/** DELETE /api/klines/_cache/:symbol —— 手动清缓存（market 可选，不传则清所有市场） */
klinesRouter.delete('/_cache/:symbol', (req, res) => {
  clearBarCache(parseMarket(req.query.market), req.params.symbol);
  res.json({ ok: true, cleared: req.params.symbol });
});

export { ensureMaterialized, fetchBars };
