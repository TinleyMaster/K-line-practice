# K线刻意练习平台

> 4h 看趋势 · 1h 入场 · **看不见未来** 的历史回放式交易训练系统。

不是交易所前端，是**交易飞行模拟器**：历史 K 线逐根揭示，未来全遮挡，逼你在「未知」中按系统决策，
事后用 R 倍数、计划执行度、设置期望值来校准自己。

**v2 覆盖三类市场**：币安 U 本位合约 / 币安现货 / 链上美股（代币化股票）。
**v4 界面重构**：4h/1h 改为单图来回切换、点击 K 线看逐根详情、回放可后退、整体换币安配色。
**v5 交互修正**：起点前的历史与指标预热、**绿涨红跌**、播放配置折叠 + 前进后退按钮放大、点击命中重做（点哪根显示哪根）。

---

## 一、它解决什么问题

看图容易，做错难。绝大多数散户的亏损不来自「看不懂 K 线」，而来自：

| 真实痛点 | 本平台的机制 |
|---|---|
| 事后诸葛亮（看到结果才知道该买该卖） | 回放引擎逐根揭示未来，未来数据完全不进图表 |
| 4h/1h 多周期不同步，看不准节奏 | 单图 + 周期 Tab：先在 4h 定方向，切到 1h 找入场，同屏不打架 |
| 亏了不知道为什么亏 | 强制复盘弹窗：不写复盘不许开下一单 |
| 「我这套打法到底赚不赚钱」 | 按**设置标签**统计期望 R、胜率、分布 |
| 同一套话术反复犯错 | 过程指标（守规则率 / R 分布 / 回撤）优先于结果指标（盈亏） |

---

## 二、技术架构

```
┌──────────────────────────── 浏览器 ────────────────────────────┐
│  React 19 + TypeScript + Vite                                 │
│  ├─ ChartPanel     KLineChart v10 单图 + 4h/1h 周期 Tab 切换    │
│  │                 顶部 OHLC 详情条：点击任意 K 线锁定查看      │
│  ├─ MarketHeader   币安式行情头（最新价 / 24h 高低量额）       │
│  ├─ ReplayControls 回放控制：后退 / 播放 / 单步 / 4h 步进 / 速度 │
│  ├─ AccountPanel   侧栏练习账户（权益 / 已实现 / 浮盈 / 胜率）  │
│  ├─ TradePanel     开仓前置检查表 → 风险金额 → 仓位推导        │
│  ├─ JournalModal   强制复盘（阻断式）                          │
│  └─ StatsView      设置期望值 / R 分布 / 守规则率              │
└───────────────────────────────┬───────────────────────────────┘
                                │ HTTP JSON (gzip)
┌───────────────────────────────▼───────────────────────────────┐
│  Node 22 + Express 5（后端）                                   │
│  ├─ /api/klines     1h 直取 + 4h 服务端派生                   │
│  ├─ /api/symbols    练习白名单 + 覆盖度缓存 + 市场清单         │
│  ├─ /api/trades     模拟交易 CRUD（带 market 维度）            │
│  ├─ /api/journal    强制复盘落库                               │
│  └─ /api/stats      聚合统计（按市场/设置/标的/离场原因）       │
│  内存缓存（10min TTL）+ gzip 压缩                              │
└───────────────────────────────┬───────────────────────────────┘
                                │ PostgreSQL（SSL）
┌───────────────────────────────▼───────────────────────────────┐
│  Postgres                                                     │
│  ├─ biz.asset_klines   【只读】原始 1h/5m/15m/1d K线（1340万行）│
│  └─ practice.*         【写入】本项目隔离 schema               │
│        klines / symbol_coverage / symbols / setups             │
│        sessions / trades / journal_entries                     │
└───────────────────────────────────────────────────────────────┘
```

### 关键设计决策

**1. 读写隔离铁律**
原项目表 `biz.asset_klines` 全程**只读**，本项目所有写入落 `practice` schema。不 ALTER、不 DELETE、不 INSERT 原表。

**2. 按需物化（performance 的关键）**
源表 1340 万行，`(symbol, interval, open_time)` 索引不覆盖 OHLC 列，实测取 3000 根要 **4~113 秒**（随机堆读 + 链路抖动）。
解决：把需要的 1h 数据 `INSERT ... SELECT` 物化到 `practice.klines`（本地小表），之后读取 **< 50ms**。
物化是幂等增量——只复制比本地最大时间戳更新的部分，首次全量、后续补增量同一句话。

**3. 4h 派生而非另取**
4h 完全由 1h 聚合（桶起点 `floor(epoch / 4h) * 4h`，UTC 对齐），保证两个周期**逐根严格对齐**，且不引入第二个数据源。

**4. market 维度进主键**
同一个 `BTCUSDT` 在合约和现货两个市场都存在，主键里必须带 `market` 才不会互相覆盖。
`practice.klines` / `symbols` / `symbol_coverage` 三张表的主键都改成了复合主键
（`market, symbol[, interval, open_time]`），会话/交易/复盘也带 `market`，统计可按市场隔离。

**5. 内存缓存 + gzip**
同机部署时缓存近乎无感；跨机访问时，gzip 把 300KB 压到 49KB，内存缓存让二次请求零传输。

**6. 启动预热 + stale-while-revalidate（跨机链路的兜底）**
详见下方「性能与链路实测」——一句话版本：**预热让首访零延迟，SWR 让缓存过期也不卡顿**。

---

## 二·五、性能与链路实测（2026-10-27）

### 问题定位：慢的不是数据库，是链路

一开始的现象是「链上美股接口要 2 秒、合约要 3.7 秒」。逐层拆解后：

| 环节 | 实测耗时 | 判定 |
|---|---|---|
| PostgreSQL 服务端执行 | **1.1ms** | 索引反向扫描命中 873 个 buffer，无问题 |
| HTTP 响应传输（gzip 后 49KB） | **27ms** | 无问题 |
| **DB 链路往返** | **387ms/次** | ⚠️ 瓶颈 |
| **DB 链路传数据** | **≈1.3ms/行** | ⚠️ 瓶颈（1172 行 ≈ 1.5s） |

根因：`tailscale ping` 显示 **走 DERP 中继（东京 tok），RTT 271ms**，不是点对点直连。
跨机带宽被中继限制在 ~195KB/s，所以「取多少行」直接决定耗时。

> **部署到 DB 同机后这个问题自动消失**（回环带宽 GB/s）。
> 开发期跨机访问的应对手段就是下面三层。

### 三层优化（已落地）

**① 内存缓存命中判定的真 bug（已修）**
原判定是 `hit.bars.length >= limit`。链上美股 `CRCLON` 库里只有 **1172** 根，
而请求 `limit=1200` → 条件永远不成立 → **每次请求都穿透到 DB**。
修复：增加 `exhausted` 标记（取回数 < limit 即「库里就这么多」），命中条件改为
`bars.length >= limit || exhausted`。

**② 启动预热**（`PREWARM`，默认开）
服务启动后台并发拉取所有 `enabled` 标的进内存缓存（实测 77 个，约 60s 完成）。
用户首次访问即命中，无需等待。失败不阻塞启动。

**③ stale-while-revalidate**
缓存超过 TTL 后**不阻塞请求**：先把旧数据返回去，同时后台静默刷新。
实测（TTL=8s 压测）：过期请求 **12ms 快返**，后台刷新完成后时间戳被重置。

另外：`ensureMaterialized` 的增量检查加了 5 分钟 TTL —— 每次「查 coverage + 查源表 max」
就是 2 次额外往返（跨机下 774ms），用 TTL 换掉。`spot`/`stock` 直接跳过该检查。

### 优化前后对比

| 场景 | 优化前 | 优化后 |
|---|---|---|
| stock `CRCLON`（冷，1172 根） | 1982ms | 20ms（预热后） |
| perp `BTCUSDT`（冷，1200 根） | 2729ms | 18ms（预热后） |
| 缓存 TTL 过期后的请求 | 2000ms（同步阻塞） | **12ms**（SWR 快返） |
| 跨 TTL 边界连续 6 次请求 | 每次 2s | 19~27ms |

### 相关环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PREWARM` | `true` | 启动时预热全部已登记标的 |
| `PREWARM_LIMIT` | `1200` | 预热时每个标的拉多少根 1h |
| `PREWARM_CONCURRENCY` | `8` | 预热并发数 |
| `CACHE_TTL_MS` | `600000` | 内存缓存 TTL（超时走 SWR） |
| `FETCH_PROXY` | 空 | 外部数据源代理（境内源建议留空） |

> 调低 `CACHE_TTL_MS` 可以观察 SWR 行为（后台日志里能看到刷新请求）。

---

## 三、三类市场的数据链路

| 市场 | market | 数据源 | 回填方式 | 实测覆盖 |
|---|---|---|---|---|
| 币安 U 本位合约 | `perp` | `biz.asset_klines`（原库，只读物化） | `npm run db:materialize` | 60 标的 / 148.9 万根 |
| 币安现货 | `spot` | 币安现货 REST `/api/v3/klines` | `node src/scripts/backfill.js spot-all` | 12 标的 / 365 天 0 缺口 |
| 链上美股 | `stock` | Binance Alpha 清单 → GeckoTerminal 链上 OHLCV | `node src/scripts/backfill.js stock --symbols ...` | 8 标的 / 多池合并 |

### 链上美股的三个坑（都踩过并已解决）

**① 多池合并**：单池历史深度取决于池子何时建立 —— 实测同一批标的里
`NVDAON` 单池 1162 根，`MSTRON` 只有 3 根、`HIMSON` 22 根。
不同池活跃期互补，取成交额前 4 池合并后 `QQQON` 436→901 根、`MSTRON` 3→22 根。

**② 脏池剔除**：低流动性池的成交价会严重偏离真实价格
（实测 `SPYON` 历史里出现过 388，真值约 768；`CRCLON` 出现过 0.07）。
合并时先按中位 close 剔除偏离 >3% 的池，再用剩余池取 `high=max / low=min / close=中位数`，
`open` 取与中位 close 最接近那个池的开盘价。

**③ 低流动性时段前向填充（ffill）**
链上美股 24/7 交易但流动性极低，没有成交的小时 GeckoTerminal 根本不返回那一根，
实测 1h 覆盖率只有 **32%~81%**（NVDAON 80.7% / QQQON 66.2% / SPYON 61.9% / CRCLON 52.3% / MUON 32.1%）。
稀疏的 1h 会连累 4h 派生（4h 桶缺成员，形态不完整）。

解决：空洞 ≤6h 的做前向填充（OHLC 全取前收、成交量 0），>6h 的不填（那是数据源真缺，硬填会造假形态）。
填充行 `source` 标记为 `geckoterminal_ffill`，可审计；前端会提示「含 N 根填充哑线」。
填充后 `CRCLON` 711→1172 根、`SPYON` 842→1305 根。

**数据健康度审计**：回填完自动统计每个标的的「真实成交根数」，
<200 根的直接下架（`enabled=false`），并在 `external_ref.dataHealth` 里写明覆盖率。
实测 `IVVON`(0.9%) / `HIMSON`(3.1%) / `MSTRON`(1.8%) 会被下架 —— 这种标的拿去练习没有意义。

### 各源踩坑记录

| 问题 | 原因 | 处理 |
|---|---|---|
| `TSLAXUSD` 报 `Invalid arguments` | Kraken 没有 xStocks | 放弃 Kraken 源 |
| Alpha 4 种 klines 路径全 404 | Binance Alpha 无 klines 端点 | 改走链上 OHLCV |
| `cash:TSLA` 返回 `[]` | Hyperliquid cash dex 资产已下架 | 排除该源 |
| Node fetch 被 Binance WAF 403 | 默认 UA 被识别为爬虫 | 浏览器式 UA + Referer/Origin |
| 现货 365 天只拿到 1000 根 | 币安给 startTime 后返回**从 startTime 起的正序** | 正向分页 `cursorStart = last + 1` |
| COPY 报 `invalid input syntax for type timestamp` | 表头被当数据 | `WITH (FORMAT csv, HEADER)` |
| GeckoTerminal 429 | 30 req/min 限流 | 2.3s 全局节流 + 长退避 |
| `INSERT INTO [object Object].symbols` | `${PRAC}` 是对象不是字符串 | 改 `${PRAC.schema}` |

---

## 四、快速开始

### 环境要求
- Node.js ≥ 20.19（实测 22.22）
- 可访问目标 Postgres

### 安装与初始化

```bash
# 1. 装依赖（monorepo：server + web）
npm install

# 2. 配置（真实连接串只放 .env，不要提交）
cp .env.example .env
# 编辑 .env，填入 DATABASE_URL

# 3. 建表（幂等）+ 种子数据（练习白名单 + 5 套开仓设置）
npm run db:init
npm run db:seed

# 4. 预物化合约 K 线（首次约 1~3 分钟，之后增量几秒）
npm run db:materialize

# 5. 回填现货 / 链上美股（可选，见上节）
cd server
node src/scripts/backfill.js spot-all --limit 12 --days 365
node src/scripts/backfill.js stock --symbols NVDAON,SPYON,QQQON,CRCLON,MUON --days 60

# 6. 构建前端 + 启动（单进程同时提供 API 与静态页面）
cd .. && npm run build && npm start
# → http://<host>:8787
```

### 开发模式（前后端分离热更新）

```bash
npm run dev          # 后端 :8787 + 前端 :5173（/api 自动代理）
```

---

## 五、核心机制说明

### 回放引擎（看不见未来）

- 游标 `cursor` 以 **1h** 为单位推进，`cursor+1` 之前的数据**根本不下发到图表**。
- 4h 图同步揭示：只有当一根 4h 的 4 根 1h 全部出现，它才成型；期间显示的是**形成中**的 4h 蜡烛（原地更新，不新增柱）。
- 支持：播放/暂停、单步、跳下一根 4h、按根号跳转、速度调节（0.5s~4s）。
- 切换标的/市场会**重置**游标、账户与持仓，不会带着上一个标的的进度。

### 单图切换：4h 看趋势 → 1h 找入场（v4）

v1~v3 是「双图同屏」，实际用起来两套坐标系叠在一起反而看不清。
v4 改成**单图 + 周期 Tab**，全屏尺寸统一（桌面 / iPad / 手机都一样）：

| | 4h 趋势 | 1h 入场 |
|---|---|---|
| 作用 | 定方向：只做顺着 4h 方向的单 | 找入场：等 1h 收盘确认 |
| 默认指标 | MA(20,60) + VOL | MA + VOL |
| 独立配置 | ✅ 与 1h 完全分开 | ✅ 与 4h 完全分开 |

切换只换数据与指标，**游标不动**（4h 由 1h 实时派生，天然同步）。
当前周期会持久化，刷新后仍在原周期。

### 点击 K 线看详情（v4，v5 重做命中逻辑）

图表上方是一条**币安式 OHLC 详情条**，随鼠标悬停实时更新；
**点击任意一根 K 线即锁定**，显示该根的完整明细：

```
2026-09-27 08:00 │ 开 84,403.2 │ 高 84,559.6 │ 低 84,214.5 │ 收 84,356.2
                │ 涨跌 -47.10 (-0.06%) │ 振幅 0.41% │ 量 5.24K │ 额 442.28M │ 笔数 148.17K
```

- 涨跌幅按**前一根收盘价**计算，振幅 = (高-低)/前收。
- 锁定时图上出现一条黄色竖线标记该根；**点空白处 / 按 ESC / 点「解除锁定」**即取消。
- 悬停只更新数字、不锁定，避免误触。

> **v5 重写了命中逻辑**（v4 的实现是坏的，只是测试恰好没测出来）。
> klinecharts 的 `onCandleBarClick` 只在命中蜡烛**矩形本体**时才派发 ——
> K 线实体只有 4~8px 宽，随手点几乎总是落在实体外的空白，点了没反应；
> 而且 `candle_solid` 的「影线 + 实体」两个矩形都挂了同一个 handler，
> 一次物理点击被派发两次，「再点一次解除锁定」的 toggle 会被自己抵消。
>
> 现在改用 `chart.convertFromPixel([{x,y}], {absolute:true})` **反查**命中的 K 线：
> 坐标落在哪根就取哪根（币安的做法，不要求精确命中实体），并且改成**幂等锁定**
> —— 重复点同一根不会抵消自己。

### 起点前的历史与指标预热（v5）

练习起点之前的 K 线会**一并喂给图表**，保证当前那根的指标有值：

| 周期 | 预热窗口 | 效果 |
|---|---|---|
| 4h | 起点前 **480 根 1h**（= 120 根 4h） | MA60 / BOLL 等长周期指标在起点处就有值 |
| 1h | 起点前 **240 根 1h** | 同上 |

- 预热区左端**对齐到 4h 桶边界** —— 不对齐的话派生出的第一根 4h 是残桶，
  OHLC 与成交量都是错的，会污染所有以它为起点的指标。
- 图上用一条淡色竖线标出**练习起点**（起点与预热区的分界）。
- 可见根数按容器宽度自适应（每根至少 4px），窄屏不会把 K 线挤成一团。
- 只喂**过去**，不喂未来 —— 图表数据右端永远停在游标。

### 后退（回看模式，v4）

回放条新增 `⏪ 退4h` 与 `◀ 后退`，可以把游标往回拨，重新看已经走过的行情。

**边界是刻意保守的**（不制造「时间旅行」的错觉）：

| 行为 | 说明 |
|---|---|
| 回看画面 | ✅ 游标回退，图表/OHLC 条同步回退 |
| 浮动盈亏 | ✅ 按回退到的当前价重算 |
| 权益曲线 | ✅ 按游标截断 |
| 已平仓交易 | ❌ **不撤销** —— 历史就是历史，落库的记录也不删 |
| 持仓期间后退 | ⚠️ 最多退回到**入场那根**，再往前「持仓」在时间上就不成立 |
| 回看时开仓 | ❌ 禁用（提示「回看模式，不能开仓」） |

游标回到 `maxCursor`（已回放到的最远处）即自动退出回看模式，徽标消失、可以正常开仓。

### 币安风格界面（v4）

整套配色与布局照搬币安现货/合约页：

| 用途 | 色值 |
|---|---|
| 背景 / 面板 / 次级面板 | `#0B0E11` / `#161A1E` / `#1E2329` |
| 分隔线 | `#2B3139` |
| 文字 / 次级 / 弱化 | `#EAECEF` / `#848E9C` / `#5E6673` |
| **涨** | `#0ECB81`（绿） |
| **跌** | `#F6465D`（红） |
| **强调** | `#FCD535`（币安黄，主按钮黄底黑字） |

> 配色是 **v5 改的**：v4 用的是币安中文站的「红涨绿跌」，
> 现按要求改为国际站习惯的**绿涨红跌**（图表 K 线、涨跌文字、统计条全部一致）。

布局：顶栏（市场切换 + 搜索 + 权益）→ 行情头（最新价 + 24h 高低量额）→
图表工具条（周期 Tab + OHLC 条）→ K 线图 → 回放条 → 起点/指标工具行；
右侧栏为开仓按钮 + 练习账户概览（权益 / 已实现 / 浮盈 / 累计R / 胜率 / 回撤 / 持仓）。

圆角收到 4px、边框 1px、字号 11~13px —— 高信息密度，不堆装饰。

### 回放条（v5 调整）

- **速度配置默认隐藏** —— 0.5s / 1s / 2s / 4s 是「播放」的附属选项，
  暂停时藏起来，点「▶ 播放」才展开，不占常态屏幕。
- **前进 / 后退按钮放大**到 38px 高（`退4h` / `后退` / `播放` / `单步` / `4h⏩`），
  触屏单手可按；窄屏自动切成图标态，5 个按钮挤进一行，不把图表挤没。

### 练习起点（可自定义）

默认自动：留出 ≥120 根 4h 趋势上下文（≈480 根 1h ≈ 20 天），其余作为「未来」。

也可手动指定，两种方式：
- **时间点**：`<input type="datetime-local">` 选具体时刻，自动定位到不晚于该时刻的最后一根 1h；
- **相对区间**：「往前 1 天 / 1 周 / 1 月 / 3 月」快捷按钮（基于数据末端倒推，反复点不漂移）。

两条硬约束（自动兜底，不会让你选出一个没法练的起点）：
- 起点前保留 **≥120 根 4h** —— 没有趋势依据，「只做顺着 4h 方向的单」就落不了地；
- 起点后保留 **≥60 根 1h** —— 否则没有「未来」可回放。

选择「恢复自动」即可回到推导模式。起点模式与时间戳会持久化。

### 开仓面板（默认折叠）

侧栏默认只显示一个「🛒 开仓」按钮，点击才展开完整表单；展开后右上角 `✕` 收起。
持仓中自动切到持仓面板（收起态优先给图表让出空间）。
收起态下侧栏只剩「开仓」按钮 + 「练习账户」概览卡（合计 ~260px，展开后 ~650px）。

### 技术指标（自选，27 个内置全白嫖）

klinecharts v10 内置 27 个指标，本项目**不自己写公式**，直接调 `createIndicator`。

| 分组 | 指标 |
|---|---|
| **主图叠加**（画在 K 线上，不占额外高度） | MA / EMA / SMA / BOLL / DMA / AVP / BBI / SAR / TRIX / BIAS |
| **独立副图**（自动开新窗格） | VOL / RSI / MACD / KDJ / CCI / WR / VR / PSY / ROC / OBV / BRAR / CR / DMI / EMV / MTM / PVT / AO / TRIX / BIAS |

- **4h 与 1h 各自独立配置** —— 4h 看趋势常配 BOLL + 慢均线，1h 看入场常配 MACD + RSI，
  用途不同不该共用一套（符合「4h 看趋势、1h 入场」的分工）。
- **独立副图最多常驻 2 个**：多了会把主图挤扁（矮屏尤其明显），超出的选项在 UI 里置灰。
- 副图高度按容器高度**自适应分配**（klinecharts 默认给副图固定 100px，矮屏下会把主图压成一条缝）。
- 配置持久化到本地（`localStorage.kline-practice-v1`）。

### 开仓前置检查表（Checklist）

不选设置 = 不许开仓。选了设置必须逐条勾完入场规则才能按下开仓。
这是整个系统里**最容易被绕过、也最值钱**的一步——它把「我打算怎么做」变成「我必须逐条确认」。

### 仓位与 R 倍数

```
风险金额 = 当前权益 × 单笔风险%
仓位数量 = 风险金额 / |入场价 - 止损价|
R 倍数   = 盈亏 / 风险金额
```
入场价 = 当前 1h 收盘价（看不到未来，所以不用开盘价这种有歧义的价）。
同一根 K 线同时触及止损与目标时，**保守假设先打止损**。

### 强制复盘

平仓后立即弹出阻断式复盘窗：是否按计划执行 / 情绪 / 错误标签 / 文字复盘。
不保存不许开下一单。复盘数据进入统计，是「守规则率」这个核心过程指标的来源。

### 统计口径

- **单笔期望** = 总 R / 已平仓笔数 —— 比胜率更诚实的指标
- **守规则率** = `followed_plan = true` 的复盘占比 —— 刻意练习真正的 KPI
- **最大回撤** 按平仓时间序的权益曲线计算
- 按**设置**分组统计期望值：负期望的设置要么改规则，要么少做
- 可按 `market` 过滤，合约 / 现货 / 链上美股的成绩互不串

---

## 六、移动端 / iPad 适配

目标设备：iPad Pro / iPad Air（竖屏 768–1024、横屏 1024–1366）、iPhone（含横屏）。

| 项 | 做法 |
|---|---|
| 触控目标 | 所有可点元素 ≥ **44×44px**（Apple HIG），`@media (pointer: coarse)` 统一放大 |
| 输入框字号 | 强制 **≥16px**（`@media (any-pointer: coarse)` + `!important`）——iOS Safari 聚焦 <16px 会强制放大整页 |
| 图表区 | `touch-action: none`，拖 K 线时页面不跟着滚；`overscroll-behavior-y: none` 禁橡皮筋 |
| 单图降级 | 窄屏/矮屏横屏自动收起为单图 + **4h/1h Tab 切换**，双图在小屏会挤成缝 |
| 副图高度 | klinecharts 默认给 VOL 副图固定 100px，矮屏会把主图压成一条缝 → 改为按容器高度自适应（26%，夹在 48–100px），主图吃掉剩余空间 |
| 回放控制条 | 触摸设备一律 `position: fixed` 吸底（`sticky` 在文档中部不生效，实测 computed=static），`right` 用 `--side-col` 变量避开右侧交易面板 |
| 安全区 | `viewport-fit=cover` + `env(safe-area-inset-*)`（刘海屏 / 底部指示条） |
| 视口单位 | 用 `dvh` 而非 `vh`，避免 iOS 地址栏收放导致高度跳变 |
| 弹窗 | 移动端底部抽屉式（`max-height: 92dvh` + 圆角） |
| 表格 | `.table-scroll` 横向滚动，不挤压列 |

**多视口实测（2026-10-27，Chromium 设备仿真，5 视口 × 3 市场 = 15 组）**

| 视口 | 横向溢出 | 小触控目标 | 输入框字号 | 回放条 | 图表渲染 | JS 错误 |
|---|---|---|---|---|---|---|
| iPad 横屏 1180×820 | 0 | 0 | 16px | fixed 吸底 | ✅ | 0 |
| iPad 竖屏 820×1180 | 0 | 0 | 16px | fixed 吸底 | ✅ | 0 |
| iPhone 竖屏 390×844 | 0 | 0 | 16px | fixed 吸底 | ✅ | 0 |
| iPhone 横屏 844×390 | 0 | 0 | 16px | fixed 吸底 | ✅ | 0 |
| 桌面 1440×900 | 0 | — (鼠标设备) | 12px | static | ✅ | 0 |

---

## 七、目录结构

```
k线研究所/
├── .env                     # 真实连接串（gitignore）
├── .env.example             # 配置模板
├── package.json             # monorepo 根（workspaces）
├── server/
│   ├── src/
│   │   ├── index.js         # Express 入口（API + 静态托管 + gzip + 启动预热）
│   │   ├── config.js        # 配置与标识符安全校验
│   │   ├── db.js            # 连接池 + SSL 兼容 + 连接重试
│   │   ├── schema.js        # practice schema DDL + market 维度迁移
│   │   ├── services/
│   │   │   ├── klineService.js       # 物化 / 派生 / 内存缓存 / SWR / ffill / 预热
│   │   │   └── sources/              # http / binance / alpha / geckoterminal / stock
│   │   ├── routes/          # symbols / klines / setups / practice / stats
│   │   └── scripts/         # init-db / seed / materialize / backfill / bench / reset-practice
├── web/
│   └── src/
│       ├── engine/          # bars.ts（派生） trading.ts（R 倍数） indicators.ts（27 指标注册表）
│       │                    # format.ts（紧凑数字 / 带符号涨跌） popup.ts
│       ├── hooks/           # usePopupPosition（弹窗视口约束）
│       ├── store/           # zustand 回放状态机（含 prev/back4h 回看、maxCursor 回看模式判定）
│       ├── components/      # ChartPanel（单图+周期Tab+OHLC条） / MarketHeader / AccountPanel
│       │                    # ReplayControls / TradePanel / JournalModal / StatsView
│       │                    # IndicatorPicker / StartTimePicker / PositionPanel / SymbolPicker
│       └── styles.css       # 币安风格主题（绿涨红跌 + 黄强调）+ 移动端适配
├── scripts/
│   └── verify/              # 三段式复验脚本（API / 浏览器 / 多视口 / v3 / v4 / v5 / 弹窗可达性）
└── deploy/
    ├── kline-practice.service   # systemd
    └── start.sh
```

### 验证脚本（可复用）

```bash
npm run verify          # 一键跑全套七个
npm run verify:api      # API 层：三市场 × 12 项 = 36 项
npm run verify:flow     # 浏览器层：真实点击开仓/平仓/复盘 × 5 场景
npm run verify:viewport # 布局层：5 视口 × 3 市场 = 15 组
npm run verify:v3       # v3 功能：面板折叠 / 起点设置 / 指标自选 = 29 项
npm run verify:v4       # v4 功能：单图切换 / 后退 / 点击详情 / 币安配色 = 34 项
npm run verify:v5       # v5 功能：预热窗口 / 指标有值 / 绿涨红跌 / 播放折叠 / 点击详情 = 30 项
npm run verify:popup    # 弹窗可达性：5 视口 × 2 弹窗 = 15 项
```

详见 `scripts/verify/README.md`（含前置依赖与三个已踩过的坑）。

---

## 八、API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（含 DB 连通性） |
| GET | `/api/symbols` | 练习白名单 + 覆盖度 + 数据健康度 |
| GET | `/api/symbols/markets` | 市场清单（前端渲染切换 Tab） |
| POST | `/api/symbols/sync-stock` | 从 Binance Alpha 同步链上美股清单 |
| GET | `/api/klines?symbol=&market=&interval=1h\|4h\|both&limit=` | K 线（1h 直取 + 4h 派生） |
| POST | `/api/klines/backfill` | 触发外部源回填（spot / stock） |
| GET | `/api/klines/:symbol/coverage` | 单标的覆盖度 |
| GET | `/api/klines/_cache/stats` | 内存缓存状态 |
| GET / POST / PATCH | `/api/setups` | 开仓设置库 |
| GET / POST / PATCH | `/api/sessions` | 练习会话（带 market） |
| GET / POST / PATCH | `/api/trades` | 模拟交易（带 market） |
| GET / POST | `/api/journal` | 复盘记录（带 market） |
| GET | `/api/stats?symbol=&setup=&market=` | 聚合统计 |

---

## 九、部署（与 DB 同机）

```bash
# 构建
npm ci && npm run build

# 配置
cp .env.example .env && vi .env      # DATABASE_URL 指向本机/内网 DB

# 建表 + 物化
npm run db:init && npm run db:seed && npm run db:materialize

# 守护（systemd）
sudo cp deploy/kline-practice.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kline-practice
```

细节见 `deploy/README.md`。

---

## 十、v4 边界（明确没做的）

| 项 | 状态 | 说明 |
|---|---|---|
| 实时模拟盘 | ❌ 未做 | 仍只做历史回放 |
| 画线标注 / 多标注保存 | ❌ 未做 | v4 只做了「点击 K 线看详情 + 锁定标记」 |
| 后退撤销已平仓交易 | ❌ 未做 | 刻意不做：历史就是历史，避免制造「时间旅行」错觉 |
| 后退跨周期联动 | ❌ 未做 | 后退以 1h 为单位；4h 由 1h 派生，自动跟随 |
| 账号体系 | ❌ 未做 | 单用户本地；多用户再考虑 |
| 链上美股实时性 | ⚠️ 有限 | 链上池子流动性低，1h 数据天然稀疏（已用 ffill 缓解，真实成交比例已在 UI 标注） |
| 链上美股 5m/15m 周期 | ❌ 未做 | 只回填 1h，4h 由 1h 派生 |
| 现货/链上美股标的自动定时回填 | ❌ 未做 | 目前靠脚本手动跑；生产化应加 cron |

**已知取舍**：合约练习标的白名单 60 个（按近 30 天成交额排序），BTC/ETH/SOL 置顶。
现货白名单 12 个（从合约标的对齐回填），链上美股 8 个（按市值 + 数据健康度筛）。
