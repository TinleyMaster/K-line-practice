/**
 * v6.3 图表交互验证（浏览器层）：
 *   ① 切周期时 K 线**像素级对齐**（1h ↔ 4h 严格，15m 右端锚定）
 *   ② 单步前进/后退的**步长跟随当前图表周期**
 *   ③ 图表高度与详情条布局（不重叠）
 *   ④ 副图上限 4 个
 *
 * 为什么必须浏览器实测、不能靠读代码断言：
 *   「对齐」是**像素级**命题 —— klinecharts 的 x 轴按索引等距排布，
 *   同一时刻落在同一像素这件事，只有真的渲染出来量 x 坐标才算数。
 *   读代码只能证明「公式对」，证明不了「画出来对」。
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

/** 切到某个周期（点 tab），等图表重建完成 */
async function switchPeriod(page, label) {
  await page.evaluate((l) => {
    const tab = [...document.querySelectorAll('.period-tab')].find(
      (e) => e.querySelector('.period-main')?.textContent.trim() === l && !e.disabled,
    );
    tab?.click();
  }, label);
  // 等图表数据重建（barSpace / resetData 都要时间）
  await page.waitForFunction(
    (l) => {
      const el = document.querySelector('.period-tab.active .period-main');
      return el && el.textContent.trim() === l && !!window.__klineChart;
    },
    { timeout: 15000 },
    label,
  );
  await sleep(1200);
}

/** 取一组时间戳在当前图表上的 x 像素 */
async function xOf(page, timestamps) {
  return page.evaluate((ts) => {
    const chart = window.__klineChart;
    if (!chart) return null;
    const out = {};
    for (const t of ts) {
      try {
        const px = chart.convertToPixel({ timestamp: t }, { absolute: true });
        out[t] = typeof px?.x === 'number' && Number.isFinite(px.x) ? px.x : null;
      } catch {
        out[t] = null;
      }
    }
    return out;
  }, timestamps);
}

/** 读图表的最后一根 + 根数 */
async function chartTail(page) {
  return page.evaluate(() => {
    const chart = window.__klineChart;
    if (!chart) return null;
    const list = chart.getDataList();
    return {
      len: list.length,
      last: list[list.length - 1]?.timestamp ?? null,
      first: list[0]?.timestamp ?? null,
    };
  });
}

/** 读 store 状态 */
async function storeState(page) {
  return page.evaluate(() => {
    const s = window.__practiceStore?.getState?.();
    if (!s) return null;
    return { cursor: s.cursor, cursorMs: s.cursorMs, chartPeriod: s.chartPeriod };
  });
}

/** 点「单步前进」按钮 */
async function clickStep(page) {
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.replay-btns .btn-step')];
    // .btn-step 只有 4 个：退4h / 后退 / 单步 / 4h跳（播放按钮没有 btn-step）
    btns[2]?.click();
  });
  await sleep(700);
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

  // ══════════════════════════════════════════════════════════════
  console.log('\n═══ ① 切周期 K 线对齐（像素级）═══');

  // 锚点：当前时刻（图表最后一根）
  await switchPeriod(page, '1h');
  const t1h = await chartTail(page);
  const now = t1h?.last;
  log('1h 档有数据', (t1h?.len ?? 0) > 0, `${t1h?.len} 根，末=${new Date(now).toISOString()}`);

  // 取三个采样时刻：当前、-100h、-200h（都在 240h 窗口内）
  const probes = [now, now - 100 * 3600000, now - 200 * 3600000];

  const x1h = await xOf(page, probes);

  await switchPeriod(page, '4h');
  const t4h = await chartTail(page);
  const x4h = await xOf(page, probes);

  log(
    '4h 档有数据',
    (t4h?.len ?? 0) > 0,
    `${t4h?.len} 根，末=${new Date(t4h?.last).toISOString()}`,
  );

  // 4h 实际柱宽（一根 4h K 线的像素宽）—— 用作「有界对齐」容差的基准。
  // 1h↔4h 的真实对齐保证是：右端锚点（当前时刻）严格同像素，
  // 历史任意时刻偏差 ≤ 一根 4h 柱宽（4h 离散化在 cursor 处于 4h 桶内任意相位时的固有上界）。
  const bs4x = await xOf(page, [t4h.last, t4h.last - 14400000]);
  const bs4 =
    bs4x?.[t4h.last] != null && bs4x?.[t4h.last - 14400000] != null
      ? Math.abs(bs4x[t4h.last] - bs4x[t4h.last - 14400000])
      : 16;
  const ALIGN_TOL_HIST = bs4 + 3; // 历史探针容差 = 一根 4h 柱宽 + 余量

  // 1h ↔ 4h 对齐：右端锚点（=now）必须严格同像素（绝不泄露未来的铁律）；
  // 历史时刻偏差受 4h 离散化约束，只需 ≤ 一根 4h 柱宽（非回归，物理上无法更严——
  // 因 4h 桶按 epoch 对齐、末桶起点与 cursor 差 0~3h 相位，两档 x 轴为同斜率平行线，
  // 历史偏差恒等于 相位×1h柱宽，最大即一根 4h 柱宽）。
  for (const t of probes) {
    const a = x1h?.[t];
    const b = x4h?.[t];
    const diff = a != null && b != null ? Math.abs(a - b) : null;
    const isRightEdge = t === now;
    const ok = diff !== null && (isRightEdge ? diff <= 3 : diff <= ALIGN_TOL_HIST);
    log(
      `1h ↔ 4h 同一时刻 x 对齐（${new Date(t).toISOString().slice(0, 16)}）${isRightEdge ? '【右端锚定·严格】' : `【≤${ALIGN_TOL_HIST.toFixed(0)}px】`}`,
      ok,
      `1h=${a?.toFixed(1)} 4h=${b?.toFixed(1)} Δ=${diff?.toFixed(2)}px（4h柱宽=${bs4.toFixed(1)}）`,
    );
  }

  // 两档的最后一根应当是「同一时刻」（当前时刻所在的那一根）
  log(
    '1h 与 4h 的最后一根是同一时刻（右端锚定）',
    t1h?.last != null && t4h?.last != null && Math.abs(t1h.last - t4h.last) < 4 * 3600000,
    `1h=${new Date(t1h?.last).toISOString()} 4h=${new Date(t4h?.last).toISOString()}`,
  );

  // 15m：右端锚定 —— 15m 最后一根的 x 应与 1h 最后一根的 x 落在同一像素
  await switchPeriod(page, '15m');
  const t15 = await chartTail(page);
  const x15 = await xOf(page, [t15?.last]);
  const x15now = await xOf(page, [now]);
  log(
    '15m 档有数据',
    (t15?.len ?? 0) > 0,
    `${t15?.len} 根，末=${new Date(t15?.last).toISOString()}`,
  );
  log(
    '15m 右端锚定当前时刻（与 1h/4h 同一像素）',
    x15now?.[now] != null && x1h?.[now] != null && Math.abs(x15now[now] - x1h[now]) <= 3,
    `15m=${x15now?.[now]?.toFixed(1)} 1h=${x1h?.[now]?.toFixed(1)}`,
  );
  log(
    '15m 最后一根的 x 与「当前时刻」的 x 一致（15m 右端 = 当前时刻那一根）',
    x15?.[t15?.last] != null && x15now?.[now] != null && Math.abs(x15[t15.last] - x15now[now]) <= 3,
    `末根x=${x15?.[t15?.last]?.toFixed(1)} 当前x=${x15now?.[now]?.toFixed(1)}`,
  );

  // ══════════════════════════════════════════════════════════════
  console.log('\n═══ ② 单步步长跟随当前周期 ═══');

  // 15m 档：单步 = +15min，cursor（1h 索引）不动
  await switchPeriod(page, '15m');
  const before = await storeState(page);
  await clickStep(page);
  const after = await storeState(page);
  const d15 = before && after ? after.cursorMs - before.cursorMs : null;
  log(
    '15m 档单步 = 前进 15 分钟',
    d15 === 900000,
    `ΔcursorMs=${d15}（${d15 === 900000 ? '+15m' : '异常'}）`,
  );
  log(
    '15m 档单步不推进 1h 引擎（引擎仍是 1h 粒度）',
    before && after && after.cursor === before.cursor,
    `cursor ${before?.cursor} → ${after?.cursor}`,
  );

  // 1h 档：单步 = +1 根 1h
  await switchPeriod(page, '1h');
  const b1 = await storeState(page);
  await clickStep(page);
  const a1 = await storeState(page);
  const d1 = b1 && a1 ? a1.cursorMs - b1.cursorMs : null;
  log('1h 档单步 = 前进 1 小时', d1 === 3600000, `ΔcursorMs=${d1}`);
  log('1h 档单步同时推进 1h 引擎', b1 && a1 && a1.cursor === b1.cursor + 1, `cursor ${b1?.cursor} → ${a1?.cursor}`);

  // 4h 档：单步 = +4 小时
  await switchPeriod(page, '4h');
  const b4 = await storeState(page);
  await clickStep(page);
  const a4 = await storeState(page);
  const d4 = b4 && a4 ? a4.cursorMs - b4.cursorMs : null;
  log('4h 档单步 = 前进 4 小时', d4 === 4 * 3600000, `ΔcursorMs=${d4}`);
  log('4h 档单步推进 4 根 1h 引擎', b4 && a4 && a4.cursor === b4.cursor + 4, `cursor ${b4?.cursor} → ${a4?.cursor}`);

  // 后退同理
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.replay-btns .btn-step')];
    btns[1]?.click(); // 后退
  });
  await sleep(700);
  const a4b = await storeState(page);
  log(
    '4h 档后退 = 后退 4 小时',
    a4 && a4b && a4b.cursorMs - a4.cursorMs === -4 * 3600000,
    `ΔcursorMs=${a4b?.cursorMs - a4?.cursorMs}`,
  );

  // 「4h ⏩」快捷键也必须同步 cursorMs ——
  //   踩过的坑：jump4h 直接调引擎的 advance1h（只动 1h 索引），
  //   不同步 cursorMs ⇒ 15m 档右端停滞 + 下一次单步步长错乱。
  const bJ = await storeState(page);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.replay-btns .btn-step')];
    btns[3]?.click(); // 4h 跳
  });
  await sleep(900);
  const aJ = await storeState(page);
  log(
    '「4h ⏩」快捷键同步推进 cursorMs 4 小时',
    bJ && aJ && aJ.cursorMs - bJ.cursorMs === 4 * 3600000,
    `ΔcursorMs=${aJ?.cursorMs - bJ?.cursorMs}`,
  );

  // ══════════════════════════════════════════════════════════════
  console.log('\n═══ ③ 图表高度 + 详情条不重叠 ═══');

  const h = await page.evaluate(() => {
    const el = document.querySelector('.chart-canvas');
    return el ? el.getBoundingClientRect().height : 0;
  });
  log('图表高度 ≥ 420px（v6.3 加高）', h >= 420, `${h.toFixed(0)}px`);

  // 详情条：所有 cell 两两不重叠（矩形相交检测）
  const overlap = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.ohlc-strip .ohlc-cell, .ohlc-strip .ohlc-time')];
    const rects = cells.map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const hits = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) hits.push([i, j, Math.round(ox), Math.round(oy)]);
      }
    }
    return { count: rects.length, hits };
  });
  log(
    'K线详情条各项互不重叠',
    overlap.hits.length === 0,
    `${overlap.count} 项，重叠 ${overlap.hits.length} 处${overlap.hits.length ? ' ' + JSON.stringify(overlap.hits.slice(0, 3)) : ''}`,
  );

  // ══════════════════════════════════════════════════════════════
  console.log('\n═══ ④ 副图上限 4 个 ═══');

  // 副图数量：用指标实例的 paneId 去重（getPanes 不是公开 API）
  const paneInfo = await page.evaluate(() => {
    const chart = window.__klineChart;
    if (!chart) return null;
    const ids = new Set();
    for (const ind of chart.getIndicators?.() ?? []) {
      if (ind.paneId) ids.add(ind.paneId);
    }
    return { paneCount: ids.size, indicatorCount: (chart.getIndicators?.() ?? []).length };
  });
  log(
    '图表存在指标实例（主图 + 副图）',
    (paneInfo?.indicatorCount ?? 0) >= 1,
    `${paneInfo?.indicatorCount} 个指标 / ${paneInfo?.paneCount} 个 pane`,
  );

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('技术指标'));
    btn?.click();
  });
  await sleep(900);
  const paneCountText = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.ind-group-title')].find((e) => e.textContent.includes('独立副图'));
    return t ? t.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  log('指标面板声明副图上限为 4', /最多常驻 4 个/.test(paneCountText ?? ''), paneCountText ?? '(未找到)');

  // 逐个勾选副图（每次点击后等 React 重渲染，否则 disabled 状态来不及更新；
  // 且必须检查 checked —— disabled 的 checkbox 点击是无声的，
  // 只数「点了几次」会把被拦下的那次也算进去）
  const added = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const paneItems = [...document.querySelectorAll('.ind-item')].filter((i) =>
      i.closest('.ind-group')?.textContent.includes('独立副图'),
    );
    let checkedCount = 0;
    let blockedAt = -1;
    for (let i = 0; i < paneItems.length; i++) {
      const cb = paneItems[i].querySelector('input[type=checkbox]');
      if (!cb) continue;
      if (cb.disabled) {
        if (blockedAt < 0) blockedAt = i;
        continue;
      }
      cb.click();
      await sleep(150);
      if (cb.checked) checkedCount++;
    }
    return { total: paneItems.length, checkedCount, blockedAt };
  });
  await sleep(1200);
  log(
    '实际勾上的副图恰好 4 个',
    added.checkedCount === 4,
    `总 ${added.total} 项，实际勾选 ${added.checkedCount} 个，第 ${added.blockedAt + 1} 项起被禁`,
  );
  log(
    '第 5 个副图被置灰禁用',
    added.blockedAt >= 0,
    added.blockedAt >= 0 ? `第 ${added.blockedAt + 1} 项 disabled` : '没有禁用项（异常）',
  );

  // 加了 4 个副图后，主图仍要有足够高度（不能被挤没）
  await sleep(1200);
  const mainH = await page.evaluate(() => {
    const chart = window.__klineChart;
    if (!chart) return null;
    const size = chart.getSize?.('candle_pane');
    return size?.height ?? null;
  });
  log('4 副图下主图高度 ≥ 150px', (mainH ?? 0) >= 150, `主图 ${mainH?.toFixed?.(0) ?? '?'}px`);

  await page.screenshot({ path: path.join(OUT, 'v6-align.png') });

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
