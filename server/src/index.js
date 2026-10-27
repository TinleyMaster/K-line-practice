import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { healthCheck, query } from './db.js';
import { initSchema } from './schema.js';
import { prewarm } from './services/klineService.js';
import { symbolsRouter } from './routes/symbols.js';
import { klinesRouter } from './routes/klines.js';
import { setupsRouter } from './routes/setups.js';
import { practiceRouter } from './routes/practice.js';
import { statsRouter } from './routes/stats.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
// K 线 JSON 很大，gzip 后体积约为 1/6，跨链路传输差异巨大
app.use(
  compression({
    filter: (req, res) => {
      if (req.path === '/api/health') return false;
      return compression.filter(req, res);
    },
  }),
);

// 请求日志（精简）
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`[api] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - t0}ms`);
    }
  });
  next();
});

app.get('/api/health', async (req, res) => {
  const db = await healthCheck();
  res.status(db.ok ? 200 : 503).json({
    ok: db.ok,
    db,
    dataSource: config.dataSource,
    source: `${config.sourceSchema}.${config.sourceTable}`,
    practiceSchema: config.practiceSchema,
    serverTime: new Date().toISOString(),
  });
});

app.use('/api/symbols', symbolsRouter);
app.use('/api/klines', klinesRouter);
app.use('/api/setups', setupsRouter);
app.use('/api', practiceRouter);
app.use('/api/stats', statsRouter);

// 生产环境：托管前端静态资源
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('text/plain').send('K线练习平台 API 已启动。前端构建产物未找到（web/dist），请先执行 npm run build。');
  });
}

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err?.message || 'internal error' });
});

const server = app.listen(config.port, config.host, async () => {
  console.log(`[server] K线练习平台 API 已启动 → http://${config.host}:${config.port}`);
  console.log(`[server] 只读原表: ${config.sourceSchema}.${config.sourceTable} | 写入: ${config.practiceSchema} schema`);

  if (config.autoInitDb) {
    try {
      await initSchema((sql) => query(sql));
      console.log('[server] practice schema 校验/建表完成');
    } catch (err) {
      console.error('[server] 自动建表失败:', err.message);
    }
  }

  // 预热：异步进行，不阻塞端口监听；失败不影响服务可用性
  if (config.prewarm) {
    prewarm({ limit: config.prewarmLimit, concurrency: config.prewarmConcurrency })
      .then((r) => {
        console.log(`[server] 预热完成：${r.ok}/${r.total} 标的进入内存缓存${r.fail ? `，失败 ${r.fail}` : ''}`);
      })
      .catch((err) => console.warn('[server] 预热失败（不影响服务）:', err.message));
  }
});

const shutdown = async (sig) => {
  console.log(`[server] 收到 ${sig}，正在关闭...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
