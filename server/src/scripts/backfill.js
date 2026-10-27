import { query, queryOne, closePool } from '../db.js';
import { PRAC } from '../config.js';
import { initSchema, migrateMarketDimension } from '../schema.js';
import { backfillExternal } from '../services/klineService.js';
import { fetchRwaTokens } from '../services/sources/alpha.js';

/**
 * 回填脚本：把外部源（币安现货 / 链上美股）的 1h K 线写入 practice.klines。
 *
 * 用法：
 *   node src/scripts/backfill.js spot --symbols BTCUSDT,ETHUSDT --days 365
 *   node src/scripts/backfill.js stock --symbols AAPLon,TSLAon --days 60
 *   node src/scripts/backfill.js stock-all --limit 40      # 从 Alpha 自动挑市值最大的 N 个
 *   node src/scripts/backfill.js spot-all --limit 30       # 按币安现货成交额挑前 N
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

async function syncStockSymbols(limit) {
  const tokens = await fetchRwaTokens();
  const picked = tokens
    .filter((t) => t.marketCap > 0)
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, limit);

  for (let i = 0; i < picked.length; i++) {
    const t = picked[i];
    const sym = String(t.symbol).toUpperCase();
    const base = sym.endsWith('ON') && sym.length > 3 ? sym.slice(0, -2) : sym;
    const ref = {
      network: t.network,
      chain: t.chain,
      contractAddress: t.contractAddress,
      upstreamSymbol: t.symbol,
      underlyingName: t.name,
      marketCap: t.marketCap,
      volume24h: t.volume24h,
    };
    await query(
      `INSERT INTO ${PRAC.schema}.symbols
         (market, symbol, base, quote, category, enabled, sort_rank, source_symbol, external_ref, note)
       VALUES ('stock', $1, $2, 'USD', 'onchain_stock', true, $3, $4, $5::jsonb, $6)
       ON CONFLICT (market, symbol) DO UPDATE
          SET external_ref = EXCLUDED.external_ref, note = EXCLUDED.note`,
      [sym, base, i + 1, t.contractAddress, JSON.stringify(ref), t.name],
    );
  }
  console.log(`[backfill] 已同步 ${picked.length} 个链上美股标的到白名单`);
  return picked.map((t) => String(t.symbol).toUpperCase());
}

/**
 * 链上美股标的的数据健康度检查。
 *
 * 低流动性代币即使做了前向填充，历史里也可能只剩几条真实成交的哑线
 * （实测 IVVON 覆盖率 0.9%、HIMSON 3.1%、MSTRON 1.8%），
 * 这种标的拿去练习毫无意义，直接下架（enabled=false）并在 note 里写明原因。
 *
 * 判定：真实成交根数（source != geckoterminal_ffill）>= MIN_REAL_BARS 才保留。
 */
const MIN_REAL_BARS = 200;

async function auditStockCoverage(symbols) {
  for (const sym of symbols) {
    const r = await queryOne(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE source <> 'geckoterminal_ffill')::int AS real_bars,
              min(open_time) AS first_time, max(open_time) AS last_time
         FROM ${PRAC.schema}.klines
        WHERE market = 'stock' AND symbol = $1 AND interval = '1h'`,
      [sym],
    );
    const total = Number(r?.total ?? 0);
    const real = Number(r?.real_bars ?? 0);
    const span = r?.first_time && r?.last_time
      ? Math.round((new Date(r.last_time) - new Date(r.first_time)) / 3600000) + 1
      : 0;
    const coverage = span > 0 ? (total / span) * 100 : 0;
    const realRatio = total > 0 ? (real / total) * 100 : 0;
    const ok = real >= MIN_REAL_BARS;

    await query(
      `UPDATE ${PRAC.schema}.symbols
          SET enabled = $2,
              external_ref = external_ref || $3::jsonb
        WHERE market = 'stock' AND symbol = $1`,
      [
        sym,
        ok,
        JSON.stringify({
          dataHealth: {
            bars1h: total,
            coveragePct: Number(coverage.toFixed(1)),
            realBars: real,
            realRatioPct: Number(realRatio.toFixed(1)),
            enabled: ok,
            checkedAt: new Date().toISOString(),
          },
        }),
      ],
    );
    console.log(
      `  [audit] ${sym} 1h=${total}根 覆盖=${coverage.toFixed(1)}% 真实成交=${real}根 → ${ok ? '保留' : '下架'}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = args._[0] || 'help';
  const days = Number(args.days) || (mode.startsWith('stock') ? 60 : 365);
  const limit = Number(args.limit) || 30;

  console.log(`[backfill] 模式=${mode} days=${days}`);

  await initSchema((sql) => query(sql));
  await migrateMarketDimension((sql) => query(sql));

  let targets = [];
  let market = 'spot';

  if (mode === 'spot') {
    market = 'spot';
    targets = String(args.symbols || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (targets.length === 0) throw new Error('需要 --symbols BTCUSDT,ETHUSDT');
    // 现货标的登记进白名单（前端靠它显示）
    for (let i = 0; i < targets.length; i++) {
      const sym = targets[i];
      await query(
        `INSERT INTO ${PRAC.schema}.symbols (market, symbol, base, quote, category, enabled, sort_rank)
         VALUES ('spot', $1, $2, 'USDT', 'crypto_spot', true, $3)
         ON CONFLICT (market, symbol) DO UPDATE SET enabled = true`,
        [sym, sym.replace(/USDT$/, ''), i + 1],
      );
    }
  } else if (mode === 'stock') {
    market = 'stock';
    targets = String(args.symbols || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (targets.length === 0) throw new Error('需要 --symbols AAPLON,TSLAON');
  } else if (mode === 'stock-all') {
    market = 'stock';
    targets = await syncStockSymbols(limit);
  } else if (mode === 'spot-all') {
    market = 'spot';
    const rows = await query(
      `SELECT symbol FROM ${PRAC.schema}.symbols WHERE market='perp' AND enabled ORDER BY sort_rank LIMIT $1`,
      [limit],
    );
    targets = rows.rows.map((r) => r.symbol);
    for (let i = 0; i < targets.length; i++) {
      const sym = targets[i];
      await query(
        `INSERT INTO ${PRAC.schema}.symbols (market, symbol, base, quote, category, enabled, sort_rank)
         VALUES ('spot', $1, $2, 'USDT', 'crypto_spot', true, $3)
         ON CONFLICT (market, symbol) DO UPDATE SET enabled = true`,
        [sym, sym.replace(/USDT$/, ''), i + 1],
      );
    }
  } else if (mode === 'audit') {
    // 只做数据健康度审计，不回填
    market = 'stock';
    const rows = await query(
      `SELECT symbol FROM ${PRAC.schema}.symbols WHERE market='stock' ORDER BY sort_rank NULLS LAST`,
    );
    targets = rows.rows.map((r) => r.symbol);
    console.log(`[backfill] 审计 ${targets.length} 个链上美股标的的数据健康度`);
    await auditStockCoverage(targets);
    console.log('[backfill] 审计完成');
    await closePool();
    return;
  } else {
    console.log('用法: node src/scripts/backfill.js <spot|stock|spot-all|stock-all|audit> [--symbols a,b] [--days N] [--limit N]');
    await closePool();
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const symbol of targets) {
    const t0 = Date.now();
    try {
      const out = await backfillExternal({ market, symbol, days });
      ok += 1;
      console.log(
        `  [OK] ${symbol} (${market}) 拉取 ${out.fetched} 根 / 写入 ${out.written} 行 / ${Date.now() - t0}ms`,
      );
    } catch (err) {
      fail += 1;
      console.error(`  [FAIL] ${symbol} (${market}): ${err.message}`);
    }
  }

  // 链上美股：回填完做一次数据健康度审计，过稀的标的自动下架
  if (market === 'stock') {
    console.log('[backfill] 数据健康度审计（真实成交 < 200 根的标的将下架）');
    await auditStockCoverage(targets);
  }

  console.log(`[backfill] 完成：成功 ${ok}，失败 ${fail}`);
  await closePool();
}

main().catch(async (err) => {
  console.error('[backfill] 失败:', err);
  await closePool();
  process.exit(1);
});
