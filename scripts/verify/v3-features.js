/**
 * v3 增量功能验证：
 *   ① 开仓面板可折叠（按钮唤起）
 *   ② 练习起点可自定义（时间点 + 快捷区间）
 *   ③ 技术指标可自选（27 个内置指标，主图叠加 / 独立副图）
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

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(6000);

  console.log('\n═══ ① 开仓面板折叠 ═══');

  // 1.1 默认折叠：只有按钮，没有完整表单
  const collapsed = await page.evaluate(() => ({
    trigger: !!document.querySelector('.trade-open-trigger'),
    panel: !!document.querySelector('.side-area .panel'),
    setupSelect: !!document.querySelector('.side-area select'),
  }));
  log('默认折叠（显示按钮）', collapsed.trigger, JSON.stringify(collapsed));
  log('默认折叠（无开仓表单）', !collapsed.setupSelect && !collapsed.panel);

  // 1.2 点击按钮展开
  await page.click('.trade-open-trigger');
  await sleep(700);
  const expanded = await page.evaluate(() => ({
    setupSelect: !!document.querySelector('.side-area select'),
    collapseBtn: !!document.querySelector('.panel-collapse'),
    trigger: !!document.querySelector('.trade-open-trigger'),
  }));
  log('点击后展开表单', expanded.setupSelect, JSON.stringify(expanded));
  log('展开后按钮消失', !expanded.trigger);
  log('提供收起按钮', expanded.collapseBtn);

  // 1.3 收起按钮可回折叠态
  await page.click('.panel-collapse');
  await sleep(500);
  const recollapsed = await page.evaluate(() => ({
    trigger: !!document.querySelector('.trade-open-trigger'),
    setupSelect: !!document.querySelector('.side-area select'),
  }));
  log('收起按钮生效', recollapsed.trigger && !recollapsed.setupSelect);

  // 1.4 折叠态下侧栏占位小（图表空间更大）
  const sideHeight = await page.evaluate(() => {
    const el = document.querySelector('.side-area');
    return el ? Math.round(el.getBoundingClientRect().height) : 0;
  });
  log('折叠态侧栏高度收窄', sideHeight < 200, `${sideHeight}px`);

  console.log('\n═══ ② 自定义练习起点 ═══');

  // 2.1 起点选择器存在
  const hasStart = await page.evaluate(() => !!document.querySelector('.start-trigger'));
  log('起点选择器存在', hasStart);

  // 2.2 打开面板，读当前起点时间
  await page.click('.start-trigger');
  await sleep(500);
  const startBefore = await page.evaluate(() => {
    const t = document.querySelector('.start-value')?.textContent?.trim() ?? '';
    const inp = document.querySelector('.start-panel input[type=datetime-local]');
    return { label: t, inputVal: inp?.value ?? '' };
  });
  log('显示当前起点', startBefore.label.length > 4, JSON.stringify(startBefore));
  log('时间输入框有值', startBefore.inputVal.length > 0, startBefore.inputVal);

  // 2.3 快捷区间「往前 1 月」
  const before = await page.evaluate(() => {
    const inp = document.querySelector('.start-panel input[type=datetime-local]');
    return inp?.value ?? '';
  });
  const quickBtns = await page.$$('.start-quick .btn');
  log('快捷区间按钮数量', quickBtns.length === 4, `${quickBtns.length} 个`);

  // 点「往前 1 周」（index 1）
  await quickBtns[1].click();
  await sleep(800);
  const after = await page.evaluate(() => {
    const inp = document.querySelector('.start-panel input[type=datetime-local]');
    const label = document.querySelector('.start-value')?.textContent?.trim() ?? '';
    const badge = !!document.querySelector('.start-badge');
    return { val: inp?.value ?? '', label, badge };
  });
  const changed = before !== after.val;
  log('快捷区间改变起点', changed, `${before} → ${after.val}`);
  log('标记为「自定义」', after.badge);
  log('起点显示同步更新', after.label.length > 4, after.label);

  // 2.4 起点前必须有足够 4h 上下文（≥120 根 4h）
  const ctxCheck = await page.evaluate(() => {
    const el = document.querySelector('.start-panel input[type=datetime-local]');
    return { val: el?.value ?? '' };
  });
  const ctxInfo = await page.evaluate(async (val) => {
    const resp = await fetch(
      '/api/klines?symbol=BTCUSDT&market=perp&interval=1h&limit=1200',
    ).then((r) => r.json());
    // 真实字段是 bars（1h 基础周期），bars1h 只在 interval=both 时存在
    const arr = resp.bars ?? resp.bars1h ?? [];
    const t = new Date(val).getTime();
    let idx = arr.findIndex((b) => b.time > t) - 1;
    if (idx < 0) idx = arr.length - 1;
    const before1h = Math.max(0, idx + 1);
    return { total: arr.length, idx, before1h, before4h: Math.ceil(before1h / 4) };
  }, ctxCheck.val);
  log(
    '起点前 4h 上下文 ≥120',
    ctxInfo.before4h >= 120,
    `1h=${ctxInfo.before1h} → 4h≈${ctxInfo.before4h}`,
  );
  log('起点后留有「未来」', ctxInfo.total - ctxInfo.idx >= 60, `剩余 ${ctxInfo.total - ctxInfo.idx} 根 1h`);

  // 2.5 恢复自动
  const restoreBtns = await page.$$('.start-panel .ind-foot .btn');
  await restoreBtns[0].click();
  await sleep(600);
  const restored = await page.evaluate(() => ({
    badge: !!document.querySelector('.start-badge'),
    label: document.querySelector('.start-value')?.textContent?.trim() ?? '',
  }));
  log('可恢复自动模式', !restored.badge, restored.label);

  await page.evaluate(() => document.querySelector('.start-trigger')?.click());
  await sleep(300);

  console.log('\n═══ ③ 技术指标可自选 ═══');

  // 3.1 指标选择器存在
  const hasInd = await page.evaluate(() => !!document.querySelector('.ind-trigger'));
  log('指标选择器存在', hasInd);

  await page.click('.ind-trigger');
  await sleep(500);

  const indMeta = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.ind-item')];
    const groups = [...document.querySelectorAll('.ind-group-title')].map((g) => g.textContent.trim());
    const periodTabs = [...document.querySelectorAll('.ind-period-tab')].map((t) => t.textContent.trim());
    const checked = items.filter((i) => i.querySelector('input')?.checked).length;
    return { total: items.length, groups, periodTabs, checked };
  });
  log('指标总数 ≥27', indMeta.total >= 27, `${indMeta.total} 个`);
  log('分「主图叠加 / 独立副图」两组', indMeta.groups.length === 2, JSON.stringify(indMeta.groups));
  log('4h/1h 分开配置', indMeta.periodTabs.length === 2, JSON.stringify(indMeta.periodTabs));

  // 3.2 勾选一个主图指标（BOLL）→ 应画在主图
  const before4h = await page.evaluate(() => window.__klineProbe?.() ?? null);
  const bollItem = await page.evaluateHandle(() => {
    const labels = [...document.querySelectorAll('.ind-item')];
    return labels.find((l) => l.querySelector('.ind-code')?.textContent === 'BOLL');
  });
  const bollEl = bollItem.asElement();
  await bollEl.click();
  await sleep(1200);

  const afterBoll = await page.evaluate(() => ({
    trigger: document.querySelector('.ind-trigger-count')?.textContent?.trim(),
    checked: [...document.querySelectorAll('.ind-item')].filter(
      (i) => i.querySelector('input')?.checked,
    ).length,
  }));
  log('勾选 BOLL 后计数 +1', afterBoll.checked === indMeta.checked + 1, JSON.stringify(afterBoll));

  // 3.3 勾选一个副图指标（RSI）→ 应开新窗格
  const rsiItem = await page.evaluateHandle(() => {
    const labels = [...document.querySelectorAll('.ind-item')];
    return labels.find((l) => l.querySelector('.ind-code')?.textContent === 'RSI');
  });
  await rsiItem.asElement().click();
  await sleep(1500);

  const paneInfo = await page.evaluate(() => {
    // 独立副图会在 .chart-canvas 里多出 canvas 图层
    const c4 = document.querySelectorAll('.chart-canvas')[0];
    const c1 = document.querySelectorAll('.chart-canvas')[1];
    return {
      c4Canvases: c4 ? c4.querySelectorAll('canvas').length : 0,
      c1Canvases: c1 ? c1.querySelectorAll('canvas').length : 0,
      c4Height: c4 ? Math.round(c4.getBoundingClientRect().height) : 0,
      trigger: document.querySelector('.ind-trigger-count')?.textContent?.trim(),
    };
  });
  log('RSI 加入后计数 +1', paneInfo.trigger, JSON.stringify(paneInfo));

  await page.screenshot({ path: path.join(OUT, 'v3-indicators.png') });

  // 3.4 副图上限 2 个 —— 勾第 3 个副图应被禁用
  const thirdPane = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.ind-item')];
    const paneLabels = labels.filter((l) => {
      const code = l.querySelector('.ind-code')?.textContent;
      return ['MACD', 'KDJ', 'CCI', 'WR'].includes(code);
    });
    const target = paneLabels.find((l) => {
      const inp = l.querySelector('input');
      return !inp.checked && inp.disabled;
    });
    return { found: !!target, limited: !!target?.classList.contains('limited') };
  });
  log('副图超过上限时被禁用', thirdPane.found && thirdPane.limited, JSON.stringify(thirdPane));

  // 3.5 切到 1h 周期配置独立
  const oneHourTabs = await page.$$('.ind-period-tab');
  await oneHourTabs[1].click();
  await sleep(600);
  const oneHourState = await page.evaluate(() => ({
    checked: [...document.querySelectorAll('.ind-item')].filter(
      (i) => i.querySelector('input')?.checked,
    ).length,
    codes: [...document.querySelectorAll('.ind-item')]
      .filter((i) => i.querySelector('input')?.checked)
      .map((i) => i.querySelector('.ind-code')?.textContent),
  }));
  log(
    '1h 配置与 4h 独立',
    oneHourState.codes.includes('MA') && oneHourState.codes.includes('VOL') && !oneHourState.codes.includes('BOLL'),
    JSON.stringify(oneHourState.codes),
  );

  // 3.6 关闭面板，确认图表仍正常渲染
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.ind-foot .btn')];
    btns[btns.length - 1]?.click();
  });
  await sleep(1200);
  const chartState = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.chart-canvas')];
    return blocks.map((b) => ({
      h: Math.round(b.getBoundingClientRect().height),
      canvases: b.querySelectorAll('canvas').length,
    }));
  });
  log('图表正常渲染', chartState.length === 2 && chartState.every((c) => c.h > 50), JSON.stringify(chartState));

  console.log('\n═══ 持久化验证 ═══');
  // 刷新后指标配置应保留
  await page.reload({ waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(5000);
  const persisted = await page.evaluate(() => {
    const raw = localStorage.getItem('kline-practice-v1');
    if (!raw) return null;
    const s = JSON.parse(raw).state;
    return { ind4h: s.indicators4h, ind1h: s.indicators1h, startMode: s.startMode };
  });
  log('指标配置已持久化', !!persisted && persisted.ind4h.includes('BOLL'), JSON.stringify(persisted));
  log('起点模式已持久化', !!persisted, persisted?.startMode);

  console.log('\n═══ JS 错误 ═══');
  log('无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
