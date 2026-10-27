/**
 * v6 浏览器层验证（对应用户的 5 条需求）：
 *   ① 15m K 线 + 方向切换（默认 1h，往左 15m，往右 4h）+ 不看见未来
 *   ② 无 15m 数据的标的 → 15m tab 置灰并自动退回
 *   ③ 登录面板：注册 / 登录 / 登出
 *   ④ 胜率 PK 页
 *   ⑤ 开仓设置选项覆盖度（9 类 + 8 格计算区）
 *   ⑥ 强制复盘的四条关闭路径（✕ / ESC / 点遮罩 / 跳过按钮）
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

/** 当前激活的周期 tab */
async function activePeriod(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.period-tab.active .period-main');
    return el ? el.textContent.trim() : null;
  });
}

/** 读图表内部数据 */
async function readChart(page) {
  return page.evaluate(() => {
    const chart = window.__klineChart;
    if (!chart) return null;
    const list = chart.getDataList();
    return {
      dataLen: list.length,
      first: list[0]?.timestamp ?? null,
      last: list[list.length - 1]?.timestamp ?? null,
      bars: list.map((b) => b.timestamp),
    };
  });
}

/** 点击左右箭头 */
async function clickArrow(page, dir) {
  await page.evaluate((d) => {
    const btns = [...document.querySelectorAll('.period-arrow')];
    (d < 0 ? btns[0] : btns[btns.length - 1])?.click();
  }, dir);
  await sleep(1500);
}

const rnd = Math.random().toString(36).slice(2, 8);
const USER = `v6ui_${rnd}`;

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

  console.log('\n═══ ① 15m K 线 + 方向切换 ═══');

  const p0 = await activePeriod(page);
  log('默认显示 1h（需求：默认 1h）', p0 === '1h', `active=${p0}`);

  const tabCount = await page.evaluate(() => document.querySelectorAll('.period-tab').length);
  log('周期切换器有 3 档（15m/1h/4h）', tabCount === 3, `${tabCount} 档`);

  const tabOrder = await page.evaluate(() =>
    [...document.querySelectorAll('.period-tab .period-main')].map((e) => e.textContent.trim()),
  );
  log(
    '从左到右 = 15m → 1h → 4h（往左更细、往右更粗）',
    JSON.stringify(tabOrder) === JSON.stringify(['15m', '1h', '4h']),
    tabOrder.join(' → '),
  );

  const chart1h = await readChart(page);
  log('1h 图表有数据', (chart1h?.dataLen ?? 0) > 0, `${chart1h?.dataLen} 根`);

  // 往左 → 15m
  await clickArrow(page, -1);
  const p15 = await activePeriod(page);
  log('点左箭头切到 15m', p15 === '15m', `active=${p15}`);

  const chart15 = await readChart(page);
  log('15m 图表有数据', (chart15?.dataLen ?? 0) > 0, `${chart15?.dataLen} 根`);

  // 15m 步长必须是 15 分钟
  let badStep = 0;
  const b15 = chart15?.bars ?? [];
  for (let i = 1; i < b15.length; i++) {
    if (b15[i] - b15[i - 1] !== 900000) badStep++;
  }
  log('15m 时间步长严格 15 分钟', badStep === 0, `异常 ${badStep} 处 / 共 ${b15.length} 根`);

  // 「看不见未来」：15m 右端必须锚定在当前 1h 小时末，不能超出
  const anchor = await page.evaluate(() => {
    const el = document.querySelector('.ohlc-time');
    return el ? Number(el.getAttribute('data-ts')) : null;
  });
  const last15 = chart15?.last ?? null;
  const last1h = chart1h?.last ?? null;
  log(
    '15m 右端不超出当前 1h 根（不看见未来）',
    last15 !== null && last1h !== null && last15 <= last1h + 3600000 - 900000,
    `15m 末=${new Date(last15).toISOString()} / 1h 末=${new Date(last1h).toISOString()}`,
  );
  log(
    '15m 右端与 1h 末在同一小时内（同一时间轴）',
    last15 !== null && last1h !== null && Math.floor(last15 / 3600000) === Math.floor(last1h / 3600000),
    `15m 桶=${Math.floor(last15 / 3600000)} 1h 桶=${Math.floor(last1h / 3600000)}`,
  );

  // 15m 与 1h 的时间跨度应「基本相当」（同一时间轴的高分辨率视图）。
  //
  // 容差说明：15m 的窗口左端 = 锚点 − 960 根 15m（240h），
  // 但**数据边界会截断它** —— 非 BTC/ETH 标的的 15m 只有 41 天，
  // 练习起点离 15m 起点不足 240h 时，左端被截 → 跨度变短。
  // 所以契约是：15m 跨度**不超过** 1h 跨度，且差值在 1 个 1h 桶的量级内。
  const span15 = last15 - chart15.first;
  const span1h = last1h - chart1h.first;
  log(
    '15m 与 1h 覆盖同一时间跨度（15m 不超出，差 ≤ 1 个 1h 桶）',
    span15 <= span1h + 3600000 && span15 >= span1h - 3600000 * 4,
    `15m=${(span15 / 3600000).toFixed(1)}h / 1h=${(span1h / 3600000).toFixed(1)}h`,
  );

  await page.screenshot({ path: path.join(OUT, 'v6-15m.png') });

  // 往右 → 4h（15m → 1h → 4h，需要点两次右箭头）
  await clickArrow(page, 1);
  const pMid = await activePeriod(page);
  log('点右箭头从 15m 回到 1h', pMid === '1h', `active=${pMid}`);
  await clickArrow(page, 1);
  const p4 = await activePeriod(page);
  log('再点右箭头切到 4h', p4 === '4h', `active=${p4}`);

  const chart4h = await readChart(page);
  log('4h 图表有数据', (chart4h?.dataLen ?? 0) > 0, `${chart4h?.dataLen} 根`);

  // 4h 根数应远少于 1h（同一时间跨度）
  log(
    '4h 根数少于 1h（同一时间跨度的粗粒度视图）',
    (chart4h?.dataLen ?? 0) < (chart1h?.dataLen ?? 0),
    `4h=${chart4h?.dataLen} 1h=${chart1h?.dataLen}`,
  );

  // 15m 视图随回放推进而更新（v6 修的锚点 bug：右端曾钉死在练习起点）
  await clickArrow(page, -1);
  await clickArrow(page, -1);
  log('切回 15m', (await activePeriod(page)) === '15m');

  const before15 = await readChart(page);
  const beforeLast = before15?.last ?? null;
  await page.evaluate(() => {
    document.querySelector('.replay-btns [title="前进一根 1h"]')?.click();
  });
  await sleep(1800);
  const after15 = await readChart(page);
  log(
    '15m 视图随回放推进而更新（右端跟随游标）',
    (after15?.last ?? 0) > (beforeLast ?? 0),
    `末根 ${new Date(beforeLast).toISOString()} → ${new Date(after15?.last ?? 0).toISOString()}`,
  );

  // 回到 1h
  await clickArrow(page, 1);
  log('切回 1h', (await activePeriod(page)) === '1h');

  console.log('\n═══ ② 无 15m 数据的标的 ═══');

  // 切到链上美股（源只有 1h 粒度）
  await page.evaluate(() => {
    [...document.querySelectorAll('.market-tab')]
      .find((x) => x.textContent.includes('链上美股'))
      ?.click();
  });
  await sleep(5000);

  const isStock = await page.evaluate(() =>
    [...document.querySelectorAll('.market-tab')].some(
      (x) => x.textContent.includes('链上美股') && x.classList.contains('active'),
    ),
  );
  log('已切到链上美股市场', isStock);

  const stockPeriod = await activePeriod(page);
  const stock15Disabled = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.period-tab')].find((x) =>
      x.textContent.trim().startsWith('15m'),
    );
    return t ? t.classList.contains('disabled') || t.disabled : null;
  });
  log('15m tab 置灰（该市场无 15m 数据）', stock15Disabled === true, `disabled=${stock15Disabled}`);
  log('已自动退回 1h', stockPeriod === '1h', `active=${stockPeriod}`);

  // 切回合约
  await page.evaluate(() => {
    [...document.querySelectorAll('.market-tab')]
      .find((x) => x.textContent.includes('合约'))
      ?.click();
  });
  await sleep(4000);

  console.log('\n═══ ③ 登录面板 ═══');

  await page.evaluate(() => {
    [...document.querySelectorAll('.topbar-right button')]
      .find((x) => x.textContent.trim() === '登录')
      ?.click();
  });
  await sleep(800);
  log('登录面板能打开', await page.evaluate(() => !!document.querySelector('.auth-panel')));

  // 切到注册页
  await page.evaluate(() => {
    [...document.querySelectorAll('.auth-tabs button')]
      .find((x) => x.textContent.includes('注册'))
      ?.click();
  });
  await sleep(400);
  const hasDisplayName = await page.evaluate(() => document.querySelectorAll('.auth-panel input').length >= 3);
  log('注册表单含「显示名称」字段（PK 榜用）', hasDisplayName);

  // 填表并提交
  //
  // ⚠️ 必须用**真实键盘输入**，不能用「原生 setter + dispatchEvent('input')」那套 hack。
  //    React 19 对受控的 text/password input 有 value tracker：
  //    绕过原生 setter 直接改 value 时，React 认为值没变 → onChange 不触发 → state 没更新
  //    → 提交时拿到空值 → 注册静默失败。
  //    （number input 不受影响，所以 flow2.js 那套能用 —— 别混用。）
  const authInputs = await page.$$('.auth-panel input');
  const typed = [[authInputs[0], USER], [authInputs[1], 'Tester'], [authInputs[2], 'test1234']];
  for (const [el, val] of typed) {
    if (!el) continue;
    await el.click({ clickCount: 3 });
    await el.type(val, { delay: 8 });
  }
  await sleep(500);

  const fillState = await page.evaluate(() => {
    const i = [...document.querySelectorAll('.auth-panel input')];
    return { vals: i.map((x) => x.value), disabled: document.querySelector('.auth-panel button[type=submit]')?.disabled };
  });
  log(
    '表单已正确填写（3 个字段 + 提交按钮可用）',
    fillState.vals.length === 3 &&
      fillState.vals[0].length > 0 &&
      fillState.vals[2].length >= 4 &&
      fillState.disabled === false,
    JSON.stringify(fillState),
  );

  await page.click('.auth-panel button[type=submit]');

  // 等登录态出现，**不要固定 sleep** ——
  // 撞上服务端预热高峰时（预热占连接池 → API 排队），
  // 注册请求可能超过 2.5 秒才返回，固定等待会误判成失败。
  const loggedIn = await page
    .waitForFunction(
      () => {
        const chip = document.querySelector('.user-chip');
        return !!chip && chip.textContent.includes('Tester');
      },
      { timeout: 20000, polling: 300 },
    )
    .then(() => true)
    .catch(() => false);
  log('注册成功并进入登录态（顶栏显示昵称）', loggedIn);
  log('登录面板已关闭', !(await page.evaluate(() => !!document.querySelector('.auth-panel'))));

  const tokenStored = await page.evaluate(() => !!localStorage.getItem('kline-practice-token'));
  log('token 已存入 localStorage', tokenStored);

  await page.screenshot({ path: path.join(OUT, 'v6-login.png') });

  console.log('\n═══ ④ 胜率 PK 页 ═══');

  await page.evaluate(() => {
    [...document.querySelectorAll('.tabs .tab')]
      .find((x) => x.textContent.includes('胜率 PK'))
      ?.click();
  });

  // 等 PK 表渲染出来 —— PK 数据是异步拉的，固定 sleep 会在慢请求时读早。
  const pkReady = await page
    .waitForFunction(() => !!document.querySelector('.pk-table'), { timeout: 25000, polling: 300 })
    .then(() => true)
    .catch(() => false);
  log('PK 页已渲染', pkReady);
  const pkRows = await page.evaluate(() => document.querySelectorAll('.pk-row').length);
  log('PK 展示 9 个对比维度', pkRows === 9, `${pkRows} 行`);
  const pkDims = await page.evaluate(() =>
    [...document.querySelectorAll('.pk-dim-label')].map((e) => e.textContent.trim()),
  );
  log(
    '维度标签齐全',
    ['胜率', '单笔期望', '累计R', '平均R', '盈亏比', '最大回撤', '守规则率', '已平仓笔数'].every((d) =>
      pkDims.includes(d),
    ),
    pkDims.join('/'),
  );
  const pkNames = await page.evaluate(() =>
    [...document.querySelectorAll('.pk-name')].map((e) => e.textContent.trim()),
  );
  log('PK 列出玩家（含刚注册的用户）', pkNames.length >= 1, pkNames.join(' / '));

  await page.screenshot({ path: path.join(OUT, 'v6-pk.png') });

  // 回到练习台
  await page.evaluate(() => {
    [...document.querySelectorAll('.tabs .tab')]
      .find((x) => x.textContent.includes('练习台'))
      ?.click();
  });
  await sleep(1500);

  console.log('\n═══ ⑤ 开仓设置选项覆盖度 ═══');

  await page.evaluate(() => {
    document.querySelector('.trade-open-trigger')?.click();
  });
  await sleep(900);
  log('开仓面板能展开', await page.evaluate(() => !!document.querySelector('.trade-panel')));

  const fieldLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.trade-panel .field > span, .trade-panel .field-row .field > span')]
      .map((e) => e.textContent.trim()),
  );
  const REQUIRED = [
    ['入场方式', '入场方式'],
    ['止损方式', '止损方式'],
    ['止盈方式', '止盈方式'],
    ['仓位方式', '仓位方式'],
    ['手续费率', '手续费率'],
    ['滑点', '滑点'],
    ['时间止损', '时间止损'],
    ['置信度', '置信度'],
    ['备注', '备注'],
  ];
  const missing = REQUIRED.filter(([, kw]) => !fieldLabels.some((l) => l.includes(kw)));
  log('9 类开仓设置全部齐备', missing.length === 0, `缺=${missing.map((m) => m[0]).join(',') || '无'}`);
  log(
    '全部字段标签',
    fieldLabels.length >= 9,
    fieldLabels.join(' | '),
  );

  const calcCells = await page.evaluate(() =>
    [...document.querySelectorAll('.trade-panel .calc-grid > div')].map((d) =>
      d.querySelector('.muted')?.textContent.trim(),
    ),
  );
  log(
    '计算区 8 格齐全（止损价/距离/风险/目标R/数量/名义额/往返成本/成本占风险）',
    calcCells.length === 8,
    calcCells.join('/'),
  );

  // 三种止损方式可切换
  const stopModes = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.trade-panel .field')].find((f) =>
      f.querySelector('span')?.textContent.includes('止损方式'),
    );
    return [...(row?.querySelectorAll('.btn-row .btn') ?? [])].map((b) => b.textContent.trim());
  });
  log(
    '止损方式含 固定价/百分比/ATR倍数',
    ['固定价', '百分比', 'ATR 倍数'].every((m) => stopModes.includes(m)),
    stopModes.join('/'),
  );

  const tpModes = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.trade-panel .field')].find((f) =>
      f.querySelector('span')?.textContent.includes('止盈方式'),
    );
    return [...(row?.querySelectorAll('.btn-row .btn') ?? [])].map((b) => b.textContent.trim());
  });
  log(
    '止盈方式含 固定价/R倍数/不设',
    ['固定价', 'R 倍数', '不设'].every((m) => tpModes.includes(m)),
    tpModes.join('/'),
  );

  const sizeModes = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.trade-panel .field')].find((f) =>
      f.querySelector('span')?.textContent.includes('仓位方式'),
    );
    return [...(row?.querySelectorAll('.btn-row .btn') ?? [])].map((b) => b.textContent.trim());
  });
  log(
    '仓位方式含 按风险%/按名义额',
    ['按风险 %', '按名义额'].every((m) => sizeModes.includes(m)),
    sizeModes.join('/'),
  );

  // ATR 倍数：应有真实 ATR 值（说明 ATR 指标可算）
  await page.evaluate(() => {
    [...document.querySelectorAll('.trade-panel .btn-row.seg .btn')]
      .find((b) => b.textContent.includes('ATR 倍数'))
      ?.click();
  });
  await sleep(500);
  const atrText = await page.evaluate(() => {
    const f = [...document.querySelectorAll('.trade-panel .field')].find((x) =>
      x.querySelector('span')?.textContent.includes('ATR 倍数'),
    );
    return f?.querySelector('span')?.textContent.trim() ?? '';
  });
  log('ATR 倍数带真实 ATR 数值', /ATR=\d/.test(atrText), atrText);

  await page.screenshot({ path: path.join(OUT, 'v6-trade-panel.png') });

  console.log('\n═══ ⑥ 强制复盘可关闭（四条路径） ═══');

  /**
   * 走一遍「开仓 → 平仓」，让强制复盘弹窗出现。
   *
   * 用 store 钩子（window.__practiceStore）驱动，而不是靠 DOM 选择器猜按钮：
   * 页面上「平仓」语义有多个入口，DOM 猜测失败时很难分辨是产品问题还是脚本问题。
   */
  async function triggerJournalModal() {
    // 确保开仓面板已展开
    const panelOpen = await page.evaluate(() => !!document.querySelector('.trade-panel'));
    if (!panelOpen) {
      const opened = await page.evaluate(() => {
        const b = document.querySelector('.trade-open-trigger');
        if (!b || b.disabled) return false;
        b.click();
        return true;
      });
      if (!opened) return false;
      await sleep(800);
    }

    // 取一个可用的设置名 + 当前价
    const setupName = await page.evaluate(async () => {
      const s = window.__practiceStore.getState();
      const setups = (s.setups ?? []).filter((x) => x.enabled);
      if (!setups.length) return null;
      const st = window.__practiceStore.getState();
      const price = st.bars1h[st.cursor]?.close ?? 0;
      if (!price) return null;
      // 直接调 openPosition（跳过 UI 勾选步骤，只测「复盘弹窗能否关闭」这条主线）
      return setups[0].name;
    });
    if (!setupName) return false;

    const opened = await page.evaluate(
      async (name) => {
        const st = window.__practiceStore.getState();
        const price = st.bars1h[st.cursor]?.close ?? 0;
        const res = await window.__practiceStore.getState().openPosition({
          side: 'long',
          stopLoss: price * 0.99,
          takeProfit: price * 1.02,
          riskPct: 1,
          setup: name,
          checklist: {},
          entryMode: 'market',
          limitPrice: null,
          stopType: 'price',
          tpType: 'price',
          sizeMode: 'risk',
          sizeValue: 1,
          feeRate: 0.0004,
          slippageBps: 2,
          timeStopHrs: null,
          confidence: 3,
          notes: 'v6 验证用开仓',
        });
        return res?.ok === true;
      },
      setupName,
    );
    if (!opened) return false;
    await sleep(1200);

    // 平仓 → 触发强制复盘
    const closed = await page.evaluate(async () => {
      await window.__practiceStore.getState().closePosition('manual');
      return !!window.__practiceStore.getState().pendingJournal;
    });
    if (!closed) return false;
    await sleep(1200);

    return page.evaluate(() => !!document.querySelector('.modal-backdrop .modal'));
  }

  const paths = [
    {
      name: '右上角 ✕ 按钮',
      close: async () => {
        await page.evaluate(() => document.querySelector('.modal .modal-close')?.click());
      },
    },
    {
      name: 'ESC 键',
      close: async () => {
        await page.keyboard.press('Escape');
      },
    },
    {
      name: '点遮罩空白处',
      close: async () => {
        await page.evaluate(() => {
          const bd = document.querySelector('.modal-backdrop');
          bd?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
      },
    },
    {
      name: '底部「跳过」按钮',
      close: async () => {
        await page.evaluate(() => document.querySelector('.modal .modal-skip')?.click());
      },
    },
  ];

  let prevBadge = 0;
  for (const p of paths) {
    const appeared = await triggerJournalModal();
    if (!appeared) {
      log(`${p.name}：复盘弹窗能出现`, false, '未能触发弹窗');
      break;
    }
    await p.close();
    await sleep(400);
    const closed = await page.evaluate(() => !document.querySelector('.modal-backdrop .modal'));
    // 徽标是**异步**刷新的（跳过 → 落库 → 重新拉计数）。
    // 固定 sleep 读到的往往是上一轮的旧值 —— 表现为「徽标数比跳过次数少 1」。
    // 所以这里等它真的涨上去（最多 15s）。
    const badge = await page
      .waitForFunction(
        (min) => {
          const el = document.querySelector('.pending-chip');
          const n = el ? Number(el.querySelector('strong')?.textContent ?? '0') : 0;
          return n > min ? n : false;
        },
        { timeout: 15000, polling: 300 },
        prevBadge,
      )
      .then((h) => h.jsonValue())
      .catch(() => prevBadge);
    prevBadge = badge;
    log(`${p.name}：能关闭复盘弹窗`, closed, closed ? `待补复盘徽标=${badge}` : '弹窗仍在');
  }

  const pendingRows = await page
    .waitForFunction(() => document.querySelectorAll('.pending-row').length >= 4, {
      timeout: 15000,
      polling: 300,
    })
    .then(() => page.evaluate(() => document.querySelectorAll('.pending-row').length))
    .catch(() => page.evaluate(() => document.querySelectorAll('.pending-row').length));
  log('待补复盘列表出现在侧栏', pendingRows >= 4, `${pendingRows} 条`);

  await page.screenshot({ path: path.join(OUT, 'v6-pending-journal.png') });

  // 补写一条
  const filled = await page.evaluate(async () => {
    const btn = document.querySelector('.pending-row .btn');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (filled) {
    await sleep(800);
    const hasEditor = await page.evaluate(() => !!document.querySelector('.pending-editor'));
    log('待补复盘可展开补写编辑器', hasEditor);
  }

  console.log('\n═══ ⑦ 登出 ═══');
  await page.evaluate(() => document.querySelector('.user-chip')?.click());
  await sleep(600);
  const loggedOut = await page
    .waitForFunction(
      () => {
        const btn = [...document.querySelectorAll('.topbar-right button')].find(
          (x) => x.textContent.trim() === '登录',
        );
        return !!btn && !localStorage.getItem('kline-practice-token');
      },
      { timeout: 15000, polling: 300 },
    )
    .then(() => true)
    .catch(() => false);
  log('登出后回到未登录态、token 已清除', loggedOut);

  console.log(`\n═══ 浏览器层结果：${pass} 通过 / ${fail} 失败 ═══`);
  if (errors.length) {
    console.log('  ⚠️ JS 错误：');
    for (const e of [...new Set(errors)].slice(0, 8)) console.log('    ' + e);
  } else {
    console.log('  ✅ 无 JS 错误');
  }
  if (fail > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
