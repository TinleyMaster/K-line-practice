/**
 * 浏览器端完整交易闭环（v2 多市场 × 多视口）
 * 选设置 → 勾检查表 → 填止损/目标 → 开仓 → 推进触发出场 → 强制复盘 → 统计看板
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

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

const CASES = [
  { market: 'perp', label: '币安U本位合约', vp: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
  { market: 'spot', label: '币安现货', vp: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
  { market: 'stock', label: '链上美股', vp: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
  { market: 'perp', label: '币安U本位合约', tag: 'ipad', vp: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { market: 'stock', label: '链上美股', tag: 'iphone', vp: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
];

const results = [];

async function runCase(browser, c) {
  const name = `${c.market}${c.tag ? '-' + c.tag : ''}`;
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e.message).slice(0, 160)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error ' + m.text().slice(0, 160));
  });

  const step = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('.replay-controls .btn')].find((x) =>
          x.textContent.includes('单步'),
        );
        b?.click();
      });
      await sleep(80);
    }
  };

  try {
    await page.setViewport(c.vp);
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('.chart-block canvas', { timeout: 60000 });

    // 切市场
    await page.evaluate((label) => {
      const t = [...document.querySelectorAll('.market-tab')].find((b) => b.textContent.trim() === label);
      t?.click();
    }, c.label);

    // 等 K 线加载完（图表 canvas 出现且有内容）
    let loaded = false;
    for (let i = 0; i < 40; i++) {
      await sleep(700);
      const st = await page.evaluate(() => ({
        loading: !!document.querySelector('.view-loading'),
        canvas: !!document.querySelector('.chart-canvas canvas'),
        bars: document.querySelector('.replay-count')?.textContent.trim(),
      }));
      if (st.canvas && !st.loading && st.bars && st.bars !== '1 / 0') {
        loaded = true;
        break;
      }
    }
    if (!loaded) throw new Error('K线未加载完成');

    const base = await page.evaluate(() => ({
      symbol: document.querySelector('.symbol-picker-row select')?.selectedOptions?.[0]?.textContent?.trim(),
      bars: document.querySelector('.replay-count')?.textContent.trim(),
      ffillNotice: document.querySelector('.notice.info')?.textContent?.trim() || null,
    }));

    // 1. 选设置
    const setupValue = await page.evaluate(() => {
      const s = document.querySelector('.side-area select');
      const opt = [...s.options].find((o) => o.value);
      if (!opt) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(s, opt.value);
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.value;
    });
    if (!setupValue) throw new Error('没有可选的开仓设置');
    await sleep(700);

    // 2. 勾全部检查表
    //    先滚到视口中央再点真实坐标 —— 触摸视口下回放条是 fixed 吸底，
    //    不滚动的话复选框可能被压在条下面，点不到。
    const boxes = await page.$$('.check-item input');
    for (const b of boxes) {
      await b.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await sleep(120);
      await b.click();
      await sleep(60);
    }
    await sleep(400);
    const allChecked = await page.$$eval('.check-item input', (els) => els.every((x) => x.checked));
    if (!allChecked) throw new Error('检查表未全部勾选（可能被吸底回放条遮挡）');

    // 3. 读取现价并设置贴近的止损/目标
    const priceText = await page.evaluate(
      () => document.querySelector('.side-area .panel-head .muted')?.textContent?.trim(),
    );
    const price = Number(String(priceText).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(price) || price <= 0) throw new Error('读不到现价: ' + priceText);

    await page.evaluate(({ p, dec }) => {
      const inputs = [...document.querySelectorAll('.side-area input[type=number]')];
      const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      // 精度按价格量级自适应：链上美股价格可能低到 0.1 美元级
      setVal(inputs[0], (p * 0.998).toFixed(dec)); // 止损
      setVal(inputs[1], (p * 1.002).toFixed(dec)); // 目标
    }, { p: price, dec: price >= 100 ? 2 : price >= 1 ? 4 : 6 });
    await sleep(600);

    // 4. 开仓
    const opened = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.side-area button')].find((x) => x.textContent.includes('开仓'));
      if (!b) return { ok: false, reason: '找不到开仓按钮' };
      if (b.disabled) {
        // 采集诊断信息
        const boxes = [...document.querySelectorAll('.check-item input')];
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          ok: false,
          reason: '按钮被禁用',
          diag: {
            hints: [...document.querySelectorAll('.side-area .hint')].map((h) => h.textContent.trim()),
            notices: [...document.querySelectorAll('.side-area .notice')].map((h) => h.textContent.trim()),
            setupValue: document.querySelector('.side-area select')?.value,
            checkboxCount: boxes.length,
            checkboxChecked: boxes.map((x) => x.checked),
            numberInputs: [...document.querySelectorAll('.side-area input[type=number]')].map((x) => x.value),
            priceText: document.querySelector('.side-area .panel-head .muted')?.textContent?.trim(),
            btnRect: { top: Math.round(r.top), h: Math.round(r.height) },
            elementAtBtn: hit ? hit.className + '|' + hit.tagName : null,
            vh: window.innerHeight,
            replayPosition: getComputedStyle(document.querySelector('.replay-controls')).position,
          },
        };
      }
      b.click();
      return { ok: true };
    });
    if (!opened.ok) throw new Error('开仓失败: ' + opened.reason + ' | diag=' + JSON.stringify(opened.diag));
    await sleep(1600);

    const posState = await page.evaluate(() => ({
      hasPosition: !!document.querySelector('.position-box'),
      equity: document.querySelector('.stat-chip strong')?.textContent?.trim(),
    }));
    if (!posState.hasPosition) throw new Error('开仓后没有持仓面板');

    // 5. 推进直到触发出场
    let modal = false;
    const cursorBefore = await page.$eval('.replay-count', (e) => e.textContent.trim());
    for (let i = 0; i < 80; i++) {
      await step(1);
      if (await page.evaluate(() => !!document.querySelector('.modal'))) {
        modal = true;
        break;
      }
    }
    const cursorAfter = await page.$eval('.replay-count', (e) => e.textContent.trim());
    if (!modal) throw new Error('80 根内未触发出场');

    // 6. 填复盘并保存
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.includes('完整执行'));
      btn?.click();
      const ta = document.querySelector('.modal textarea');
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '自动化测试复盘：4h 趋势明确，1h 回调企稳后按计划入场，止损放在结构位外侧。');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await sleep(500);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.modal .btn')].find((x) => x.textContent.includes('保存复盘'));
      b?.click();
    });
    await sleep(2200);
    const afterJournal = await page.evaluate(() => ({
      modalGone: !document.querySelector('.modal'),
      equity: document.querySelector('.stat-chip strong')?.textContent?.trim(),
    }));
    if (!afterJournal.modalGone) throw new Error('复盘弹窗未关闭');

    await page.screenshot({ path: path.join(OUT, `flow-${name}-after.png`) });

    // 7. 统计看板
    await page.evaluate(() => {
      [...document.querySelectorAll('.tab')].find((x) => x.textContent.includes('统计'))?.click();
    });
    await sleep(4000);
    const stats = await page.evaluate(() => {
      const v = document.querySelector('.stats-view');
      if (!v) return { missing: true };
      const cards = [...v.querySelectorAll('.stat-card')].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
      return {
        cards,
        tables: v.querySelectorAll('.table').length,
        bySymbolRows: [...v.querySelectorAll('.table')].map((t) => t.textContent.replace(/\s+/g, ' ').trim().slice(0, 160)),
      };
    });

    results.push({
      case: name,
      ok: true,
      symbol: base.symbol,
      bars: base.bars,
      ffillNotice: base.ffillNotice,
      setup: setupValue,
      price,
      cursor: `${cursorBefore} -> ${cursorAfter}`,
      equityAfter: afterJournal.equity,
      statsCards: stats.cards,
      statsTables: stats.tables,
      jsErrors: errors,
    });
    console.log(`✅ ${name}  ${base.symbol} | ${base.bars} | 游标 ${cursorBefore}->${cursorAfter} | 权益 ${afterJournal.equity}`);
    if (base.ffillNotice) console.log(`   ℹ️  ${base.ffillNotice}`);
    console.log(`   统计卡: ${JSON.stringify(stats.cards)}`);
    if (errors.length) console.log(`   ⚠️ JS 错误 ${errors.length}: ${errors.slice(0, 3).join(' | ')}`);
  } catch (e) {
    results.push({ case: name, ok: false, error: e.message, jsErrors: errors });
    console.log(`❌ ${name}  ${e.message}`);
    if (errors.length) console.log(`   JS 错误: ${errors.slice(0, 3).join(' | ')}`);
    await page.screenshot({ path: path.join(OUT, `flow-${name}-FAIL.png`) }).catch(() => {});
  }
  await page.close();
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  for (const c of CASES) await runCase(browser, c);
  await browser.close();

  const bad = results.filter((r) => !r.ok);
  const errCount = results.reduce((s, r) => s + (r.jsErrors?.length || 0), 0);
  console.log(`\n════ 浏览器闭环：${results.length - bad.length}/${results.length} 通过，JS 错误 ${errCount} 条 ════`);
  if (bad.length) {
    for (const b of bad) console.log('  -', b.case, '|', b.error);
    process.exit(1);
  }
})();
