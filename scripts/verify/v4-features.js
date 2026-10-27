/**
 * v4 增量功能验证：
 *   ① 4h/1h 单图切换（同屏只有一个图表，Tab 来回切）
 *   ② K 线后退（后退一根 / 退一根4h / 回看模式）
 *   ③ 点击 K 线显示详细数据（OHLC 条 + 锁定）
 *   ④ 币安风格配色
 *
 * 依赖 ChartPanel 暴露的 window.__klineChart 测试钩子：
 * 用 convertToPixel 把「时间戳 + 价格」换算成页面坐标，做真实像素级点击。
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

/** 读取 OHLC 条内容 */
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

/** 读回放游标（replay-count 文本 "N / total"） */
async function readCursor(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.replay-count');
    if (!el) return null;
    const m = el.textContent.match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { cursor: Number(m[1]), total: Number(m[2]), lookback: !!el.querySelector('.lookback-badge') } : null;
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

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(6000);

  // 清掉上一轮遗留的 localStorage，保证从默认状态开始
  await page.evaluate(() => localStorage.removeItem('kline-practice-v1'));
  await page.reload({ waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(6000);

  /* ==================== ① 单图 + 4h/1h 切换 ==================== */
  console.log('\n═══ ① 4h/1h 单图切换 ═══');

  const chartCount = await page.evaluate(
    () => document.querySelectorAll('.chart-canvas').length,
  );
  log('同屏只有一个图表容器', chartCount === 1, `chart-canvas=${chartCount}`);

  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('.period-tab')].map((b) => ({
      text: b.textContent.trim(),
      selected: b.getAttribute('aria-selected'),
      active: b.classList.contains('active'),
    })),
  );
  // v6 起周期档位从 2 档（4h/1h）扩到 3 档（15m/1h/4h），
  // 且默认档位从 4h 改为 1h（需求：默认显示 1h，往左 15m，往右 4h）。
  log(
    '周期 Tab 为 15m / 1h / 4h 三项（从左到右 = 更细 → 更粗）',
    tabs.length === 3 &&
      tabs[0].text.startsWith('15m') &&
      tabs[1].text.startsWith('1h') &&
      tabs[2].text.startsWith('4h'),
    JSON.stringify(tabs),
  );
  log('默认停在 1h 入场', tabs[1].selected === 'true' && tabs[1].active, JSON.stringify(tabs[1]));

  const periodLabel4h = await page.evaluate(
    () => document.querySelector('.market-period')?.textContent?.trim(),
  );
  log('行情头显示当前周期 1h', periodLabel4h === '1h', String(periodLabel4h));

  // 切到 1h
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.period-tab')].find((x) =>
      x.textContent.trim().startsWith('1h'),
    );
    b?.click();
  });
  await sleep(1500);
  const after1h = await page.evaluate(() => ({
    period: document.querySelector('.market-period')?.textContent?.trim(),
    selected: [...document.querySelectorAll('.period-tab')].map(
      (b) => b.getAttribute('aria-selected'),
    ),
    canvases: document.querySelectorAll('.chart-canvas canvas').length,
    chartCount: document.querySelectorAll('.chart-canvas').length,
    hook: !!window.__klineChart,
  }));
  log('切到 1h 后仍是单图', after1h.chartCount === 1 && after1h.canvases > 0, JSON.stringify(after1h));
  log('Tab 选中态跟随切换', after1h.selected[0] === 'false' && after1h.selected[1] === 'true', JSON.stringify(after1h.selected));
  log('行情头周期更新为 1h', after1h.period === '1h', String(after1h.period));

  // 切回 4h
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.period-tab')].find((x) =>
      x.textContent.trim().startsWith('4h'),
    );
    b?.click();
  });
  await sleep(1200);
  const back4h = await page.evaluate(
    () => document.querySelector('.market-period')?.textContent?.trim(),
  );
  log('可切回 4h', back4h === '4h', String(back4h));

  const persistedPeriod = await page.evaluate(() => {
    const raw = localStorage.getItem('kline-practice-v1');
    return raw ? JSON.parse(raw).state.chartPeriod : null;
  });
  log('当前周期已持久化', persistedPeriod === '4h', String(persistedPeriod));

  /* ==================== ② 后退 ==================== */
  console.log('\n═══ ② K 线后退 ═══');

  // v6.3 起，**单步步长跟随当前图表周期**（15m / 1h / 4h）。
  // 上面 ① 段结束时周期停在 4h ⇒ 「后退一根」会退 4 根 1h，
  // 而本段的断言语义是「退 1 根 1h / 退 4 根 / 前进 5 次回到最远」——
  // 必须先切到 1h 档，断言才有确定含义。
  //
  // （v4 时代只有 4h/1h 两档且步长与周期无关；v6.3 之后不指定档位就是含糊的。）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.period-tab')].find(
      (x) => x.querySelector('.period-main')?.textContent.trim() === '1h',
    );
    b?.click();
  });
  await sleep(1400);

  const c0 = await readCursor(page);
  log('初始游标可读', !!c0, JSON.stringify(c0));

  const backBtns = await page.evaluate(() =>
    [...document.querySelectorAll('.replay-controls .btn')].map((b) => b.textContent.trim()),
  );
  log(
    '回放条有「后退」与「退4h」按钮',
    backBtns.some((t) => t.includes('后退')) && backBtns.some((t) => t.includes('退4h')),
    JSON.stringify(backBtns),
  );

  // 后退一根
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.replay-controls .btn')].find((x) =>
      x.textContent.includes('后退'),
    );
    b?.click();
  });
  await sleep(900);
  const c1 = await readCursor(page);
  log('后退一根：游标 -1', c1 && c0 && c1.cursor === c0.cursor - 1, `${c0?.cursor} → ${c1?.cursor}`);

  const timeAfterBack = await page.evaluate(
    () => document.querySelector('.stat-chip-time strong')?.textContent?.trim(),
  );
  log('顶栏时间同步回退', !!timeAfterBack, String(timeAfterBack));

  // 回看模式徽标 + 禁止开仓
  const lookbackState = await page.evaluate(() => ({
    badge: !!document.querySelector('.lookback-badge'),
    tradeDisabled: document.querySelector('.trade-open-trigger')?.disabled ?? null,
    tradeNote: document.querySelector('.trade-trigger-note')?.textContent?.trim() ?? '',
  }));
  log('进入回看模式（出现徽标）', lookbackState.badge, JSON.stringify(lookbackState));
  log('回看时禁止开仓', lookbackState.tradeDisabled === true, lookbackState.tradeNote);

  // 退一根 4h
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.replay-controls .btn')].find((x) =>
      x.textContent.includes('退4h'),
    );
    b?.click();
  });
  await sleep(1200);
  const c2 = await readCursor(page);
  log('退一根 4h：游标 -4', c2 && c1 && c2.cursor === c1.cursor - 4, `${c1?.cursor} → ${c2?.cursor}`);

  // 前进回来 —— 游标回到最远处应退出回看模式
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.replay-controls .btn')].find((x) =>
        x.textContent.includes('单步'),
      );
      b?.click();
    });
    await sleep(320);
  }
  await sleep(700);
  const c3 = await readCursor(page);
  log('前进可回到最远处', c3 && c0 && c3.cursor === c0.cursor, `${c2?.cursor} → ${c3?.cursor}`);
  log('回到最远处后退出回看模式', c3 && c3.lookback === false, JSON.stringify(c3));

  /* ==================== ③ 点击 K 线详情 ==================== */
  console.log('\n═══ ③ 点击 K 线显示详情 ═══');

  const defaultOhlc = await readOhlc(page);
  log(
    'OHLC 条默认显示最新一根',
    !!defaultOhlc && !!defaultOhlc.ts && !!defaultOhlc.byLabel?.['开'],
    JSON.stringify(defaultOhlc?.byLabel),
  );

  const chartBox = await page.evaluate(() => {
    const el = document.querySelector('.chart-canvas');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  log('图表画布可定位', !!chartBox && chartBox.width > 200, JSON.stringify(chartBox));

  // 在图上横向扫若干位置，找到一根「实体够高」的 K 线（保证能点到矩形本体）
  let picked = null;
  for (const frac of [0.88, 0.82, 0.76, 0.7, 0.64, 0.58, 0.52]) {
    const mx = chartBox.x + chartBox.width * frac;
    const my = chartBox.y + chartBox.height * 0.5;
    await page.mouse.move(mx, my);
    await sleep(260);
    const o = await readOhlc(page);
    if (!o || !o.ts) continue;
    const open = Number(String(o.byLabel['开']).replace(/,/g, ''));
    const close = Number(String(o.byLabel['收']).replace(/,/g, ''));
    if (Number.isFinite(open) && Number.isFinite(close) && Math.abs(open - close) > 0) {
      picked = { ts: o.ts, open, close, timeText: o.timeText };
      break;
    }
  }
  log('悬停可定位到某根 K 线', !!picked, JSON.stringify(picked));

  // 用 convertToPixel 算出该根 K 线实体中心点的页面坐标，做真实点击
  const pt = await page.evaluate(
    ({ ts, mid }) => {
      const chart = window.__klineChart;
      if (!chart) return null;
      const px = chart.convertToPixel({ timestamp: ts, value: mid }, { absolute: true });
      const r = document.querySelector('.chart-canvas').getBoundingClientRect();
      return { x: r.left + px.x, y: r.top + px.y };
    },
    { ts: picked?.ts, mid: picked ? (picked.open + picked.close) / 2 : 0 },
  );
  log('可换算出 K 线像素坐标', !!pt && Number.isFinite(pt.x), JSON.stringify(pt));

  if (pt) {
    await page.mouse.move(pt.x, pt.y);
    await sleep(200);
    await page.mouse.click(pt.x, pt.y);
    await sleep(700);
  }

  const clicked = await readOhlc(page);
  log('点击后锁定该根 K 线', !!clicked?.locked, JSON.stringify({ locked: clicked?.locked, ts: clicked?.ts }));
  log('锁定标记出现（竖线）', await page.evaluate(() => !!document.querySelector('.pin-marker')));

  const num = (s) => Number(String(s ?? '').replace(/,/g, ''));
  const clickOk =
    !!clicked &&
    !!picked &&
    clicked.ts === picked.ts &&
    Math.abs(num(clicked.byLabel['开']) - picked.open) < 0.01 &&
    Math.abs(num(clicked.byLabel['收']) - picked.close) < 0.01;
  log(
    '详情数据与被点 K 线一致（开/收）',
    clickOk,
    `点的是 ${picked?.timeText} / 详情开=${clicked?.byLabel?.['开']} 收=${clicked?.byLabel?.['收']}`,
  );

  const detailFields = ['开', '高', '低', '收', '涨跌', '振幅', '量', '额'];
  const missing = detailFields.filter((f) => !clicked?.byLabel?.[f]);
  log('详情含完整字段（开高低收/涨跌/振幅/量/额）', missing.length === 0, `缺=${missing.join(',') || '无'}`);

  // 解除锁定：v5 起改为「点空白 / ESC」，不再是「再点同一根」
  // （klinecharts 一次物理点击会派发两次，toggle 语义会被自己抵消）
  if (pt) {
    const box = await page.evaluate(() => {
      const r = document.querySelector('.chart-canvas').getBoundingClientRect();
      return { l: r.left, t: r.top, w: r.width, h: r.height };
    });
    await page.mouse.click(box.l + box.w * 0.5, box.t + box.h * 0.88);
    await sleep(600);
  }
  const unlocked = await readOhlc(page);
  log('点非 K 线区域解除锁定', !!unlocked && unlocked.locked === false, JSON.stringify({ locked: unlocked?.locked }));

  await page.screenshot({ path: path.join(OUT, 'v4-click-detail.png') });

  /* ==================== ④ 币安风格 ==================== */
  console.log('\n═══ ④ 币安风格配色 ═══');

  const palette = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const pick = (n) => cs.getPropertyValue(n).trim();
    const primary = document.querySelector('.btn.primary');
    const head = document.querySelector('.market-head');
    const chartPanel = document.querySelector('.chart-panel');
    return {
      up: pick('--up'),
      down: pick('--down'),
      accent: pick('--accent'),
      bg: pick('--bg'),
      panel: pick('--bg-panel'),
      primaryBg: primary ? getComputedStyle(primary).backgroundColor : null,
      primaryColor: primary ? getComputedStyle(primary).color : null,
      headBg: head ? getComputedStyle(head).backgroundColor : null,
      panelBg: chartPanel ? getComputedStyle(chartPanel).backgroundColor : null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  log('涨=绿 #0ecb81', palette.up.toLowerCase() === '#0ecb81', palette.up);
  log('跌=红 #f6465d', palette.down.toLowerCase() === '#f6465d', palette.down);
  log('强调色=币安黄 #fcd535', palette.accent.toLowerCase() === '#fcd535', palette.accent);
  log('背景=深色 #0b0e11', palette.bodyBg === 'rgb(11, 14, 17)', palette.bodyBg);
  log('主按钮=黄底黑字', palette.primaryBg === 'rgb(252, 213, 53)' && palette.primaryColor === 'rgb(24, 26, 32)', `${palette.primaryBg} / ${palette.primaryColor}`);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  log('桌面端无横向溢出', overflow === false, `overflow=${overflow}`);

  await page.screenshot({ path: path.join(OUT, 'v4-binance-style.png') });

  /* ==================== JS 错误 ==================== */
  console.log('\n═══ JS 错误 ═══');
  log('无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('\n══════════════════════════════════════════');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('══════════════════════════════════════════');
  process.exitCode = fail > 0 ? 1 : 0;
} catch (err) {
  console.error('验证脚本异常：', err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
