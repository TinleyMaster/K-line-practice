import { SRC, PRAC, config } from '../config.js';
import { queryRows, queryOne, query, getPool } from '../db.js';
import { from as copyFrom } from 'pg-copy-streams';
import { fetchKlines as fetchBinanceKlines } from './sources/binance.js';
import { resolveStockPool, fetchStock1h } from './sources/stock.js';

/** 1h = 3600s，4h = 14400s */
export const HOUR_SEC = 3600;

/** 市场维度：合约 / 现货 / 链上美股 */
export const MARKETS = {
  perp: { label: '币安U本位合约', source: 'binance_perp', category: 'crypto_perp' },
  spot: { label: '币安现货', source: 'binance_spot', category: 'crypto_spot' },
  stock: { label: '链上美股', source: 'geckoterminal', category: 'onchain_stock' },
};

export const INTERVAL_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '6h': 21600,
  '12h': 43200,
  '1d': 86400,
};

/**
 * 按需物化：把源表（biz.asset_klines，只读）的 1h 数据复制进本项目缓存表 practice.klines。
 *
 * 为什么必须物化：
 *   源表 1340 万行，(symbol, interval, open_time) 索引不覆盖 OHLC 列，
 *   取 3000 根要 26s（随机堆读）。物化后本地小表读取 <50ms。
 *
 * 增量语义：只复制 open_time 大于本地最大时间戳的部分，
 * 所以「最新数据补齐」和「首次全量」共用同一句话，天然幂等。
 *
 * 注意：物化只适用于 perp（源表里只有币安 U 本位合约数据）。
 * spot / stock 走各自外部源回填，见 upsertExternalBars。
 */
export async function materializeSymbol(symbol, { interval = '1h', market = 'perp' } = {}) {
  if (market !== 'perp') {
    throw new Error(`materializeSymbol 仅支持 perp，收到 market=${market}`);
  }

  const inserted = await queryOne(
    `INSERT INTO ${PRAC.schema}.klines
       (symbol, market, interval, open_time, open_px, high_px, low_px, close_px,
        base_vol, quote_vol, trade_count, source)
     SELECT k.symbol, 'perp', k.interval, k.open_time, k.open_px, k.high_px, k.low_px, k.close_px,
            k.base_vol, k.quote_vol, k.trade_count, 'binance_perp'
       FROM ${SRC.schema}.${SRC.table} k
      WHERE k.symbol = $1 AND k.interval = $2
        AND k.open_time > COALESCE(
              (SELECT max(p.open_time) FROM ${PRAC.schema}.klines p
                WHERE p.market = 'perp' AND p.symbol = $1 AND p.interval = $2),
              '1970-01-01T00:00:00Z'::timestamptz)
     ON CONFLICT (market, symbol, interval, open_time) DO NOTHING
     RETURNING 1`,
    [symbol, interval],
  );

  await refreshCoverage(symbol, interval, market);
  return inserted ? 1 : 0;
}

/** 刷新某标的的覆盖度缓存（写入 practice.symbol_coverage） */
export async function refreshCoverage(symbol, interval = '1h', market = 'perp') {
  await query(
    `INSERT INTO ${PRAC.schema}.symbol_coverage (symbol, market, interval, bars, first_time, last_time, updated_at)
     SELECT $1, $3, $2, count(*)::int, min(open_time), max(open_time), now()
       FROM ${PRAC.schema}.klines
      WHERE market = $3 AND symbol = $1 AND interval = $2
     ON CONFLICT (market, symbol, interval) DO UPDATE
        SET bars = EXCLUDED.bars,
            first_time = EXCLUDED.first_time,
            last_time = EXCLUDED.last_time,
            updated_at = now()`,
    [symbol, interval, market],
  );
}

/**
 * 写入外部源拉来的 K 线（spot / stock 用），幂等。
 *
 * 用 COPY 而非多值 INSERT：实测跨机写 1162 根要 69s（参数传输 + 逐行解析），
 * COPY 走二进制流，快一个数量级。临时表 + INSERT ... ON CONFLICT 保留了幂等语义。
 */
export async function upsertExternalBars({ market, symbol, bars, source }) {
  if (!bars?.length) return 0;
  const marketCfg = MARKETS[market];
  if (!marketCfg) throw new Error(`未知 market: ${market}`);
  const src = source ?? marketCfg.source;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TEMP TABLE tmp_practice_klines (LIKE ${PRAC.schema}.klines) ON COMMIT DROP`,
    );

    const csv = [
      'market,symbol,interval,open_time,open_px,high_px,low_px,close_px,base_vol,quote_vol,trade_count,source',
    ];
    for (const b of bars) {
      csv.push(
        [
          csvEscape(market),
          csvEscape(symbol),
          csvEscape('1h'),
          csvEscape(new Date(b.time).toISOString()),
          numStr(b.open),
          numStr(b.high),
          numStr(b.low),
          numStr(b.close),
          numStr(b.volume ?? 0),
          numStr(b.quoteVolume ?? 0),
          '0',
          // 单根可覆盖 source（前向填充的行要标记成 <src>_ffill，便于审计）
          csvEscape(b.source ?? src),
        ].join(','),
      );
    }

    const stream = client.query(
      copyFrom(
        `COPY tmp_practice_klines (market, symbol, interval, open_time, open_px, high_px, low_px, close_px, base_vol, quote_vol, trade_count, source) FROM STDIN WITH (FORMAT csv, HEADER)`,
      ),
    );
    await writeCsv(stream, csv.join('\n'));

    const res = await client.query(
      `INSERT INTO ${PRAC.schema}.klines
         (market, symbol, interval, open_time, open_px, high_px, low_px, close_px,
          base_vol, quote_vol, trade_count, source)
       SELECT market, symbol, interval, open_time, open_px, high_px, low_px, close_px,
              base_vol, quote_vol, trade_count, source
         FROM tmp_practice_klines
       ON CONFLICT (market, symbol, interval, open_time) DO UPDATE
          SET open_px = EXCLUDED.open_px,
              high_px = EXCLUDED.high_px,
              low_px = EXCLUDED.low_px,
              close_px = EXCLUDED.close_px,
              base_vol = EXCLUDED.base_vol,
              quote_vol = EXCLUDED.quote_vol,
              source = EXCLUDED.source
       RETURNING 1`,
    );

    await client.query('COMMIT');
    await refreshCoverage(symbol, '1h', market);
    return res.rowCount ?? 0;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 连接可能已断，忽略 */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** CSV 字段转义（含逗号/引号/换行时加引号） */
function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 数值转 CSV：用最短往返表示，避免浮点误差被写进 numeric 列 */
function numStr(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(n);
}

/** 向 COPY 流写入内容，处理 backpressure */
async function writeCsv(stream, content) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    stream.on('error', done);
    stream.on('end', () => done());
    stream.on('finish', () => done());
    stream.write(content);
    stream.end();
  });
}

/** 确保某标的已在本地缓存中；返回缓存覆盖信息 */
export async function ensureMaterialized(symbol, { interval = '1h', market = 'perp', force = false } = {}) {
  if (market !== 'perp') {
    // spot / stock 不来自源表，走外部回填（由 backfill 脚本或首次访问触发）
    // 本地读不到数据就是没回填过，无需额外查 coverage（省一次跨机往返）
    return null;
  }

  const ck = `${market}:${symbol}:${interval}`;
  const st = materializeState.get(ck);
  // TTL 内直接复用上次的结论，不查 DB
  // 实测跨机 RTT 271ms（DERP 中继），每省一次往返就是省 271ms
  if (!force && st && Date.now() - st.checkedAt < MATERIALIZE_TTL_MS) {
    return st.coverage;
  }

  const cached = await queryOne(
    `SELECT bars, first_time, last_time FROM ${PRAC.schema}.symbol_coverage
      WHERE market = $1 AND symbol = $2 AND interval = $3`,
    [market, symbol, interval],
  );

  let coverage = cached ?? { bars: 0, first_time: null, last_time: null };

  if (!cached || cached.bars === 0) {
    await materializeSymbol(symbol, { interval, market });
    coverage =
      (await queryOne(
        `SELECT bars, first_time, last_time FROM ${PRAC.schema}.symbol_coverage
          WHERE market = $1 AND symbol = $2 AND interval = $3`,
        [market, symbol, interval],
      )) ?? coverage;
  } else {
    // 增量补齐：本地最大时间落后于源表时补一段
    const srcMax = await queryOne(
      `SELECT max(open_time) AS mx FROM ${SRC.schema}.${SRC.table}
        WHERE symbol = $1 AND interval = $2`,
      [symbol, interval],
    );
    const srcMaxTime = srcMax?.mx ? new Date(srcMax.mx).getTime() : 0;
    const cachedMaxTime = cached.last_time ? new Date(cached.last_time).getTime() : 0;
    if (srcMaxTime > cachedMaxTime) {
      await materializeSymbol(symbol, { interval, market });
      coverage =
        (await queryOne(
          `SELECT bars, first_time, last_time FROM ${PRAC.schema}.symbol_coverage
            WHERE market = $1 AND symbol = $2 AND interval = $3`,
          [market, symbol, interval],
        )) ?? coverage;
    }
  }

  materializeState.set(ck, { checkedAt: Date.now(), coverage });
  return coverage;
}

/** 读取 1h K 线（走本地物化缓存） */
export async function fetch1h(symbol, { limit = 3000, start, end, market = 'perp' } = {}) {
  const COLS =
    'symbol, open_time, open_px, high_px, low_px, close_px, base_vol, quote_vol, trade_count, source';

  const where = ['market = $1', 'symbol = $2', 'interval = \'1h\''];
  const params = [market, symbol];
  if (start) {
    params.push(start);
    where.push(`open_time >= $${params.length}`);
  }
  if (end) {
    params.push(end);
    where.push(`open_time <= $${params.length}`);
  }
  params.push(limit);

  const rows = await queryRows(
    `SELECT ${COLS}
       FROM ${PRAC.schema}.klines
      WHERE ${where.join(' AND ')}
      ORDER BY open_time DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map(normalizeBar).sort((a, b) => a.time - b.time);
}

/* ================= 服务端内存缓存 =================
 * 物化表读取本身很快（服务端执行 1.3ms），但跨链路传输大结果集时延极高
 * （实测 3000 行可能 4s~113s 随机跳）。这里做进程内缓存，
 * 同一标的第二次请求直接命中内存，零传输。
 * 部署时后端与 DB 同机则本层几乎无感，跨机访问则救命。
 */
const CACHE_TTL_MS = config.cacheTtlMs;
const MAX_CACHE_SYMBOLS = 96;
/** 单次查询上限，防止前端传入超大 limit 把内存打爆 */
export const MAX_LIMIT = 5000;
const barCache = new Map(); // `${market}:${symbol}` -> { bars: Bar[] (ascending), loadedAt: number, exhausted: boolean }

/**
 * materialize 检查结论的缓存窗口。
 * 跨机 RTT 271ms，每次「查 coverage + 查源表 max」就是 2 次额外往返。
 * 用 5 分钟 TTL 换掉这些往返：增量物化本来就允许有分钟级延迟。
 */
const MATERIALIZE_TTL_MS = 5 * 60 * 1000;
const materializeState = new Map(); // `${market}:${symbol}:${interval}` -> { checkedAt, coverage }

const cacheKey = (market, symbol) => `${market}:${symbol}`;

export function getCacheStats() {
  return {
    symbols: barCache.size,
    entries: [...barCache.entries()].map(([k, v]) => ({
      key: k,
      bars: v.bars.length,
      exhausted: v.exhausted,
      ageMs: Date.now() - v.loadedAt,
    })),
  };
}

export function clearBarCache(market, symbol) {
  const dropState = (sym) => {
    for (const k of [...materializeState.keys()]) {
      if (k.endsWith(`:${sym}`)) materializeState.delete(k);
    }
  };
  if (market && symbol) {
    barCache.delete(cacheKey(market, symbol));
    dropState(symbol);
  } else if (symbol) {
    for (const k of [...barCache.keys()]) if (k.endsWith(`:${symbol}`)) barCache.delete(k);
    dropState(symbol);
  } else {
    barCache.clear();
    materializeState.clear();
  }
}

/**
 * 启动预热：把已登记的标的提前拉进内存缓存。
 *
 * 为什么需要：DB 在跨机链路上（实测 RTT 271ms，Tailscale DERP 中继），
 * 冷启动后每个标的的首次访问都要等 1~2s。预热把这段等待挪到服务启动阶段，
 * 用户侧就是零延迟 —— 后端与 DB 同机部署时收益同样存在（首屏更快）。
 *
 * 失败不阻塞启动：预热只是加速手段，不是正确性前提。
 */
export async function prewarm({ limit = 1200, concurrency = 8 } = {}) {
  const rows = await queryRows(
    `SELECT symbol, market FROM ${PRAC.schema}.symbols
      WHERE enabled
      ORDER BY market, sort_rank NULLS LAST, symbol`,
  );
  if (!rows.length) return { total: 0, ok: 0, fail: 0 };

  let ok = 0;
  let fail = 0;
  let idx = 0;

  async function worker() {
    while (idx < rows.length) {
      const r = rows[idx++];
      try {
        await get1h(r.symbol, { limit, market: r.market });
        ok += 1;
      } catch (err) {
        fail += 1;
        console.warn(`[prewarm] ${r.market}:${r.symbol} 失败：${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return { total: rows.length, ok, fail };
}

/**
 * 取 1h K 线：优先内存缓存 → 否则物化表读取 → 回填缓存。
 * 返回按时间升序的数组。
 *
 * 缓存命中判定有两个条件（缺一不可地误判）：
 *   1. hit.bars.length >= limit —— 缓存条数够本次请求；
 *   2. hit.exhausted —— 上次取回的行数 < 当时的 limit，说明「库里就这么多」，
 *      再大 limit 也取不到更多，直接复用（否则永远重查）。
 * 链上美股就是踩这个坑：CRCLON 库里只有 1172 根，limit=1200 时
 * 条件 1 永远不成立 → 每次请求都穿透到 DB → 每次 2s。
 *
 * 过期策略 = stale-while-revalidate：
 * 缓存超过 TTL 后不阻塞请求，先把旧数据返回去，同时后台静默刷新。
 * 原因：DB 走跨机链路（实测 RTT 271ms + ~1.3ms/行 的传输开销），
 * 同步刷新的冷读要 1~2s，用户会明显卡顿；旧数据只差几分钟，
 * 练习场景完全够用。
 */
export async function get1h(symbol, { limit = 1200, market = 'perp' } = {}) {
  limit = Math.max(1, Math.min(Number(limit) || 1200, MAX_LIMIT));
  const key = cacheKey(market, symbol);
  const hit = barCache.get(key);
  const age = hit ? Date.now() - hit.loadedAt : Infinity;

  if (hit && (hit.bars.length >= limit || hit.exhausted)) {
    if (age < CACHE_TTL_MS) {
      return hit.bars.slice(-limit);
    }
    // 已过期：返回旧数据 + 后台刷新（不阻塞）
    if (!hit.refreshing) {
      hit.refreshing = true;
      refreshInBackground(key, symbol, limit, market)
        .catch((err) => console.warn(`[cache] 后台刷新 ${key} 失败：${err.message}`))
        .finally(() => {
          hit.refreshing = false;
        });
    }
    return hit.bars.slice(-limit);
  }

  await ensureMaterialized(symbol, { market });
  const bars = await fetch1h(symbol, { limit, market });
  storeBars(key, bars, limit);
  return bars;
}

/** 后台刷新缓存（stale-while-revalidate 用） */
async function refreshInBackground(key, symbol, limit, market) {
  await ensureMaterialized(symbol, { market });
  const bars = await fetch1h(symbol, { limit, market });
  storeBars(key, bars, limit);
}

/** 写入内存缓存并维护淘汰 */
function storeBars(key, bars, limit) {
  // 取回数 < limit ⇒ 已到数据末尾，库里没有更多
  const exhausted = bars.length < limit;
  const hit = barCache.get(key);
  if (hit) {
    hit.bars = bars;
    hit.loadedAt = Date.now();
    hit.exhausted = exhausted;
  } else {
    barCache.set(key, { bars, loadedAt: Date.now(), exhausted, refreshing: false });
    if (barCache.size > MAX_CACHE_SYMBOLS) {
      // 淘汰最久未使用的
      const oldest = [...barCache.entries()].sort((a, b) => a[1].loadedAt - b[1].loadedAt)[0];
      if (oldest) barCache.delete(oldest[0]);
    }
  }
}

/**
 * 短空洞前向填充（ffill）。
 *
 * 为什么需要：链上美股 24/7 交易但流动性极低，低流动性的小时根本没有成交，
 * GeckoTerminal 就不返回那一根 —— 实测 1h 覆盖率只有 32%~81%
 * （NVDAON 80.7%、QQQON 66.2%、SPYON 61.9%、CRCLON 52.3%、MUON 32.1%）。
 * 稀疏的 1h 会连累 4h 派生：4h 桶里缺 1h 成员，形态就不完整。
 *
 * 填充规则：
 *   - 空洞 ≤ maxGapHours（默认 6h）：用前一根收盘价补一根哑线（OHLC 全等，成交量 0）。
 *     合理：链上没有成交的那一小时，价格确实没动，哑线反映的就是真实价格路径。
 *   - 空洞 > maxGapHours：不填。那多半是数据源本身缺这段（池子没建/被清），
 *     硬填会造出假形态。
 *
 * 填充出来的行 source 标成 <src>_ffill，事后可审计、可回溯。
 */
export function fillGaps(bars, { maxGapHours = 6 } = {}) {
  if (!bars?.length) return { bars: [], filled: 0, longGaps: 0 };
  const step = HOUR_SEC * 1000;
  const maxGapMs = maxGapHours * HOUR_SEC * 1000;

  const out = [bars[0]];
  let filled = 0;
  let longGaps = 0;

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    const gap = cur.time - prev.time;
    if (gap > step) {
      if (gap <= maxGapMs) {
        for (let t = prev.time + step; t < cur.time; t += step) {
          out.push({
            symbol: prev.symbol,
            time: t,
            open: prev.close,
            high: prev.close,
            low: prev.close,
            close: prev.close,
            volume: 0,
            quoteVolume: 0,
            trades: 0,
            synthetic: true,
          });
          filled += 1;
        }
      } else {
        longGaps += 1;
      }
    }
    out.push(cur);
  }
  return { bars: out, filled, longGaps };
}

/**
 * 从外部源回填 spot / stock 数据并写入本地表。
 * 幂等：已存在的 (market, symbol, interval, open_time) 会被更新而非插入重复行。
 */
export async function backfillExternal({ market, symbol, days = 365, maxBars = 20000 }) {
  const startMs = Date.now() - days * 24 * 3600 * 1000;

  if (market === 'spot') {
    const bars = await fetchBinanceKlines({
      symbol,
      interval: '1h',
      market: 'spot',
      startMs,
      maxBars,
    });
    const n = await upsertExternalBars({ market, symbol, bars, source: 'binance_spot' });
    return { fetched: bars.length, written: n };
  }

  if (market === 'stock') {
    const row = await queryOne(
      `SELECT source_symbol, external_ref FROM ${PRAC.schema}.symbols
        WHERE market = $1 AND symbol = $2`,
      [market, symbol],
    );
    let ref = row?.external_ref ?? {};

    // 池信息缺失 → 现查 Alpha 清单 + GeckoTerminal 解析池
    if (!ref.pools?.length) {
      const meta = await queryOne(
        `SELECT source_symbol, external_ref FROM ${PRAC.schema}.symbols
          WHERE market = $1 AND symbol = $2`,
        [market, symbol],
      );
      const token = {
        symbol,
        network: meta?.external_ref?.network,
        contractAddress: meta?.external_ref?.contractAddress ?? meta?.source_symbol,
      };
      if (!token.network || !token.contractAddress) {
        throw new Error(`${symbol} 缺少链上池信息（network / contractAddress），无法回填`);
      }
      const pool = await resolveStockPool(token);
      ref = { ...ref, ...pool };
      await query(
        `UPDATE ${PRAC.schema}.symbols SET external_ref = $3::jsonb
          WHERE market = $1 AND symbol = $2`,
        [market, symbol, JSON.stringify(ref)],
      );
    }

    // 多池合并：单池历史深度不足（实测 MSTRON 只有 3 根），多池互补后完整得多
    const pools = (ref.pools ?? []).map((p) => p.address).filter(Boolean);
    const raw = await fetchStock1h({
      network: ref.network,
      pools: pools.length ? pools : [ref.poolAddress],
      startMs,
      maxBars,
    });

    // 低流动性时段无成交 → 1h 稀疏。短空洞前向填充，保证 4h 形态完整。
    const { bars, filled, longGaps } = fillGaps(raw, { maxGapHours: 6 });
    for (const b of bars) {
      if (b.synthetic) b.source = 'geckoterminal_ffill';
    }
    if (filled > 0 || longGaps > 0) {
      console.log(
        `  [stock] ${symbol} 原始 ${raw.length} 根 → 填充 ${filled} 根（长空洞 ${longGaps} 处未填）`,
      );
    }

    // 先删后插：合并规则调整过（脏池剔除），旧数据里可能残留异常点，
    // upsert 只更新同时间戳的行、不会删除「新数据里没有」的历史行。
    await query(
      `DELETE FROM ${PRAC.schema}.klines WHERE market = $1 AND symbol = $2 AND interval = '1h'`,
      [market, symbol],
    );

    const n = await upsertExternalBars({ market, symbol, bars, source: 'geckoterminal' });
    return { fetched: bars.length, written: n, pools: pools.length, filled, longGaps };
  }

  throw new Error(`backfillExternal 不支持 market=${market}`);
}

function normalizeBar(r) {
  return {
    symbol: r.symbol,
    time: toEpochMs(r.open_time),
    open: num(r.open_px),
    high: num(r.high_px),
    low: num(r.low_px),
    close: num(r.close_px),
    volume: num(r.base_vol),
    quoteVolume: num(r.quote_vol),
    trades: num(r.trade_count),
    // source=geckoterminal_ffill 的行是链上低流动性时段的前向填充哑线
    source: r.source ?? null,
  };
}

function num(v) {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toEpochMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const d = new Date(v);
  return d.getTime();
}

/**
 * 由 1h 聚合派生 4h。
 * 与 1h 严格对齐：4h 桶起点 = floor(epoch / 14400) * 14400（UTC 对齐）。
 */
export function derive4h(bars1h) {
  if (!bars1h?.length) return [];
  const bucketMs = INTERVAL_SECONDS['4h'] * 1000;
  const out = [];
  let cur = null;

  for (const b of bars1h) {
    const bucketStart = Math.floor(b.time / bucketMs) * bucketMs;
    if (!cur || cur.time !== bucketStart) {
      if (cur) out.push(cur);
      cur = {
        symbol: b.symbol,
        time: bucketStart,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: 0,
        quoteVolume: 0,
        trades: 0,
        constituents: 0,
      };
    }
    cur.high = Math.max(cur.high, b.high);
    cur.low = Math.min(cur.low, b.low);
    cur.close = b.close;
    cur.volume += b.volume;
    cur.quoteVolume += b.quoteVolume;
    cur.trades += b.trades;
    cur.constituents += 1;
  }
  if (cur) out.push(cur);
  return out;
}

/** 统计某 symbol 的 1h 覆盖情况（读本地缓存） */
export async function coverage(symbol, market = 'perp') {
  const row = await queryOne(
    `SELECT bars, first_time, last_time FROM ${PRAC.schema}.symbol_coverage
      WHERE market = $1 AND symbol = $2 AND interval = '1h'`,
    [market, symbol],
  );
  return {
    bars: row?.bars ?? 0,
    firstTime: row?.first_time ?? null,
    lastTime: row?.last_time ?? null,
  };
}

/** 按近 30 天成交额挑活跃标的（用于生成练习白名单） */
export async function topSymbolsByTurnover(limit = 60) {
  const rows = await queryRows(
    `SELECT symbol,
            count(*)::int AS bars,
            sum(quote_vol) AS turnover,
            max(open_time) AS last_time
       FROM ${SRC.schema}.${SRC.table}
      WHERE interval = '1h'
        AND open_time >= now() - interval '30 days'
      GROUP BY symbol
      ORDER BY turnover DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    symbol: r.symbol,
    bars: r.bars,
    turnover: Number(r.turnover ?? 0),
    lastTime: r.last_time,
  }));
}
