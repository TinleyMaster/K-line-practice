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

/**
 * 计算摆动高低点（与前端 TRENDSTRUCT 指标同算法：左侧 L 根 + 右侧 R 根都更高/更低）。
 * 这里用于多周期共振：把 base 周期的摆动点与 ref 周期的摆动点按价格接近度配对。
 */
function swingPoints(bars, L, R) {
  const H = [];
  const Lw = [];
  if (!bars || bars.length < L + R + 1) return { H, Lw };
  for (let i = 0; i < bars.length; i++) {
    if (i - L < 0 || i + R >= bars.length) continue;
    let isH = true;
    let isL = true;
    for (let j = i - L; j <= i + R; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isH = false;
      if (bars[j].low <= bars[i].low) isL = false;
    }
    if (isH) H.push({ time: bars[i].time, price: bars[i].high });
    if (isL) Lw.push({ time: bars[i].time, price: bars[i].low });
  }
  return { H, Lw };
}

/**
 * GET /api/klines/confluence?symbol=BTCUSDT&market=perp&tolerance=0.01
 *
 * 多周期共振：把 base 周期（默认 1h）的摆动高低点，与 ref 周期（默认 15m，独立存储、
 * 非 1h 派生）的摆动高低点做价格接近度匹配。
 * 注意：4h 由 1h 派生，重合是"假共振"，因此 ref 用 15m（真实独立周期），
 * 这样两个时间尺度都认可同一价位，才是有效的共振强信号。
 */
klinesRouter.get('/confluence', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const market = parseMarket(req.query.market);
    const tol = Math.min(Math.max(Number(req.query.tolerance) || 0.01, 0.002), 0.05);
    const baseInt = String(req.query.base || '1h').toLowerCase();
    const refInt = String(req.query.ref || '15m').toLowerCase();
    // 时间容差（小时）：要求两个周期的摆动拐点"在同一价位附近、且时间上也靠近"，
    // 才是真正同一个转折点（强共振），而不是密集数据里随机的价格接近。
    // 默认 = base 周期的 3 倍（1h→3h，15m→45min），可用 timeTol 覆盖。
    const baseSec = INTERVAL_SECONDS[baseInt] ?? 3600;
    const timeTolH = Math.min(Math.max(Number(req.query.timeTol) || (baseSec * 3) / 3600, 0.25), 24);
    const timeTolMs = timeTolH * 3600 * 1000;
    if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
    if (!market) return res.status(400).json({ error: `market 非法，可选：${Object.keys(MARKETS).join(' / ')}` });

    const baseBars = await getBars(symbol, { limit: 1500, market, interval: baseInt });
    if (baseBars.length === 0) return res.status(404).json({ error: `无 ${symbol} 的 ${baseInt} 数据` });

    let refBars = [];
    let note = null;
    try {
      refBars = await getBars(symbol, { limit: 6000, market, interval: refInt });
    } catch (e) {
      note = `ref 周期 ${refInt} 读取失败：${e.message}`;
    }

    const base = swingPoints(baseBars, 6, 1);
    const ref = refBars.length ? swingPoints(refBars, 6, 1) : { H: [], Lw: [] };

    // 价格接近 + 时间也接近（同一转折点）才算共振
    const match = (pt, pool) => {
      let best = null;
      for (const r of pool) {
        if (Math.abs(r.price - pt.price) / pt.price > tol) continue;
        if (Math.abs(r.time - pt.time) > timeTolMs) continue;
        if (!best || Math.abs(r.price - pt.price) < Math.abs(best.price - pt.price)) best = r;
      }
      return best;
    };

    const confluentHighs = base.H
      .map((h) => ({ ...h, ref: match(h, ref.H) }))
      .filter((h) => h.ref)
      .map((h) => ({ time: h.time, price: h.price, refTime: h.ref.time, refPrice: h.ref.price }));
    const confluentLows = base.Lw
      .map((l) => ({ ...l, ref: match(l, ref.Lw) }))
      .filter((l) => l.ref)
      .map((l) => ({ time: l.time, price: l.price, refTime: l.ref.time, refPrice: l.ref.price }));

    // 仅保留"靠近当前价"的共振位（band，相对最后一根收盘价的百分比，0 = 全部）。
    // 1h 与 15m 同源（1h 高≈其 4 根 15m 高的最大值），共振天生偏多、属"确认"而非独立强信号，
    // 因此只展示贴近现价的共振位作为可操作的 S/R，避免历史图上标记泛滥。
    const lastClose = baseBars.length ? baseBars[baseBars.length - 1].close : null;
    const band = req.query.band !== undefined
      ? Math.min(Math.max(Number(req.query.band), 0), 1)
      : 0.03;
    const inBand = (p) => band <= 0 || lastClose == null || Math.abs(p - lastClose) / lastClose <= band;
    const fHighs = confluentHighs.filter((h) => inBand(h.price));
    const fLows = confluentLows.filter((l) => inBand(l.price));

    res.set('Cache-Control', 'private, max-age=120');
    res.json({
      symbol,
      market,
      base: baseInt,
      ref: refInt,
      tolerance: tol,
      timeTolHours: timeTolH,
      band,
      lastClose,
      note,
      countBaseHigh: base.H.length,
      countBaseLow: base.Lw.length,
      confluentHighs,
      confluentLows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/klines/_cache/:symbol —— 手动清缓存（market 可选，不传则清所有市场） */
klinesRouter.delete('/_cache/:symbol', (req, res) => {
  clearBarCache(parseMarket(req.query.market), req.params.symbol);
  res.json({ ok: true, cleared: req.params.symbol });
});

export { ensureMaterialized, fetchBars };
