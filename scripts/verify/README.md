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
| `v6-api.js` | **v6 API 层**：15m 接口与 1h 对齐 / BTC-ETH 覆盖天数 / 注册登录登出 / 账号数据隔离 / PK 9 维度 / 复盘跳过与补写 / **15m 全市场覆盖与桶对齐** | stdout 汇总 | 49/49 通过 |
| `v6-features.js` | **v6 浏览器层**：15m⇄1h⇄4h 方向切换 / 无 15m 标的置灰 / 注册登录 / PK 页 / 9 类开仓设置 / 复盘四条关闭路径 | `shots/v6-*.png` | 45/45 通过 |
| `v6-align.js` | **v6.3 图表交互**：切周期**像素级对齐**（1h↔4h Δ=0px / 15m 右端锚定）/ 单步步长跟随周期 / 图表高度 / 详情条无重叠 / 副图上限 4 | `shots/v6-align.png` | 23/23 通过 |
| `v6-depth.js` | **v6.3 历史深度（DB 层）**：BTC/ETH 的 15m+1h 是否回填到币安物理下限 / 15m 起点不晚于 1h / 重叠区桶对齐 / 存量基线 | stdout 汇总 | 16/16 通过 |
| `v6-fixes.js` | **v6.3 五修**：指标配置生效 / 画线工具 / 1h 档密度可读 / 起点可调范围可见且生效 / 开仓被禁原因醒目 | `shots/v6-fixes.png` | 14/14 通过 |
| `popup-reachability.js` | **弹窗可达性**：5 视口 × 2 弹窗，验证底部「完成」按钮真的点得到 | stdout | 15/15 通过 |

## 跑法

```bash
npm run verify              # 一键跑全套（api + flow + viewport + v3 + v4 + v5 + v6api + v6ui + v6align + v6depth + v6fixes + popup）

node scripts/verify/e2e-markets.js          # API 闭环
node scripts/verify/flow2.js                 # 浏览器交易闭环
node scripts/verify/viewports.js             # 多视口回归
node scripts/verify/v3-features.js           # v3 增量功能
node scripts/verify/popup-reachability.js    # 弹窗可达性
node scripts/verify/v4-features.js           # v4 增量功能
node scripts/verify/v5-features.js           # v5 增量功能
node scripts/verify/v6-api.js                # v6 API 层
node scripts/verify/v6-features.js           # v6 浏览器层
node scripts/verify/v6-align.js              # v6.3 图表交互（像素级对齐 + 步长）
node scripts/verify/v6-depth.js              # v6.3 历史深度（DB 层）
node scripts/verify/v6-fixes.js              # v6.3 五修（用户反馈项）
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:8787` | 被测后端地址 |
| `OUT_DIR` | `./shots` | 截图与报告输出目录 |
| `CHROME_PATH` | Playwright chromium | Chromium 可执行文件路径 |

## 坑清单（别重复踩）

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
8. **受控 text/password input 不能用「原生 setter + dispatchEvent('input')」填**。
   React 19 对这类 input 有 value tracker：绕过原生 setter 改 value 时，
   React 认为值没变 → `onChange` 不触发 → state 没更新 → 提交时拿到空值，**且不报错**。
   必须用真实键盘输入（`el.click()` + `el.type()`）。
   ⚠️ `number` input 不受影响（flow2.js 填数字就是这么干的）—— 别把两套混用。
9. **`form.requestSubmit()` 在 React 19 下不可靠**：`e.preventDefault()` 变成异步生效，
   可能拦不住原生提交 → 页面导航 → 整个前端状态被重置。
   直接 `page.click('button[type=submit]')` 更稳，也更接近真实用户行为。
10. **驱动业务链路优先用 store 钩子，而不是 DOM 选择器**。
    `usePracticeStore` 已挂到 `window.__practiceStore`（与 `window.__klineChart` 同一惯例），
    `window.__practiceStore.getState().openPosition(...)` / `.closePosition('manual')`
    比在页面上猜「哪个按钮是平仓」可靠得多 —— 页面上平仓语义有多个入口，
    DOM 猜测失败时很难分辨是产品问题还是脚本问题。
11. **脚本里不要硬编码「会变的业务常量」**。副图上限从 2 改成 4（v6.3）后，
    `v3-features.js` 里「勾第 3 个副图应被禁用」这条断言就**静默失效**了 ——
    表现是「找不到 disabled 项」，很容易被误判成产品 bug。
    正确写法：**一直勾到出现 disabled 为止**，不写死上限值
    （`v3-features.js` 已按这个写法改）。
12. **产品改了「与档位相关的语义」，老脚本的断言语义会跟着变**。
    v6.3 起单步步长跟随当前图表周期 ⇒ 「后退一根」在 4h 档退的是 4 根 1h。
    `v4-features.js` 的 ② 段断言是 1h 语义 ⇒ 必须**在段首显式切到 1h 档**，
    断言才有确定含义。（「先跑 ① 再跑 ②」这种顺序依赖最容易被漏掉。）
13. **改了按钮的文案或 title，要立刻想一遍：有没有脚本按它定位**。
    v6.3 连栽两次：
    - 把「单步 ▶」改成「步1h ▶」→ `flow2.js`（按「单步」找按钮）失效，回归 0/5；
    - 把 title 改成动态的「前进一根 15m…」→ `v6-features.js` 的
      `[title="前进一根 1h"]` 匹配不到 → **静默不点击**，15m 右端不动的断言挂掉。
    本项目的做法：**文案保持稳定（「单步」「后退」），步长用徽标表达**（`单步 ▶1h`），
    title 也不做精确匹配；脚本侧一律按文案 `includes` 或 `.btn-step` 索引定位。
    ⚠️ `?.click()` 匹配不到时是**静默失败** —— 断言失败时先确认「到底点没点上」。
14. **断言「上限/阈值」类行为时，先确认脚本跑在哪个上下文**。
    同一个脚本里前一段改了全局状态（周期、档位、指标），后一段的断言含义就变了 ——
    别把「脚本没切档位」误判成「产品行为变了」。
15. **面板的默认状态也会被产品改掉** —— 指标面板原本固定停在「4h 趋势」，
    v6.3 改成「跟随图表当前周期」后，`v3-features.js` 的「4h/1h 分开配置」测的就成了 1h 的配置。
    ⇒ 脚本要测哪个档位，就**显式点到那个档位**，别依赖默认值。
16. **klinecharts 不同 overlay 的 points 坐标语义不一样**（实测）：
    `segment`（趋势线）必须用**数据坐标** `{timestamp, value}` ——
    用像素坐标 `{x, y}` 创建出来 overlay 存在但**画不出线**（看着像「没反应」）；
    `horizontalStraightLine` / `priceLine` 反之，用像素坐标。

