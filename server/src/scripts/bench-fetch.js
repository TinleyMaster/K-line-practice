import pg from 'pg';

// 连接串一律从环境变量读取，禁止硬编码（凭据泄露会随仓库一起公开）
const BASE = process.env.DATABASE_URL;
if (!BASE) {
  console.error('缺少 DATABASE_URL 环境变量。参考 .env.example 配置后重试。');
  process.exit(1);
}

async function run(label, connStr, sql, params = []) {
  const pool = new pg.Pool({ connectionString: connStr, max: 2, connectionTimeoutMillis: 10000 });
  try {
    for (let i = 0; i < 2; i++) {
      const t = Date.now();
      const res = await pool.query(sql, params);
      console.log(`  ${label} 第${i + 1}次: ${Date.now() - t} ms (${res.rows.length} 行)`);
    }
  } catch (e) {
    console.log(`  ${label}: FAIL ${e.message}`);
  } finally {
    await pool.end();
  }
}

const SQL = (n) =>
  `SELECT symbol, open_time, open_px, high_px, low_px, close_px, base_vol, quote_vol, trade_count
     FROM practice.klines WHERE symbol='BTCUSDT' AND interval='1h'
    ORDER BY open_time DESC LIMIT ${n}`;

console.log('=== node pg 实测（生产客户端）===');
for (const n of [100, 300, 800, 3000]) {
  await run(`pg ${String(n).padStart(4)}行 `, `${BASE}?sslmode=no-verify`, SQL(n));
}
