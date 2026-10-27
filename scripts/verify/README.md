# 验证脚本（scripts/verify）

五个脚本构成「源码 → runtime → 注入测试」三段式复验的执行层。**全部只读/可回滚**：
除 `e2e-markets.js` 会写练习会话/交易/复盘记录外，其余不写业务数据。

## 前置

```bash
# 1. 装无头浏览器驱动（项目未内置，避免污染生产依赖）
npm i -D puppeteer-core

# 2. 确保有 Chromium 可执行文件
#    默认找 Playwright 自带的：%LOCALAPPDATA%/ms-playwright/chromium-*/chrome-win64/chrome.exe
#    找不到就用环境变量指定：
#    CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"

# 3. 起后端（必须，否则接口全 502）
npm start
```

## 五个脚本

| 脚本 | 覆盖 | 产物 | 期望 |
|---|---|---|---|
| `e2e-markets.js` | **API 层**多市场闭环：建会话 → 开仓 → 平仓 → 复盘 → 读回 → 统计核对 → 市场隔离 | stdout 汇总 | 36/36 通过 |
| `flow2.js` | **浏览器层**真实点击闭环（perp/spot/stock 桌面 + perp-iPad + stock-iPhone） | `shots/flow-*.png` | 5/5 通过，0 条 JS 错误 |
| `viewports.js` | **多视口 × 多市场**布局回归：横向溢出 / 触控目标 / 输入框字号 / 图表渲染 / JS 错误 | `shots/*.png` + `shots/report.json` | 15 组全绿 |
| `v3-features.js` | **v3 增量功能**：开仓面板折叠 / 自定义练习起点 / 指标自选 / 持久化 | `shots/v3-*.png` | 29/29 通过 |
| `v4-features.js` | **v4 增量功能**：4h/1h 单图切换 / K 线后退 / 点击 K 线详情 / 币安配色 | `shots/v4-*.png` | 34/34 通过 |
| `v5-features.js` | **v5 增量功能**：预热窗口（起点前历史可见）/ 指标有值 / 绿涨红跌 / 播放配置折叠 / 点击命中重做 | `shots/v5-*.png` | 30/30 通过 |
| `popup-reachability.js` | **弹窗可达性**：5 视口 × 2 弹窗，验证底部「完成」按钮真的点得到 | stdout | 15/15 通过 |

## 跑法

```bash
npm run verify              # 一键跑全套（api + flow + viewport + v3 + v4 + v5 + popup）

node scripts/verify/e2e-markets.js          # API 闭环
node scripts/verify/flow2.js                 # 浏览器交易闭环
node scripts/verify/viewports.js             # 多视口回归
node scripts/verify/v3-features.js           # v3 增量功能
node scripts/verify/popup-reachability.js    # 弹窗可达性
node scripts/verify/v4-features.js           # v4 增量功能
node scripts/verify/v5-features.js           # v5 增量功能
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:8787` | 被测后端地址 |
| `OUT_DIR` | `./shots` | 截图与报告输出目录 |
| `CHROME_PATH` | Playwright chromium | Chromium 可执行文件路径 |

## 七个坑（别重复踩）

1. **不要用 `| head` / `| tail` 截断输出**：管道关闭会触发 SIGPIPE 把 node 进程杀掉，
   报告文件直接丢失（踩过两次）。要精简就读 `shots/report.json`，或把输出重定向到文件。
2. **`viewports.js` 的 `tiny` 判定只对触摸设备有意义**：桌面（鼠标）视口天然有 <44px 的
   元素，脚本里 `coPointer` 为 false 时应忽略该项 —— 别误判成 bug。
3. **判断「元素能不能点到」必须用 `document.elementFromPoint`**：
   `getBoundingClientRect().bottom <= viewportHeight` 只说明元素在视口内，
   不代表没被别的东西盖住。v3 调试时就是靠它才发现两个 fixed 弹窗同 z-index 互相遮挡。
   测之前要先 `scrollIntoView` 把目标滚进视口，否则测的是被裁剪的位置。
4. **canvas 上的元素点不中，只能换算像素坐标**：K 线是 canvas 渲染的，DOM 里查不到
   蜡烛的位置。`ChartPanel` 暴露了 `window.__klineChart` 测试钩子，
   用 `chart.convertToPixel({ timestamp, value }, { absolute: true })`
   把「时间戳 + 价格」换成像素，再叠加画布的 `getBoundingClientRect()` 偏移，
   就能做真实像素级点击。注意 `value` 要取**实体内部**的价格（如 (开+收)/2），
   取高低点会点到影线外。
5. **反向也有 API：`chart.convertFromPixel([{x, y}], { absolute: true })`**
   直接返回 `{ dataIndex, timestamp, value }` —— 不用换算就知道「这个像素属于哪根 K 线」。
   坐标要用**相对容器**的（`clientX - rect.left`），`absolute: true` 表示已经是容器坐标。
   v5 的点击命中就是靠它重写的，比在窄蜡烛实体上抠像素靠谱得多。
6. **`getPaneOptions('candle_pane').height` 是布局权重（恒为 100），不是像素**。
   拿它当像素用，所有点击都会被判成「落在副图上」而丢弃。
   主图实际像素高度用 `chart.getSize('candle_pane')?.height` 或 DOM 的 `offsetHeight`。
7. **断言必须锚定在真实变化的量上**。v4 的点击测试就是反面教材：
   悬停不跟随 → 横向扫 7 个位置扫到的都是最后一根 → 「点的」和「断言的」恰好同一根 →
   测试通过但功能早就坏了。**写断言前先确认那个量真的会变**（如「不同 x 得到不同时间戳」）。

