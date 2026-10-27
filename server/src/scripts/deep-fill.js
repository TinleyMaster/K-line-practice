import { query, queryOne, closePool } from '../db.js';
import { PRAC } from '../config.js';
import { initSchema, migrateMarketDimension, migrateV6 } from '../schema.js';
import { upsertExternalBars } from '../services/klineService.js';
import { fetchKlines as fetchBinanceKlines } from '../services/sources/binance.js';

/**
 * 深回填：从币安 API 把某个周期的历史补到指定起点。
 *
 * 为什么不能只靠源表物化：
 *   源表 biz.asset_klines 的 15m 只从 2026-09-16 起（3800 根 ≈ 40 天），
 *   而 1h 有 2022-12 起（33599 根 ≈ 3.9 年）。
 *   15m 只有 40 天 ⇒ 预热窗口（960 根 15m = 10 天）勉强够，
 *   但「练习起点之前的历史」就没了 —— 跟 v5 辛苦做出来的预热窗口理念冲突。
 *   币安 API 的历史很长（实测现货可回溯到 2017-08-17 上市日），直接补齐。
 *
 * 用法：
 *   node src/scripts/deep-fill.js --symbols BTCUSDT,ETHUSDT --market perp --interval 15m --since 2022-12-01
 *   node src/scripts/deep-fill.js --symbols BTCUSDT,ETHUSDT --market spot --interval 1h  --since 2017-08-17
 *
 * 幂等：upsert，重复跑安全。
 */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

/**
 * 分段拉取。
 *
 * 币安 klines 单页上限 1000 根，15m 一天 96 根。
 * 一次拉 9 年 ≈ 41000 页 —— 太多请求，容易触发限流。
 * 改成按「月」分段：每段 15m 约 2880 根（3 页）/ 1h 约 720 根（1 页），
 * 段与段之间留重叠以免漏边界。
 */
async function fetchByMonth({ symbol, market, interval, sinceMs, untilMs }) {
  const out = [];
  const MONTH = 30 * 24 * 3600 * 1000;
  let cursor = sinceMs;
  let guard = 0;

  while (cursor < untilMs && guard < 600) {
    guard += 1;
    const end = Math.min(cursor + MONTH, untilMs);
    const bars = await fetchBinanceKlines({
      symbol,
      interval,
      market,
      startMs: cursor,
      endMs: end,
      maxBars: 5000,
    });
    if (!bars.length) {
      // 该月没数据（币安可能限制历史深度）：跳到下一段再试
      cursor = end + 1;
      continue;
    }
    for (const b of bars) {
      if (b.time >= sinceMs && b.time <= untilMs) out.push(b);
    }
    const last = bars[bars.length - 1].time;
    if (last >= untilMs) break;
    // 重叠 1 根，避免边界漏掉
    cursor = last + 1;
  }

  const seen = new Map();
  for (const b of out) seen.set(b.time, b);
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = String(args.symbols || 'BTCUSDT,ETHUSDT')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const market = String(args.market || 'perp');
  const interval = String(args.interval || '15m');
  const since = String(args.since || '2022-12-01');
  const sinceMs = Date.parse(`${since}T00:00:00Z`);
  const untilMs = Date.now();

  if (!['1h', '15m', '4h'].includes(interval)) {
    console.error(`[deep] 不支持的周期：${interval}（可用：1h / 15m）`);
    await closePool();
    process.exit(1);
  }

  console.log(`[deep] market=${market} interval=${interval} symbols=${symbols.join(',')} since=${since}`);

  await initSchema((sql) => query(sql));
  await migrateMarketDimension((sql) => query(sql));
  await migrateV6((sql) => query(sql));

  for (const symbol of symbols) {
    const t0 = Date.now();
    try {
      const before = await queryOne(
        `SELECT count(*)::int AS n, min(open_time) AS f FROM ${PRAC.schema}.klines
          WHERE market = $1 AND symbol = $2 AND interval = $3`,
        [market, symbol, interval],
      );

      const bars = await fetchByMonth({ symbol, market, interval, sinceMs, untilMs });
      console.log(`  ${symbol} 拉到 ${bars.length} 根（${new Date(bars[0]?.time ?? 0).toISOString().slice(0, 16)} ~ ${new Date(bars[bars.length - 1]?.time ?? 0).toISOString().slice(0, 16)}）`);

      // 分批写 —— 一次写 10 万行会让临时表膨胀到几百 MB，跨机 COPY 会超时
      const BATCH = 20000;
      let written = 0;
      for (let i = 0; i < bars.length; i += BATCH) {
        const chunk = bars.slice(i, i + BATCH);
        written += await upsertExternalBars({
          market,
          symbol,
          bars: chunk,
          source: market === 'perp' ? 'binance_perp' : 'binance_spot',
          interval,
        });
      }

      const after = await queryOne(
        `SELECT count(*)::int AS n, min(open_time) AS f, max(open_time) AS l FROM ${PRAC.schema}.klines
          WHERE market = $1 AND symbol = $2 AND interval = $3`,
        [market, symbol, interval],
      );
      console.log(
        `  [OK] ${symbol} ${market}/${interval}: ${before?.n ?? 0} → ${after?.n ?? 0} 根 (${new Date(after?.f).toISOString().slice(0, 16)} ~ ${new Date(after?.l).toISOString().slice(0, 16)}) 写入 ${written} 行 ${Date.now() - t0}ms`,
      );

      // 清掉服务进程里的该标的缓存。
      // 本脚本是独立进程，改不了服务进程的内存缓存 —— 必须走 HTTP 让服务自己清。
      // 不清的话：回填前若有人请求过 15m，服务会命中「空结果负缓存」，
      // 用户在 60 秒内看到的一直是「无 15m 数据」。
      await clearServiceCache(symbol, market);
    } catch (err) {
      console.error(`  [FAIL] ${symbol}: ${err.message}`);
    }
  }

  await closePool();
}

/** 通过 HTTP 清服务端内存缓存（服务没起就跳过，不影响回填本身） */
async function clearServiceCache(symbol, market) {
  const base = process.env.SERVER_URL || 'http://127.0.0.1:8787';
  try {
    // 注意路由是 /_cache/:symbol（不是 /klines-cache/:symbol —— 那个路径不存在，
    // 拼错会静默 404，清缓存从未真正生效）
    const res = await fetch(
      `${base}/api/klines/_cache/${encodeURIComponent(symbol)}?market=${encodeURIComponent(market)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(5000) },
    );
    console.log(`  [cache] 已通知服务端清缓存：${res.status === 200 ? 'OK' : `HTTP ${res.status}`}`);
  } catch (err) {
    console.log(`  [cache] 清缓存跳过（服务未启动？）：${err.message}`);
  }
}

main().catch(async (err) => {
  console.error('[deep] 失败:', err);
  await closePool();
  process.exit(1);
});
