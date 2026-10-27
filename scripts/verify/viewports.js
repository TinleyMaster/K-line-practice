import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const OUT = process.env.OUT_DIR || path.join(process.cwd(), 'shots');
const CHROME =
  process.env.CHROME_PATH ||
  path.join(
    process.env.LOCALAPPDATA || 'C:/Users/SuperTing/AppData/Local',
    'ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  );

const VIEWPORTS = [
  { name: 'ipad-landscape', width: 1180, height: 820, dsf: 2, touch: true, mobile: true },
  { name: 'ipad-portrait', width: 820, height: 1180, dsf: 2, touch: true, mobile: true },
  { name: 'iphone', width: 390, height: 844, dsf: 3, touch: true, mobile: true },
  { name: 'iphone-landscape', width: 844, height: 390, dsf: 3, touch: true, mobile: true },
  { name: 'desktop', width: 1440, height: 900, dsf: 1, touch: false, mobile: false },
];

fs.mkdirSync(OUT, { recursive: true });

const PROBE = () => {
  const de = document.documentElement;
  const vw = window.innerWidth;

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // 横向溢出元素
  const overflowing = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      overflowing.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 60)) || '',
        left: Math.round(r.left),
        right: Math.round(r.right),
      });
    }
    if (overflowing.length > 12) break;
  }

  // 小触控目标
  const tiny = [];
  const sel = 'button, input, select, textarea, a[href], [role="tab"]';
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el)) continue;
    // 复选框本体只有 20px，真正的点击目标是包裹它的 label（.check-item）
    if (el.type === 'checkbox') continue;
    const r = el.getBoundingClientRect();
    if (r.height < 44 || r.width < 44) {
      tiny.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 40)) || '',
        text: (el.textContent || '').trim().slice(0, 12),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
  }

  // 画布绘制检测
  const charts = [];
  for (const el of document.querySelectorAll('.chart-canvas')) {
    const cvs = el.querySelector('canvas');
    let painted = false;
    let detail = '';
    if (cvs) {
      try {
        const ctx = cvs.getContext('2d');
        const data = ctx.getImageData(0, 0, cvs.width, cvs.height).data;
        let nonBlank = 0;
        for (let p = 0; p < data.length; p += 4 * 53) {
          if (data[p + 3] > 0 && (data[p] > 10 || data[p + 1] > 10 || data[p + 2] > 10)) nonBlank++;
        }
        painted = nonBlank > 30;
        detail = `nonBlank=${nonBlank}`;
      } catch (e) {
        detail = 'ERR ' + e.message;
      }
    }
    charts.push({
      visible: visible(el),
      hasCanvas: !!cvs,
      size: cvs ? `${cvs.width}x${cvs.height}` : null,
      painted,
      detail,
    });
  }

  // 回放控制条吸底状态
  const rc = document.querySelector('.replay-controls');
  let replay = null;
  if (rc) {
    const cs = getComputedStyle(rc);
    const r = rc.getBoundingClientRect();
    replay = {
      position: cs.position,
      bottom: Math.round(r.bottom),
      viewportH: window.innerHeight,
      gapToBottom: Math.round(window.innerHeight - r.bottom),
      height: Math.round(r.height),
    };
  }

  // 输入框字号
  const inputs = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (!visible(el)) continue;
    inputs.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 30),
      fontSize: getComputedStyle(el).fontSize,
    });
  }

  const side = document.querySelector('.side-area');
  const paneSwitch = document.querySelector('.period-tabs');
  const marketTabs = [...document.querySelectorAll('.market-tab')].map((b) => b.textContent.trim());

  return {
    viewport: { w: vw, h: window.innerHeight },
    scrollWidth: de.scrollWidth,
    horizontalOverflow: de.scrollWidth > vw + 1,
    overflowing,
    tinyTargets: tiny,
    tinyTargetCount: tiny.length,
    charts,
    chartPainted: charts.some((c) => c.visible && c.painted),
    replay,
    inputs,
    minInputFontSize: inputs.length
      ? Math.min(...inputs.map((i) => parseFloat(i.fontSize)))
      : null,
    sideAreaCols: side ? getComputedStyle(side).gridTemplateColumns : null,
    paneSwitch: !!paneSwitch,
    paneSwitchVisible: paneSwitch ? visible(paneSwitch) : false,
    marketTabs,
    activeMarketTab: document.querySelector('.market-tab.active')?.textContent.trim() || null,
    selectedSymbol: document.querySelector('.symbol-picker-row select')?.selectedOptions?.[0]?.textContent?.trim() || null,
    coPointer: window.matchMedia('(pointer: coarse)').matches,
    anyCoarse: window.matchMedia('(any-pointer: coarse)').matches,
  };
};

const run = async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });

  const report = {};

  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e.message).slice(0, 200)));

    await page.setViewport({
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.dsf,
      isMobile: vp.mobile,
      hasTouch: vp.touch,
    });
    await page.setUserAgent(
      vp.mobile
        ? 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    );

    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
    // 等图表画出来
    await page
      .waitForFunction(
        () => {
          const c = document.querySelector('.chart-canvas canvas');
          return !!c;
        },
        { timeout: 30000 },
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    const res = await page.evaluate(PROBE);
    res.jsErrors = errors;
    res.jsErrorCount = errors.length;

    await page.screenshot({
      path: path.join(OUT, `${vp.name}-perp.png`),
      fullPage: false,
    });

    // 切到现货市场
    const spotTab = await page.$$('.market-tab');
    if (spotTab.length >= 2) {
      await spotTab[1].click();
      await new Promise((r) => setTimeout(r, 6000));
      const spotRes = await page.evaluate(PROBE);
      spotRes.jsErrors = errors.slice();
      await page.screenshot({ path: path.join(OUT, `${vp.name}-spot.png`) });
      res.spotTab = spotRes;
    }

    // 切到链上美股
    if (spotTab.length >= 3) {
      await spotTab[2].click();
      await new Promise((r) => setTimeout(r, 8000));
      const stockRes = await page.evaluate(PROBE);
      stockRes.jsErrors = errors.slice();
      await page.screenshot({ path: path.join(OUT, `${vp.name}-stock.png`) });
      res.stockTab = stockRes;
    }

    report[vp.name] = res;
    await page.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

run().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
