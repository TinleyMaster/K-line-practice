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
    await sleep(5000);

    for (const pop of POPUPS) {
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
