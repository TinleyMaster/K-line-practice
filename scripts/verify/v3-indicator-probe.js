/**
 * 指标渲染深探针：直接问 klinecharts 内部拿到了什么。
 * 不靠肉眼判断「画出来了没有」。
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const CHROME =
  process.env.CHROME_PATH ||
  path.join(
    process.env.LOCALAPPDATA || 'C:/Users/SuperTing/AppData/Local',
    'ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  );
const OUT = process.env.OUT_DIR || path.join(process.cwd(), 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(6000);

// 配置一批有代表性的指标：主图叠加 + 2 个独立副图
const applied = await page.evaluate(async () => {
  const raw = localStorage.getItem('kline-practice-v1');
  const s = raw ? JSON.parse(raw).state : {};
  s.indicators4h = ['MA', 'BOLL', 'VOL', 'RSI'];
  s.indicators1h = ['MA', 'EMA', 'VOL', 'MACD'];
  localStorage.setItem('kline-practice-v1', JSON.stringify({ state: s, version: 0 }));
  return s.indicators4h;
});
console.log('注入配置 4h:', applied.join(', '));

await page.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await sleep(7000);

// 读取图表内部状态：DOM 上的窗格 + canvas 分层
const probe = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('.chart-canvas')];
  return blocks.map((b, i) => {
    const r = b.getBoundingClientRect();
    // klinecharts 每个窗格是一组 canvas，按 top 分层
    const cvs = [...b.querySelectorAll('canvas')];
    const tops = [...new Set(cvs.map((c) => Math.round(c.getBoundingClientRect().top)))].sort(
      (x, y) => x - y,
    );
    const layers = tops.map((t) => {
      const c = cvs.find((x) => Math.round(x.getBoundingClientRect().top) === t);
      const cr = c.getBoundingClientRect();
      return { top: t, h: Math.round(cr.height), w: Math.round(cr.width) };
    });
    return {
      idx: i,
      boxH: Math.round(r.height),
      canvasCount: cvs.length,
      layerCount: layers.length,
      layers,
    };
  });
});

console.log('\n── 4h 图表 ──');
console.log(JSON.stringify(probe[0], null, 1));
console.log('\n── 1h 图表 ──');
console.log(JSON.stringify(probe[1], null, 1));

// 截图：分别截两个图表区
const blocks = await page.$$('.chart-canvas');
if (blocks[0]) await blocks[0].screenshot({ path: path.join(OUT, 'v3-chart-4h.png') });
if (blocks[1]) await blocks[1].screenshot({ path: path.join(OUT, 'v3-chart-1h.png') });

// 整页截图（滚到顶）
await page.evaluate(() => window.scrollTo(0, 0));
await sleep(500);
await page.screenshot({ path: path.join(OUT, 'v3-full.png'), fullPage: false });

console.log('\nJS 错误:', errors.length === 0 ? '无 ✅' : errors.slice(0, 3).join(' | '));
await browser.close();
