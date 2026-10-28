/**
 * v6.3 五修验证（浏览器层）：
 *   ① 技术指标配置生效（面板周期跟随图表当前档位）
 *   ② 画线工具（趋势线 / 水平线 / 价格线：能画、切周期保留、能清除）
 *   ③ 1h 档 K 线密度可读（每根 ≥3.5px，实体看得清阴阳）
 *   ④ 起点调节（可调范围真实可见 + 范围内设了必生效）
 *   ⑤ 开仓被禁时原因醒目可见（侧栏顶部）
 *
 * 这 5 条全是**用户实测反馈**来的，每条都对应一个真实缺陷：
 *   ① 面板固定停在「4h 趋势」⇒ 在 1h 图表上改指标改的是另一个档 ⇒「改了没反应」
 *   ② 画线工具原本没有
 *   ③ 为了像素级对齐把 1h 压到 2px/根 ⇒「1h 比另外两个图表都小」
 *   ④ 起点 input 的 min/max 用的是数据边界 ⇒ 选到会被夹住的时间 ⇒「起点调节失效」
 *   ⑤ 按钮一灰只留 title（要悬停才看得到）⇒ 用户只看到「点不动」
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
  await sleep(7000);

  // ── ③ 1h 档 K 线密度 ─────────────────────────────────────
  console.log('\n═══ ③ 1h 档 K 线密度（用户反馈「比另外两个图表都小」）═══');
  const bs = await page.evaluate(() => window.__klineChart.getBarSpace().bar);
  log('1h 档 barSpace ≥ 3.5px（实体看得清阴阳与影线）', bs >= 3.5, `${bs.toFixed(2)}px/根`);

  // ── ① 指标面板跟随图表周期 ───────────────────────────────
  console.log('\n═══ ① 技术指标配置生效 ═══');
  await page.evaluate(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('技术指标'))?.click(),
  );
  await sleep(800);
  const activeTab = await page.evaluate(
    () => document.querySelector('.ind-period-tab.active')?.textContent?.trim(),
  );
  log('1h 图表下指标面板默认停在「1h 入场」', activeTab === '1h 入场', `active=${activeTab}`);

  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.ind-item')].find(
      (i) => i.querySelector('.ind-code')?.textContent === 'RSI',
    );
    item?.querySelector('input')?.click();
  });
  await sleep(1200);
  const ind1h = await page.evaluate(() => window.__practiceStore.getState().indicators1h);
  log('加 RSI 后 1h 的指标配置真的变了', ind1h.includes('RSI'), JSON.stringify(ind1h));
  const chartInd = await page.evaluate(() =>
    window.__klineChart.getIndicators().map((i) => i.id),
  );
  log('图表上确实多了 RSI 实例', chartInd.some((i) => i.includes('RSI')), JSON.stringify(chartInd));
  await page.evaluate(() => document.querySelector('.ind-panel .ind-foot .btn:last-child')?.click());
  await sleep(500);

  // ── ② 画线工具 ──────────────────────────────────────────
  console.log('\n═══ ② 画线工具 ═══');
  await page.evaluate(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('画线'))?.click(),
  );
  await sleep(600);
  const toolCount = await page.evaluate(() => document.querySelectorAll('.draw-item').length);
  log('画线工具面板能打开', toolCount >= 4, `${toolCount} 个按钮`);

  await page.evaluate(() => {
    const it = [...document.querySelectorAll('.draw-item')].find((b) => b.textContent.includes('趋势线'));
    it?.click();
  });
  await sleep(1200);
  let ov = await page.evaluate(() =>
    window.__klineChart.getOverlays({ groupId: 'drawing' }).map((o) => o.id),
  );
  log('画出一根趋势线后 overlay 存在', ov.length === 1, JSON.stringify(ov));

  // 趋势线用【数据坐标】创建才有内容 —— 断言它真的落在主图范围内（不是空壳）
  const segOk = await page.evaluate(() => {
    const c = window.__klineChart;
    const o = c.getOverlays({ groupId: 'drawing' })[0];
    const p = o?.points ?? [];
    if (p.length < 2 || typeof p[0].timestamp !== 'number') return { ok: false, pts: p.length };
    const px = c.convertToPixel({ timestamp: p[0].timestamp, value: p[0].value }, { absolute: true });
    const size = c.getSize();
    return { ok: !!px && px.x > 0 && px.x < size.width, pts: p.length, x: px?.x };
  });
  log('趋势线用数据坐标、真的落在图上', segOk.ok, JSON.stringify(segOk));

  await page.evaluate(() =>
    [...document.querySelectorAll('.period-tab')]
      .find((e) => e.querySelector('.period-main')?.textContent.trim() === '4h')
      ?.click(),
  );
  await sleep(2500);
  ov = await page.evaluate(() => window.__klineChart.getOverlays({ groupId: 'drawing' }).length);
  log('切到 4h 档画线仍在', ov === 1, `剩 ${ov}`);

  await page.evaluate(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('画线'))?.click(),
  );
  await sleep(500);
  await page.evaluate(() =>
    [...document.querySelectorAll('.draw-item')].find((b) => b.textContent.includes('清除'))?.click(),
  );
  await sleep(800);
  ov = await page.evaluate(() => window.__klineChart.getOverlays({ groupId: 'drawing' }).length);
  log('「清除」能清掉画线', ov === 0, `剩 ${ov}`);

  // ── ④ 起点调节 ──────────────────────────────────────────
  console.log('\n═══ ④ 起点调节 ═══');
  await page.evaluate(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('⏱'))?.click(),
  );
  await sleep(800);
  const rangeInfo = await page.evaluate(() => {
    const inp = document.querySelector('.start-panel input[type=datetime-local]');
    const rows = [...document.querySelectorAll('.start-row')].map((r) =>
      r.textContent.replace(/\s+/g, ' ').trim(),
    );
    return { min: inp?.getAttribute('min'), max: inp?.getAttribute('max'), rows };
  });
  log('起点输入框的 min/max 是真实可调边界', !!rangeInfo.min && !!rangeInfo.max, `min=${rangeInfo.min} max=${rangeInfo.max}`);
  log(
    '面板里显示「可调范围」',
    rangeInfo.rows.some((r) => r.includes('可调范围')),
    rangeInfo.rows.find((r) => r.includes('可调范围')) || '',
  );
  const setRes = await page.evaluate(async () => {
    const s = window.__practiceStore.getState();
    const minIdx = Math.min(120 * 4, s.bars1h.length - 1);
    const maxIdx = s.bars1h.length - 60;
    const t = s.bars1h[Math.floor((minIdx + maxIdx) / 2)].time;
    await window.__practiceStore.getState().setStartTime(t);
    const t2 = window.__practiceStore.getState();
    return {
      asked: new Date(t).toISOString(),
      got: new Date(t2.bars1h[t2.startCursor].time).toISOString(),
      cursor: t2.cursor,
      startCursor: t2.startCursor,
      maxCursor: t2.maxCursor,
    };
  });
  log(
    '在可调范围内设起点 → 真的生效',
    Math.abs(new Date(setRes.asked).getTime() - new Date(setRes.got).getTime()) < 3600000,
    `要 ${setRes.asked} → 得 ${setRes.got}`,
  );
  log(
    '起点变化后 cursor/startCursor/maxCursor 同步（不是回看模式）',
    setRes.cursor === setRes.startCursor && setRes.startCursor === setRes.maxCursor,
    `cursor=${setRes.cursor} start=${setRes.startCursor} max=${setRes.maxCursor}`,
  );
  await page.evaluate(() => document.querySelector('.start-panel .ind-foot .btn:last-child')?.click());
  await sleep(400);

  // ── ⑤ 开仓被禁的原因 ────────────────────────────────────
  console.log('\n═══ ⑤ 开仓被禁：原因醒目可见 ═══');
  await page.evaluate(() => window.__practiceStore.getState().next());
  await sleep(600);
  await page.evaluate(() => window.__practiceStore.getState().prev());
  await sleep(900);
  const blockInfo = await page.evaluate(() => {
    const n = document.querySelector('.trade-block-reason');
    return { exists: !!n, text: n?.textContent?.replace(/\s+/g, ' ').trim() };
  });
  log(
    '回看模式下侧栏顶部出现醒目原因',
    blockInfo.exists && /回看/.test(blockInfo.text || ''),
    blockInfo.text || '(无)',
  );

  await page.screenshot({ path: path.join(OUT, 'v6-fixes.png') });

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
  if (errors.length) {
    console.log(`\n⚠️ 页面 JS 错误 ${errors.length} 条：`);
    for (const e of [...new Set(errors)].slice(0, 5)) console.log('   ', e.slice(0, 200));
  } else {
    console.log('✅ 0 页面 JS 错误');
  }
  if (fail > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
