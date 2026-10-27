import { query, closePool } from '../db.js';
import { initSchema, migrateMarketDimension } from '../schema.js';
import { topSymbolsByTurnover } from '../services/klineService.js';

/**
 * 种子数据：
 *  1. practice.symbols —— 练习白名单（按近 30 天成交额排序取前 N，只在缺失时插入）
 *  2. practice.setups   —— 开仓设置库初始模板
 */

const DEFAULT_SETUPS = [
  {
    name: '趋势回调入场',
    description: '4h 趋势明确（均线多头排列 / 价格在中轨上方），1h 回调到关键位后出现企稳信号进场。',
    marketCondition: '4h 上升趋势，回调不破前低',
    entryRules: ['4h 趋势方向明确（只做顺着 4h 的方向）', '1h 回调到 EMA20 或前高/前低支撑阻力', '出现吞没/针钉等反转 K 线确认', '止损放在回调结构低点（多）/ 高点（空）外侧'],
    exitRules: ['初始止损 = 结构位外侧', '目标 2R 起分批止盈', '1h 收盘破位则离场'],
    color: '#ef4d4d',
  },
  {
    name: '突破回踩',
    description: '价格突破关键位后回踩确认不破，第二次顺势进场。',
    marketCondition: '4h 处于区间上沿或趋势中继',
    entryRules: ['突破前高/前低或区间边界并收实体', '回踩突破位不破（假突破排除）', '出现顺势进场 K 线', '止损放回踩影线外侧'],
    exitRules: ['止损 = 回踩极值外侧', '目标 = 突破段等距或 2R', '回踩确认失败立即离场'],
    color: '#f0a020',
  },
  {
    name: '假突破反转',
    description: '突破关键位失败（长影线/收回区间），反向进场。',
    marketCondition: '4h 区间震荡中部或边界',
    entryRules: ['价格刺穿关键位但 1h 收盘收回区间内', '影线明显（>1.5 倍实体）', '在区间另一侧有空间（至少 1.5R）', '止损放被刺穿极值外侧'],
    exitRules: ['止损 = 假突破极值外侧', '目标 = 区间另一侧', '1h 收在关键位外则离场'],
    color: '#22c55e',
  },
  {
    name: '区间边缘高抛低吸',
    description: '4h 区间震荡，价格触及区间边缘并出现反转信号。',
    marketCondition: '4h 明确震荡区间（无趋势）',
    entryRules: ['4h 处于震荡区间且区间边界清晰', '1h 触及区间边界', '出现反转确认 K 线', '止损 = 边界外 0.3%'],
    exitRules: ['止损 = 边界外侧', '目标 = 区间中轴或对侧', '区间被有效突破则离场'],
    color: '#3b82f6',
  },
  {
    name: '趋势延续旗形',
    description: '强趋势中回调形成小幅度收敛旗形，突破旗形后顺势跟进。',
    marketCondition: '4h 强趋势（斜率陡峭，无重叠）',
    entryRules: ['4h 趋势线斜率陡峭', '1h 回调幅度 < 前一段推动的 1/3', '形态收敛（K 线实体变小）', '突破旗形高点/低点进场'],
    exitRules: ['止损 = 旗形另一端', '目标 = 推动段等距', '旗形失败（反向突破）离场'],
    color: '#a855f7',
  },
];

async function main() {
  console.log('[seed] 建表检查...');
  await initSchema((sql) => query(sql));
  await migrateMarketDimension((sql) => query(sql));

  // --- symbols ---
  const existing = await query(`SELECT count(*)::int AS n FROM practice.symbols`);
  const existingN = existing.rows[0].n;
  if (existingN > 0) {
    console.log(`[seed] practice.symbols 已有 ${existingN} 条，跳过（不覆盖你的配置）`);
  } else {
    console.log('[seed] 统计近 30 天成交额 Top 标的...');
    const top = await topSymbolsByTurnover(60);
    if (top.length === 0) {
      console.warn('[seed] 未从源库取到标的，白名单保持为空');
    }
    for (let i = 0; i < top.length; i++) {
      const s = top[i].symbol;
      const base = s.replace(/USDT$/, '');
      await query(
        `INSERT INTO practice.symbols (market, symbol, base, quote, category, enabled, sort_rank)
         VALUES ('perp',$1,$2,'USDT','crypto_perp',true,$3)
         ON CONFLICT (market, symbol) DO NOTHING`,
        [s, base, i + 1],
      );
    }
    console.log(`[seed] 已写入 ${top.length} 个练习标的`);

    // 强制保留几个核心标的置顶
    for (const [rank, sym] of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].entries()) {
      await query(
        `UPDATE practice.symbols SET sort_rank=$2 WHERE market='perp' AND symbol=$1`,
        [sym, rank],
      );
    }
  }

  // --- setups ---
  const s = await query(`SELECT count(*)::int AS n FROM practice.setups`);
  if (s.rows[0].n === 0) {
    for (const su of DEFAULT_SETUPS) {
      await query(
        `INSERT INTO practice.setups (name, description, market_condition, entry_rules, exit_rules, color)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
         ON CONFLICT (name) DO NOTHING`,
        [
          su.name,
          su.description,
          su.marketCondition,
          JSON.stringify(su.entryRules),
          JSON.stringify(su.exitRules),
          su.color,
        ],
      );
    }
    console.log(`[seed] 已写入 ${DEFAULT_SETUPS.length} 套开仓设置`);
  } else {
    console.log(`[seed] practice.setups 已有 ${s.rows[0].n} 条，跳过`);
  }

  const final = await query(
    `SELECT (SELECT count(*)::int FROM practice.symbols) AS symbols,
            (SELECT count(*)::int FROM practice.setups) AS setups`,
  );
  console.log('[seed] 完成:', final.rows[0]);
  await closePool();
}

main().catch(async (err) => {
  console.error('[seed] 失败:', err);
  await closePool();
  process.exit(1);
});
