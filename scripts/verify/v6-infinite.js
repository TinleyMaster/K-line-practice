/**
 * v6.4 无限左加载验证（浏览器层）：
 *   验证「缩放 / 滑动图表时，起点之前的 K 线可以一直加载出来」。
 *
 * 关键机制（已在 klinecharts 源码中确认）：
 *   - klinecharts 的 DataLoader 方向与直觉相反：`forward` = 左边缘（from===0）触发，
 *     要回传**更老的** K 线，klinecharts 用 `data.concat(_dataList)` 前插并自动维持滚动位置；
 *     `backward` = 右边缘触发（未来），本产品右端锚定游标，一律不加载。
 *
 * 验证项：
 *   ① 初始 chart 装载了已揭示切片（count > 0），且右端不泄露未来（max ts ≤ cursorMs + 一个周期）。
 *   ② 向左滚动到左边缘 → forward loader 触发 → 从后端补齐更早的 K 线（count 显著增长）。
 *   ③ 左端时间戳随加载不断变早（确实在加载更老的历史）。
 *   ④ 右端始终锚定游标（向左滚动期间最右根时间戳不变，且仍不泄露未来）。
 *   ⑤ 15m / 4h 档同样可向左无限加载（三档右端对齐不被破坏）。
 *
 * 运行：需后端（8787，已 serve web/dist）+ Playwright Chromium。
 *   BASE_URL=http://127.0.0.1:8787 node scripts/verify/v6-infinite.js
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

let pass = 0;
let fail = 0;
function log(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

// 读取图表数据 + 引擎游标，封装成页面内求值
async function snapshot(page) {
  return page.evaluate(() => {
    const chart = window.__klineChart;
    const store = window.__practiceStore?.getState?.();
    const list = chart?.getDataList?.() || [];
    const ts = list.map((b) => b.timestamp);
    return {
      count: ts.length,
      firstTs: ts.length ? ts[0] : null,
      lastTs: ts.length ? ts[ts.length - 1] : null,
      maxTs: ts.length ? Math.max(...ts) : null,
      minTs: ts.length ? Math.min(...ts) : null,
      symbol: store?.symbol,
      market: store?.market,
      cursorMs: store?.cursorMs,
      period: store?.chartPeriod,
    };
  });
}

async function scrollLeftAndLoad(page, attempts = 6) {
  let before = await snapshot(page);
  let loaded = 0;
  let leftMostEver = before.firstTs;
  for (let i = 0; i < attempts; i++) {
    // 注：本版本 klinecharts 的 scrollByDistance 在 headless 下失效，
    // 用 scrollToDataIndex(0) 把视图拉到最左边缘 → 触发 forward loader（左边缘前插历史）。
    await page.evaluate(() => window.__klineChart.scrollToDataIndex(0, 0));
    // 等后端历史查询（跨机 DB 较慢）+ 前插
    await sleep(3500);
    const now = await snapshot(page);
    if (now.count > before.count) loaded += now.count - before.count;
    if (now.firstTs != null && (leftMostEver == null || now.firstTs < leftMostEver)) {
      leftMostEver = now.firstTs;
    }
    before = now;
  }
  return { loaded, leftMostEver, final: before };
}

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 60000 });
  // 等数据装载
  await page.waitForFunction(
    () => (window.__klineChart?.getDataList?.()?.length || 0) > 0,
    { timeout: 60000 },
  );
  await sleep(2000);

  // ── ① 初始状态 ─────────────────────────────────────────────
  console.log('\n═══ ① 初始状态（已揭示切片 + 不泄露未来）═══');
  const init = await snapshot(page);
  log('初始 chart 装载了 K 线（count > 0）', init.count > 0, `${init.count} 根 · ${init.symbol}/${init.market}/${init.period}`);
  const intervalMs = init.period === '15m' ? 15 * 60 * 1000 : init.period === '4h' ? 4 * 3600 * 1000 : 3600 * 1000;
  const noFutureInit = init.maxTs != null && init.cursorMs != null && init.maxTs <= init.cursorMs + intervalMs;
  log('初始右端不泄露未来（max ts ≤ cursorMs + 一个周期）', noFutureInit,
    `max=${init.maxTs} cursorMs=${init.cursorMs}`);

  // ── ② 向左无限加载（1h 默认档）─────────────────────────────
  console.log('\n═══ ② 1h 档：向左滑动/缩放触发历史前插 ═══');
  const r1 = await scrollLeftAndLoad(page, 5);
  log('向左滚动后 K 线总数显著增长（≥ 1000 根历史补齐）', r1.loaded >= 1000, `本次新增 ${r1.loaded} 根`);
  log('左端时间戳不断变早（确实在加载更老历史）',
    r1.leftMostEver != null && init.firstTs != null && r1.leftMostEver < init.firstTs,
    `首根 ${new Date(init.firstTs).toISOString()} → ${new Date(r1.leftMostEver).toISOString()}`);
  const noFutureAfter = r1.final.maxTs != null && r1.final.cursorMs != null && r1.final.maxTs <= r1.final.cursorMs + intervalMs;
  log('向左加载后右端仍不泄露未来（最右根不变且 ≤ cursorMs）', noFutureAfter,
    `max=${r1.final.maxTs} 末根=${r1.final.lastTs} cursorMs=${r1.final.cursorMs}`);
  log('右端锚定游标（向左滚动期间最右根时间戳不变）',
    init.lastTs != null && r1.final.lastTs != null && init.lastTs === r1.final.lastTs,
    `首末 ${init.lastTs} → ${r1.final.lastTs}`);

  // ── ⑤ 15m 档同样可向左加载 ────────────────────────────────
  console.log('\n═══ ⑤ 15m 档：向左无限加载 ═══');
  await page.evaluate(() => window.__practiceStore.getState().setChartPeriod('15m'));
  await page.waitForFunction(
    () => window.__practiceStore.getState().chartPeriod === '15m' &&
          (window.__klineChart?.getDataList?.()?.length || 0) > 0,
    { timeout: 30000 },
  );
  await sleep(2500);
  const init15 = await snapshot(page);
  const r15 = await scrollLeftAndLoad(page, 4);
  log('15m 档向左加载后总数增长（≥ 500 根历史）', r15.loaded >= 500, `新增 ${r15.loaded} 根`);
  log('15m 档右端不泄露未来', r15.final.maxTs != null && r15.final.cursorMs != null && r15.final.maxTs <= r15.final.cursorMs + 15 * 60 * 1000,
    `max=${r15.final.maxTs} cursorMs=${r15.final.cursorMs}`);

  // ── ⑤ 4h 档同样可向左加载（4h 由 1h 派生）─────────────────
  console.log('\n═══ ⑤ 4h 档：向左无限加载（派生）═══');
  await page.evaluate(() => window.__practiceStore.getState().setChartPeriod('4h'));
  await page.waitForFunction(
    () => window.__practiceStore.getState().chartPeriod === '4h' &&
          (window.__klineChart?.getDataList?.()?.length || 0) > 0,
    { timeout: 30000 },
  );
  await sleep(2500);
  const init4 = await snapshot(page);
  const r4 = await scrollLeftAndLoad(page, 4);
  log('4h 档向左加载后总数增长（≥ 200 根历史桶）', r4.loaded >= 200, `新增 ${r4.loaded} 根`);
  log('4h 档右端不泄露未来', r4.final.maxTs != null && r4.final.cursorMs != null && r4.final.maxTs <= r4.final.cursorMs + 4 * 3600 * 1000,
    `max=${r4.final.maxTs} cursorMs=${r4.final.cursorMs}`);

  // ── 页面无报错 ─────────────────────────────────────────────
  console.log('\n═══ 运行期无控制台/页面错误 ═══');
  log('无 pageerror / console error', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n──── 结果：${pass} 通过 / ${fail} 失败 ────`);
  process.exitCode = fail > 0 ? 1 : 0;
} catch (e) {
  console.error('[v6-infinite] 运行异常：', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
