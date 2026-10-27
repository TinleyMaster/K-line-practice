/**
 * v5 增量功能验证：
 *   ① 起点前 K 线可见 + 指标预热（当前根的指标必须有值）
 *   ② 绿涨红跌（K 线 / 文字 / CSS 变量）
 *   ③ 播放配置折叠（点播放才展开速度）+ 前进/后退按钮放大
 *   ④ 点击 K 线显示详细数据（币安式：点哪根显示哪根，容错高）
 *
 * 依赖 ChartPanel 暴露的 window.__klineChart 测试钩子。
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

/** 读 OHLC 详情条 */
async function readOhlc(page) {
  return page.evaluate(() => {
    const strip = document.querySelector('.ohlc-strip');
    if (!strip) return null;
    const cells = [...strip.querySelectorAll('.ohlc-cell')].map((c) => ({
      label: c.querySelector('.ohlc-label')?.textContent?.trim(),
      value: c.querySelector('.ohlc-value')?.textContent?.trim(),
    }));
    return {
      ts: Number(strip.querySelector('.ohlc-time')?.getAttribute('data-ts')) || null,
      timeText: strip.querySelector('.ohlc-time')?.textContent?.trim(),
      locked: !!strip.querySelector('.ohlc-lock'),
      cells,
      byLabel: Object.fromEntries(cells.map((c) => [c.label, c.value])),
    };
  });
}

/** 读图表内部状态（可见区 / 数据长度 / 指标结果） */
async function readChart(page) {
  return page.evaluate(() => {
    const chart = window.__klineChart;
    if (!chart) return null;
    const list = chart.getDataList();
    const visible = chart.getVisibleRange();
    const inds = {};
    for (const ind of chart.getIndicators()) {
      const r = ind.result || [];
      inds[ind.id] = { len: r.length, last: r[r.length - 1] ?? null };
    }
    return {
      dataLen: list.length,
      visible,
      barSpace: chart.getBarSpace().bar,
      inds,
      styles: chart.getStyles().candle.bar,
    };
  });
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
  await sleep(6000);

  console.log('\n═══ ① 起点前 K 线可见 + 指标预热 ═══');

  // v6 起默认档位是 1h（需求：默认显示 1h），而本段断言的是 4h 的专属口径。
  // 必须先显式切到 4h 再读，否则读到的是 1h 的状态（visible.from / barSpace 全对不上）。
  await page.evaluate(() => {
    [...document.querySelectorAll('.period-tab')].find((x) => x.textContent.trim().startsWith('4h'))?.click();
  });
  await sleep(1800);

  const c4 = await readChart(page);
  log('4h 图表实例可用', !!c4, JSON.stringify(c4?.visible));
  log(
    '4h 喂入足够预热历史（≥120 根 4h）',
    (c4?.dataLen ?? 0) >= 121,
    `${c4?.dataLen} 根 4h`,
  );
  log(
    '4h 可见区覆盖到窗口起点（起点前历史在视野内）',
    (c4?.visible?.from ?? 1) === 0,
    `visible.from=${c4?.visible?.from} visible.to=${c4?.visible?.to}`,
  );

  const maLast = c4?.inds?.['ind_MA']?.last;
  const maHasValue =
    maLast && typeof maLast === 'object' && Object.values(maLast).some((v) => typeof v === 'number');
  log('4h 当前根 MA 指标有值', !!maHasValue, JSON.stringify(maLast));

  const volLast = c4?.inds?.['ind_VOL']?.last;
  log(
    '4h 当前根 VOL 指标有值',
    !!volLast && typeof volLast === 'object' && typeof volLast.volume === 'number',
    JSON.stringify(volLast),
  );

  log('练习起点标记可见', await page.evaluate(() => !!document.querySelector('.start-marker')));

  // 切到 1h
  await page.evaluate(() => {
    [...document.querySelectorAll('.period-tab')].find((x) => x.textContent.trim().startsWith('1h'))?.click();
  });
  await sleep(1800);

  const c1 = await readChart(page);
  log(
    '1h 喂入足够预热历史（≥240 根 1h）',
    (c1?.dataLen ?? 0) >= 241,
    `${c1?.dataLen} 根 1h`,
  );
  const ma1 = c1?.inds?.['ind_MA']?.last;
  log(
    '1h 当前根 MA 指标有值',
    !!ma1 && Object.values(ma1).some((v) => typeof v === 'number'),
    JSON.stringify(ma1),
  );
  log(
    '1h 可见根数被压到预热窗口量级（barSpace 变小）',
    (c1?.barSpace ?? 99) < (c4?.barSpace ?? 0),
    `4h=${c4?.barSpace?.toFixed(2)} → 1h=${c1?.barSpace?.toFixed(2)}`,
  );

  console.log('\n═══ ② 绿涨红跌 ═══');

  const colors = await page.evaluate(() => ({
    chartUp: window.__klineChart.getStyles().candle.bar.upColor.toLowerCase(),
    chartDown: window.__klineChart.getStyles().candle.bar.downColor.toLowerCase(),
    cssUp: getComputedStyle(document.documentElement).getPropertyValue('--up').trim().toLowerCase(),
    cssDown: getComputedStyle(document.documentElement).getPropertyValue('--down').trim().toLowerCase(),
  }));
  log('图表 K 线涨=绿', colors.chartUp === '#0ecb81', colors.chartUp);
  log('图表 K 线跌=红', colors.chartDown === '#f6465d', colors.chartDown);
  log('CSS --up = 绿', colors.cssUp === '#0ecb81', colors.cssUp);
  log('CSS --down = 红', colors.cssDown === '#f6465d', colors.cssDown);

  // 涨跌文字颜色也要跟着变（当前那根可能是跌的，页面上未必有 .up 元素，
  // 所以临时插入两个探针元素直接问 computed style）
  const textTone = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const read = (cls) => {
      probe.className = `ohlc-value ${cls}`;
      return getComputedStyle(probe).color;
    };
    const up = read('up');
    const down = read('down');
    probe.remove();
    return { up, down };
  });
  log('涨值文字为绿', textTone.up === 'rgb(14, 203, 129)', String(textTone.up));
  log('跌值文字为红', textTone.down === 'rgb(246, 70, 93)', String(textTone.down));

  console.log('\n═══ ③ 播放配置折叠 + 按钮放大 ═══');

  const speedBefore = await page.evaluate(() => document.querySelectorAll('.speed-group .btn').length);
  log('未播放时速度配置隐藏', speedBefore === 0, `${speedBefore} 个按钮`);

  await page.click('.btn-play');
  await sleep(700);
  const speedAfter = await page.evaluate(() => document.querySelectorAll('.speed-group .btn').length);
  log('点击播放后速度配置展开', speedAfter === 4, `${speedAfter} 个按钮`);

  await page.click('.btn-play'); // 暂停
  await sleep(600);
  const speedPaused = await page.evaluate(() => document.querySelectorAll('.speed-group .btn').length);
  log('暂停后速度配置收起', speedPaused === 0, `${speedPaused} 个按钮`);

  const btnSizes = await page.evaluate(() => {
    const sel = ['.replay-btns .btn'];
    const out = [];
    for (const b of document.querySelectorAll('.replay-btns .btn')) {
      const r = b.getBoundingClientRect();
      out.push({ text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
  });
  log('回放条有 5 个按钮', btnSizes.length === 5, JSON.stringify(btnSizes.map((b) => b.text)));
  log(
    '前进/后退按钮已放大（高度 ≥38px）',
    btnSizes.every((b) => b.h >= 38),
    btnSizes.map((b) => `${b.text}:${b.w}x${b.h}`).join(' '),
  );

  console.log('\n═══ ④ 点击 K 线显示详细数据 ═══');

  const box = await page.evaluate(() => {
    const r = document.querySelector('.chart-canvas').getBoundingClientRect();
    return { l: r.left, t: r.top, w: r.width, h: r.height };
  });

  // 4.1 悬停跟随：不同 x 应该落到不同 K 线
  const hoverTs = new Set();
  for (const frac of [0.25, 0.4, 0.55, 0.7, 0.85]) {
    await page.mouse.move(box.l + box.w * frac, box.t + box.h * 0.3);
    await sleep(220);
    const o = await readOhlc(page);
    if (o?.ts) hoverTs.add(o.ts);
  }
  log('悬停跟随鼠标（不同位置命中不同 K 线）', hoverTs.size >= 3, `命中 ${hoverTs.size} 根`);

  // 4.2 点击锁定：点 3 个不同位置，每次锁定的 K 线应不同
  const lockedTs = [];
  for (const frac of [0.3, 0.55, 0.8]) {
    await page.mouse.move(box.l + box.w * frac, box.t + box.h * 0.3);
    await sleep(200);
    await page.mouse.down();
    await sleep(40);
    await page.mouse.up();
    await sleep(450);
    const o = await readOhlc(page);
    if (o?.locked && o?.ts) lockedTs.push(o.ts);
  }
  log('点击 K 线成功锁定', lockedTs.length === 3, `锁定 ${lockedTs.length} 次`);
  log('锁定的 K 线各不相同', new Set(lockedTs).size === 3, JSON.stringify(lockedTs));
  log('锁定标记（竖线）出现', await page.evaluate(() => !!document.querySelector('.pin-marker')));

  // 4.3 锁定的详情与该根 K 线数据一致（用 chart 反查同一时间戳的开盘价）
  const consistency = await page.evaluate(() => {
    const chart = window.__klineChart;
    const list = chart.getDataList();
    const strip = document.querySelector('.ohlc-strip');
    const ts = Number(strip?.querySelector('.ohlc-time')?.getAttribute('data-ts'));
    const bar = list.find((b) => b.timestamp === ts);
    const cells = Object.fromEntries(
      [...strip.querySelectorAll('.ohlc-cell')].map((c) => [
        c.querySelector('.ohlc-label')?.textContent?.trim(),
        c.querySelector('.ohlc-value')?.textContent?.trim(),
      ]),
    );
    return { ts, barOpen: bar?.open, barClose: bar?.close, cells };
  });
  const num = (s) => Number(String(s ?? '').replace(/,/g, ''));
  log(
    '详情数据与被锁 K 线一致（开/收）',
    Math.abs(num(consistency.cells['开']) - (consistency.barOpen ?? -1)) < 0.01 &&
      Math.abs(num(consistency.cells['收']) - (consistency.barClose ?? -1)) < 0.01,
    `详情 开=${consistency.cells['开']} 收=${consistency.cells['收']} / 实际 开=${consistency.barOpen} 收=${consistency.barClose}`,
  );

  const detailFields = ['开', '高', '低', '收', '涨跌', '振幅', '量', '额'];
  const missing = detailFields.filter((f) => !consistency.cells[f]);
  log('详情含完整字段', missing.length === 0, `缺=${missing.join(',') || '无'}`);

  // 4.4 点副图区（不是 K 线）→ 解除锁定
  await page.mouse.move(box.l + box.w * 0.5, box.t + box.h * 0.88);
  await sleep(200);
  await page.mouse.down();
  await sleep(40);
  await page.mouse.up();
  await sleep(450);
  const afterBlank = await readOhlc(page);
  log('点非 K 线区域解除锁定', !afterBlank?.locked, `locked=${afterBlank?.locked}`);

  // 4.5 ESC 也能解除
  await page.mouse.move(box.l + box.w * 0.5, box.t + box.h * 0.3);
  await sleep(200);
  await page.mouse.down();
  await sleep(40);
  await page.mouse.up();
  await sleep(400);
  await page.keyboard.press('Escape');
  await sleep(400);
  const afterEsc = await readOhlc(page);
  log('ESC 解除锁定', !afterEsc?.locked, `locked=${afterEsc?.locked}`);

  console.log('\n═══ ⑤ 回看不破坏图表 ═══');
  await page.evaluate(() => {
    const input = document.querySelector('.jump-row input.tiny-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '60');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(1500);
  const back = await readChart(page);
  log('回看时图表仍有数据', (back?.dataLen ?? 0) > 0, `${back?.dataLen} 根`);
  const maBack = back?.inds?.['ind_MA']?.last;
  log(
    '回看时指标仍有值',
    !!maBack && Object.values(maBack).some((v) => typeof v === 'number'),
    JSON.stringify(maBack),
  );

  await page.screenshot({ path: path.join(OUT, 'v5-features.png') });

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
  if (errors.length) {
    console.log('  ⚠️ JS 错误：');
    for (const e of errors.slice(0, 6)) console.log('    ' + e);
  } else {
    console.log('  ✅ 无 JS 错误');
  }
  if (fail > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
