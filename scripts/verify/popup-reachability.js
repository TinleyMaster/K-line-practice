/**
 * 弹窗可达性验证（v3）
 *
 * 判据用 `document.elementFromPoint` —— 它是「这个坐标上真正能点到谁」的权威答案。
 * 只看 getBoundingClientRect 会误判：元素在视口内不等于没被别的东西盖住。
 *
 * 历史坑：① 弹窗 absolute 定位在桌面/横屏会整体掉出视口；
 *        ② 窄屏下弹窗底部被 fixed 吸底回放条盖住，「完成」按钮点不到；
 *        ③ 面板内容超高时必须先滚到底部再测，否则测的是被裁剪的位置。
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

const VIEWPORTS = [
  { name: 'iphone', width: 390, height: 844, mobile: true },
  { name: 'iphone-ls', width: 844, height: 390, mobile: true },
  { name: 'ipad-portrait', width: 820, height: 1180, mobile: true },
  { name: 'ipad-landscape', width: 1180, height: 820, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
];

const POPUPS = [
  { trigger: '.ind-trigger', panel: '.ind-panel' },
  { trigger: '.start-trigger', panel: '.start-panel' },
];

let pass = 0;
let fail = 0;
const log = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
});

try {
  for (const vp of VIEWPORTS) {
    console.log(`\n── ${vp.name} (${vp.width}×${vp.height}) ──`);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 2,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
    });
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 90000 });
    // ⚠️ 禁盲等：bars1h 未加载时桌面侧栏不渲染 trigger（曾致 iphone-ls 假失败）。
    // 必须等数据就绪再测 —— 「读早=假绿/假红」铁律。
    await page
      .waitForFunction(() => (window.__practiceStore?.getState?.().bars1h?.length ?? 0) > 0, {
        timeout: 60000,
      })
      .catch(() => {});
    await sleep(1200); // 等布局稳定（指标实例挂载）

    // 移动布局（≤767px 竖屏）下，起点/指标选择器**内联在 ☰ 抽屉**（静态流，非弹层）。
    // 对内联表单断言「面板整体在视口内」不成立（表单本就该比视口长），
    // 正确判据：打开抽屉后，面板的底部按钮能滚动进入视口且真正可点。
    const isMobileLayout = await page.evaluate(() => !!document.querySelector('.app-mobile'));

    for (const pop of POPUPS) {
      if (isMobileLayout) {
        // ── 移动端路径：打开 ☰ 抽屉，测内联选择器可达性 ──
        const menuReady = await page
          .waitForSelector('.m-menu-btn', { timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        if (!menuReady) {
          log(`${pop.trigger} 选择器在 ☰ 抽屉内可达（移动端内联）`, false, '☰ 按钮 15s 内未挂载');
          continue;
        }
        await page.evaluate(() => {
          if (!document.querySelector('.sheet.open')) {
            document.querySelector('.m-menu-btn')?.click();
          }
        });
        await sleep(800); // 等抽屉上滑动画

        // 抽屉里的面板是条件渲染（{open && ...}）→ 先点抽屉内的 trigger 展开
        await page.evaluate((sel) => {
          const t = document.querySelector(`.m-section ${sel}`);
          if (t && !t.classList.contains('active')) t.click();
        }, pop.trigger);
        await sleep(900); // 等面板渲染 + React 提交

        const m = await page.evaluate((panelSel) => {
          const panel = document.querySelector(panelSel);
          if (!panel) return { none: true };
          const foot = [...panel.querySelectorAll('.ind-foot .btn')];
          const last = foot[foot.length - 1] ?? [...panel.querySelectorAll('button')].pop();
          // 抽屉 body 可滚动 → 先把底部按钮滚进视口再测
          last?.scrollIntoView({ block: 'center' });
          const fr = last?.getBoundingClientRect();
          let clickable = false;
          if (fr) {
            const cx = Math.round(fr.left + fr.width / 2);
            const cy = Math.round(fr.top + fr.height / 2);
            const el = document.elementFromPoint(cx, cy);
            clickable = el ? el === last || el.contains(last) || last.contains(el) : false;
          }
          return {
            none: false,
            inViewport: fr ? fr.top >= -1 && fr.bottom <= window.innerHeight + 1 : false,
            clickable,
            top: Math.round(fr?.top ?? -1),
            bottom: Math.round(fr?.bottom ?? -1),
            vh: window.innerHeight,
          };
        }, pop.panel);

        log(
          `${pop.trigger} 选择器在 ☰ 抽屉内可达（移动端内联）`,
          !m.none && m.inViewport && m.clickable,
          JSON.stringify(m),
        );
        continue;
      }

      // ── 桌面布局路径：弹层形态（原有逻辑） ──
      // trigger 可能随数据/布局延迟挂载 → 等它存在再操作（最多 15s）
      const trigExists = await page
        .waitForSelector(pop.trigger, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (!trigExists) {
        log(`${pop.trigger} 弹窗可达`, false, 'trigger 15s 内未挂载（数据加载失败？）');
        continue;
      }
      // 保证初始为关闭态
      await page.evaluate((sel) => {
        const b = document.querySelector(sel);
        if (b?.classList.contains('active')) b.click();
      }, pop.trigger);
      await sleep(400);

      await page.evaluate((sel) => document.querySelector(sel)?.click(), pop.trigger);
      await sleep(1200); // 等 usePopupPosition 的 rAF 完成定位

      const m = await page.evaluate((panelSel) => {
        const panel = document.querySelector(panelSel);
        if (!panel) return { none: true };
        const foot = [...panel.querySelectorAll('.ind-foot .btn')];
        const last = foot[foot.length - 1];
        // 面板可能内容超高 → 先滚到底部按钮进入视口，再测
        last?.scrollIntoView({ block: 'center' });
        const fr = last?.getBoundingClientRect();
        let clickable = false;
        if (fr) {
          const cx = Math.round(fr.left + fr.width / 2);
          const cy = Math.round(fr.top + fr.height / 2);
          const el = document.elementFromPoint(cx, cy);
          clickable = el ? el === last || el.contains(last) || last.contains(el) : false;
        }
        const pr = panel.getBoundingClientRect();
        return {
          none: false,
          inViewport: pr.top >= -1 && pr.bottom <= window.innerHeight + 1,
          clickable,
          top: Math.round(pr.top),
          bottom: Math.round(pr.bottom),
          vh: window.innerHeight,
        };
      }, pop.panel);

      log(
        `${pop.trigger} 弹窗可达`,
        !m.none && m.inViewport && m.clickable,
        JSON.stringify(m),
      );
    }

    log('无 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`弹窗可达性：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
