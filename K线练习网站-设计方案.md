# K 线刻意练习平台 · 设计方案（v1 + v2 已落地）

> 目标：做一个**交易飞行模拟器**式的刻意练习网站——在币安现货/合约（加密货币 + 链上美股）上，用 **4h 看趋势、1h 入场**，通过「看不见未来」的历史回放 + 模拟下单 + 复盘，建立交易系统、积累实战经验。
> 定位：**不碰真钱、不接交易账户**，纯练习/复盘工具。
> 时效基线：数据可得性结论基于 2026-10 实测与公开报道（The Block / CoinLaw / Kraken Blog）。
> **状态**：v1（合约回放）已实现并通过端到端验证；**v2（三市场 + 移动端）已落地**（2026-10-26）。
> 实现细节见 `README.md` 与 `deploy/README.md`；设计→落地的偏差与实测数据见 **第 12 节**，v2 复盘见 **第 13 节**。
> ⚠️ 文中 0.1 / 0.2 / 4.4 / 4.6 是 v1 时期的**原始判断**，其中关于链上美股来源的部分**已被 v2 实测推翻**，以第 13 节为准。

---

## 0. 先撂结论（含重要更正 + 待拍板）

### 0.1 关于「币安上的链上美股」——必须澄清
> ⚠️ **v2 实测更正**：本节 v1 的判断（走 Kraken xStocks）**已被推翻**。
> 实测：币安 U 本位合约 `AssetPairs` 1463 对 + `Futures` 231 标的里美股命中 **0 个**；
> `TSLAXUSD` 在币安报 `Invalid arguments`；**Binance Alpha 没有 klines 端点**（4 种路径全 404）；
> Hyperliquid `cash:TSLA` 已下架（`isDelisted: true`）。
> **v2 最终链路**：`Binance Alpha 资产清单 → GeckoTerminal 链上 OHLCV（多池合并）`，详见 13.2 / 13.3。

- 币安主站现货/合约 klines API **只有加密货币**（BTC/ETH/SOL…），**没有美股代币**。
- 币安 2021 年下架过股票代币；**2026-02 经 Ondo 合作以 `AAPLon/TSLAon/NVDAon/QQQon` 等回归，但挂在 Binance Alpha / Wallet，非主站 klines 通道**。
- v1 当时的判断是「走 Kraken xStocks（`TSLAx/AAPLx/…`）」——**v2 实测证伪**，见 13.2。

### 0.2 数据架构（已定：现有 Postgres 为主源）
- **主存储 = 你提供的现有 Postgres**（`crypto` 库，已有 K 线数据，但「不全」）。本项目**只读**其中 K 线表，不改动原项目表结构。
- **缺口补数**：加密的 **4h 由现有 1h 聚合派生**（不调外部 API）；**现货**从币安现货 API 回填；**链上美股**从链上 DEX 池回填，统一 upsert 进独立 `practice` schema。
- 资产对称保留：加密走币安（合约/现货两个市场），链上美股走链上 DEX（v2 更正）。

### 0.3 推荐技术栈（一句话）
**React + TypeScript + Vite + KLineChart（图表）+ zustand（状态）+ Node/TS 后端（读 Postgres + 缺口回填）+ 服务端内存缓存（v1 更正，原设计为 IndexedDB）**。

### 0.4 决策状态（见第 11 节）
- ✅ **全部已定并已落地**：v1 带后端；部署 = 单机同机连库；读写隔离落 `practice` schema；4h 由 1h 派生；
  **v2 补齐币安现货 + 链上美股两个市场 + `market` 维度进主键 + iPad/移动端专项适配**；实时盘留 v3。

---

## 1. 产品定位与目标

### 1.1 三个核心目标（对应你的诉求）
| 目标 | 产品如何支撑 |
|---|---|
| **刻意练习 K 线** | 多周期联动视图 + 形态练习题库 + 强制前置检查表 |
| **建立交易系统** | 可定义的规则集（趋势过滤/入场/止损/目标/仓位）+ 按「设置」打标签统计期望收益 |
| **提升实战经验** | hindsight-free 回放引擎（看不见未来）+ 模拟下单 + 复盘日志 + 过程指标 |

### 1.2 解决的真问题
- **后见之明偏差**：看历史「当然知道会涨」≠ 当时能做对。回放引擎把未来遮住，强制在「未知」中决策。
- **无结构化复盘**：凭记忆复盘会自我美化。系统强制记录决策理由 + 截图 + 对错归因。
- **情绪无数据**：FOMO / 报复单 / 移动止损 这些「过程失误」才是真瓶颈，单独建错误分类表。

---

## 2. 核心功能模块

| 模块 | 功能 | 优先级 | 说明 |
|---|---|---|---|
| 多周期 K 线视图 | 4h + 1h 双图联动、同步光标、指标叠加 | P0 | 4h 看趋势，1h 找入场 |
| 回放引擎 | 历史 K 线逐根揭示、未来遮挡、可前进/暂停 | P0 | **产品心脏** |
| 模拟交易 | 多/空、开仓价、止损、目标、仓位（R 风险） | P0 | 不接真实账户 |
| 交易日志 | 每笔必填：理由/计划/情绪/截图/复盘 | P0 | 强制结构化 |
| 交易系统构建 | 规则集定义 + 设置标签 + 期望统计 | P1 | 用数据迭代系统 |
| 数据看板 | 权益曲线、按设置胜率/期望、日历热力、错误分类 | P1 | 过程 > 结果 |
| 练习题库 Drills | 特定形态练习（如 4h 上升 + 1h 回踩 EMA 吞没） | P2 | 间隔重复弱项 |
| 实时模拟盘 | 接 WS 实时行情、模拟挂单 | P3 | v3，非 v1 |

---

## 3. 关键技术选型

| 层 | 选型 | 理由 | 备选 |
|---|---|---|---|
| 前端框架 | React + TS + Vite | 生态成熟、组件化、构建快 | Vue3 + Vite |
| **图表** | **KLineChart** | 内置 27 指标 + 画线工具 + 移动端 + 零依赖 ~50k | lightweight-charts（性能好但零指标/零画线，需自撸） |
| 状态管理 | zustand | 轻量、适合回放状态机 | Redux Toolkit |
| 本地存储 | localForage（IndexedDB） | 大数组（K 线）存储、离线私密 | localStorage（仅小元数据） |
| 后端（可选） | Node/Express 或 Serverless | 缓存历史 K 线、聚合多源、绕 CORS/限流 | v1 可纯前端直连 |
| 实时（v3） | Binance/Kraken WS | 实时模拟盘 | — |

**图表库对比结论**：练习场景要频繁画支撑/阻力/形态标注，KLineChart 开箱即用胜出；lightweight-charts 仅在你极致追求渲染性能且愿意自写指标/画线时考虑。

---

## 4. 数据方案（已实测 · Postgres 主源）

### 4.1 主源 K 线表（已确认，只读）
- 表：`biz.asset_klines`（1340 万行）。字段：
  `symbol text, interval text, open_time timestamptz(UTC), open_px/high_px/low_px/close_px numeric, base_vol/quote_vol numeric, trade_count bigint, fetched_at timestamptz`。
- **来源判定**：symbol 均为 `XXXUSDT`，属**币安 U 本位合约（永续/合约）klines**——天然满足「合约」场景。库内**无现货独立表、无美股代币**（现货如需，走币安 spot API 另取）。
- 连接串走环境变量 `DATABASE_URL`（`.env`，**不入库、不进任何交付文件**）。
- **读写隔离铁律**：只读 `biz.asset_klines`；本项目一切写入（用户交易/日志/统计、4h 派生、美股回填）落独立 `practice` schema，绝不 `ALTER`/`DELETE` 原表。

### 4.2 「不全」真相（实测）
- 现有 interval 仅 4 种：**1h(970万) / 5m(240万) / 15m(82万) / 1d(42万) —— 缺 4h**。
- 530 个 symbol，时间跨度 2019-09-08 → 2026-10-26。
- 新鲜度（1h）：242 个最新到 10-25+，287 个停在 10-01~10-24，1 个偏旧；主流币 BTC/ETH/SOL 1h 自 2022-12-27 起**连续无断档（33578/33578 根）**。
- **结论**：历史回放所需数据基本齐备；唯一结构性缺口是 **4h 周期 + 链上美股**。

### 4.3 4h 缺口解决方案：由 1h 聚合派生（不依赖外部 API）
- 4h = 每 4 根连续 1h 聚合成 1 根（`open=首根open, high=max, low=min, close=末根close, vol=sum`），按 `floor(open_time / 4h)` 对齐到 00/04/08/12/16/20 UTC。
- 派生结果物化进 `practice.kline_4h`（定时/按需重建），或查询时实时聚合（1h 数据量可控，实时聚合也快）。
- 好处：单一数据源、零额外 API、4h 与 1h 严格对齐，完美契合「4h 看趋势 + 1h 入场」。

### 4.4 链上美股（v1 决策已定 → Kraken xStocks；**v2 实测推翻**）
> ⚠️ 本节的 v1 判断**已被 v2 实测推翻**：币安与 Kraken 两条路都拿不到可用的链上美股 K 线。
> v2 实际采用：`Binance Alpha 资产清单 → GeckoTerminal 链上 OHLCV（多池合并 + 脏池剔除 + ffill）`，详见 13.2 / 13.3。

- 原库**无任何美股代币**数据 → 美股必须外取。v1 假设采用 **Kraken xStocks**：`TSLAx/AAPLx/NVDAx/SPYx/QQQx…`。
- 拉取后 upsert 进 `practice.klines`（复用同一套标准化结构），与加密走统一接口。

### 4.5 前端取数路径
- 前端 → 后端 `GET /api/klines?symbol=&market=&interval=&start=&end=` → 后端读 `practice.klines`（1h，perp/spot/stock 三市场同表）+ 4h 派生 → 返回标准化 `Kline[]`。
- 服务端进程内内存缓存（10min TTL）+ gzip；主缓存在服务端。

### 4.6 回放主源已落地
- 加密合约：币安合约 1h（从原库物化）+ 4h（派生）；**v2 追加**：币安现货 1h（回填）+ 链上美股 1h（链上 DEX 回填）。
- 「遮未来 → 决策 → 看结果」闭环的数据底座齐了。

---

## 5. 回放 / 模拟引擎设计（产品心脏）

### 5.1 数据模型
```
Kline { time, open, high, low, close, volume }
ReplayState {
  symbol, interval,
  bars: Kline[],        // 来自 Postgres / 缺口回填
  revealIndex: number,  // 已揭示到第几根（未来全部遮挡）
  trades: Trade[],      // 进行中+已平仓
  mode: 'play'|'pause'|'settle'
}
```

### 5.2 状态机
```
LOAD(取本地K线) → PLAYING(揭示N根) → USER_DECISION(开仓/跳过/标记)
   → ADVANCE(揭示下一根) → 更新持仓 mark-to-market
   → 触发止损/目标 → SETTLE(记录结果) → 回到 PLAYING
```

### 5.3 多周期联动（关键设计）
- 回放游标以 **1h 为基准**推进；每揭示 1 根 1h，`revealIndex++`。
- **4h 图**：每累计 4 根 1h 完成，才「长出」一根新的 4h 实体——保证 4h 永远比 1h「慢半拍」，符合「4h 看趋势、1h 入场」的真实决策节奏。
- 双图共享 `revealIndex`，光标联动高亮同一时间点。

### 5.4 交易生命周期
- 开仓：方向（多/空）、入场价（默认当前揭示 bar 收盘或限价）、止损、目标、仓位（以风险 R 计）。
- 每揭示一根 bar：更新浮盈/浮亏（mark-to-market）。
- 触发条件：价格触碰止损 → 平仓（亏损）；触碰目标 → 平仓（盈利）；或用户主动平仓。
- 评分字段：**R 倍数**（盈利/风险）、**是否按计划执行**、**对错归因**（设置对错 vs 执行对错）。

### 5.5 确定性
- 同一历史段可无限次重练（revealIndex 重置），用于「同一种形态练到形成肌肉记忆」。

---

## 6. 刻意练习方法论（让产品有灵魂）

- **设置库（Setup Taxonomy）**：把交易系统拆成可复用模式，例如：
  - 趋势：4h 均线多头排列 / 高点抬高低点抬高
  - 入场：1h 回踩 EMA + 看涨吞没 / 突破结构
- **前置检查表**（开仓前必勾）：趋势对吗？结构对吗？止损在哪？R 风险可接受吗？
- **后测复盘模板**（平仓后必填）：原计划 / 实际 / 偏差原因 / 情绪标签 / 可改进点。
- **间隔重复**：自动把「低胜率/常错」的设置排进后续练习队列。
- **过程指标 > 结果指标**：是否守规则、R 倍数分布、最大回撤、持仓时长。

---

## 7. 交易系统构建

- 用户定义**规则集**：趋势过滤器 / 入场触发 / 止损逻辑 / 目标逻辑 / 仓位规则。
- 每笔交易打 **设置标签**（如 `4h-up_1h-pullback`）。
- 积累后看板按设置聚合：**样本数 / 胜率 / 平均 R / 期望收益** → 用数据淘汰负期望设置、放大正期望设置，系统由此成型。

---

## 8. 数据看板 / 复盘

- 模拟权益曲线（含回撤标注）
- 按「设置」维度的胜率 / 期望 / 样本量矩阵
- 日历热力图（每日 R 盈亏）
- **错误分类表**：FOMO、报复单、移动止损、无设置交易、过早平仓…

---

## 9. 系统架构与里程碑

### 9.1 架构（文本图）
```
┌─────────────── 前端 (React+Vite) ───────────────┐
│  KLineChart 双图联动  │  回放状态机(zustand)       │
│  模拟交易/日志 UI     │  练习题库 / 看板           │
└───────────┬───────────────────────┬─────────────┘
            │  HTTP /api/klines      │ IndexedDB(轻缓存)
   ┌────────▼────────┐      ┌────────▼────────┐
   │  后端 Node/TS    │      │ 浏览器本地缓存   │
   │ 读Postgres+回填   │      └─────────────────┘
   └────────┬────────┘
            │ 读(原K线表)/写(practice schema)
   ┌────────▼──────────────────────┐
   │  现有 Postgres (crypto 库)      │
   │  原K线表(只读) + practice(读写) │
   └────────────────────────────────┘
            │ 缺口补数(按需)
   ┌────────┴────────┐
   │ Binance klines  │  Kraken xStocks
   └─────────────────┘
```

### 9.2 里程碑与功能 cut-line
| 版本 | 范围 | 关键交付 |
|---|---|---|
| **v1 MVP** | 后端读现有 Postgres（只读 K 线表）+ 缺口回填、KLineChart、4h+1h 双图、回放引擎、模拟下单、基础日志 | 跑通「遮未来 → 决策 → 看结果 → 复盘」闭环，数据主源落地 |
| v2 | 链上美股(Kraken xStocks)、画线/标注工具、练习题库、完整看板、错误分类 | 系统化练习 + 数据分析 |
| v3 | 实时模拟盘(WS)、云同步(Supabase)、AI 形态辅助标注、分享 | 接实时、跨设备 |

### 9.3 目录结构草案（v1）
```
src/
  chart/        # KLineChart 封装、双图联动
  engine/       # 回放状态机、交易生命周期、评分
  store/        # zustand 状态
  journal/      # 日志/复盘 UI
  stats/        # 看板计算
server/         # Node/TS 后端
  db/           # Postgres 连接、K线表只读适配、practice schema 读写
  exchanges/    # binance/kraken 适配、缺口回填
  routes/       # /api/klines 等
.env.example    # DATABASE_URL 占位（真实值用户自填）
```

---

## 10. 风险与边界

- **地域/合规**：xStocks 不向美/英/加/澳等开放；Binance Alpha 也有地域限制。练习工具本身不涉及实盘，但数据可用性受地域影响，部署时需考虑。
- **非投资建议**：界面与文档需明确「模拟练习，不构成投资建议」。
- **后见之明无法 100% 消除**：回放是离散 bar 级，真实市价单滑点/手续费未计入，需在结果中标注重建差异（可加 simulated fee/slippage 开关提升真实感）。
- **数据质量**：K 线源为交易所公开数据，偶有插针/停牌，回放时按原始数据呈现，不做清洗（保持真实）。

---

## 11. 待拍板决策

| # | 决策点 | 我的推荐 | 状态 |
|---|---|---|---|
| 11.1 | 链上美股源 | **Kraken xStocks**（原库无美股数据，已定） | ✅ 已定 |
| 11.2 | v1 是否带后端 | **必须带**（读 Postgres + 缺口回填） | ✅ 已定 |
| 11.3 | 部署形态 | 单机同机连 Postgres | ✅ 已定 |
| 11.4 | 实时模拟盘 | **v3 再做**，先打磨回放 | ✅ 已定 |
| 11.5 | 读写隔离 schema | 写入落独立 `practice` schema，只读 `biz.asset_klines` | ✅ 已定（已授权连库） |
| 11.6 | 美股 / 现货是否进 v1 | 美股先不做（v2）、现货另取币安 spot | ✅ 已定（v1 只做加密合约） |

> ⚠️ **凭据安全**：你提供的 `DATABASE_URL` 含明文密码，已出现在聊天中。建议：①仅放 `.env`，不提交、不进交付物；②部署后如担心泄露可重置该库密码。我方不会将其硬编码进任何代码/文档。

---

### 附：信息来源与时效
- 币安股票代币下架(2021) 与 Ondo 回归(2026-02)：The Block / CoinLaw 报道。
- Kraken xStocks 现货+永续 API、1100+ 标的：Kraken 官方 Blog / xstocks.com（2026）。
- 图表库对比：KLineChart 官网 / lightweight-charts GitHub（2026-10 时效）。
- 以上为公开信息快照，落地前对具体 API 字段与 pair 命名做一轮实测确认。

---

## 12. 实施结果（v1 落地复盘 · 2026-10-26）

### 12.1 交付清单
| 模块 | 状态 | 关键文件 |
|---|---|---|
| 后端 API + gzip + 内存缓存 | ✅ | `server/src/index.js`、`server/src/services/klineService.js` |
| `practice` schema（7 张表） | ✅ | `server/src/schema.js` |
| 1h 直取 + 4h 派生 | ✅ | `server/src/services/klineService.js::derive4h` |
| 按需物化（性能核心） | ✅ | `server/src/scripts/materialize.js` |
| 双图联动（4h 趋势 + 1h 入场） | ✅ | `web/src/components/DualChart.tsx` |
| 回放引擎（逐根揭示未来） | ✅ | `web/src/store/usePracticeStore.ts` |
| 开仓前置检查表 | ✅ | `web/src/components/TradePanel.tsx` |
| 强制复盘（阻断式） | ✅ | `web/src/components/JournalModal.tsx` |
| 统计看板（期望/分布/守规则率） | ✅ | `web/src/components/StatsView.tsx` |
| 设置库管理 | ✅ | `web/src/components/SetupLibrary.tsx` |
| 部署（systemd + nginx） | ✅ | `deploy/` |

### 12.2 与原设计的偏差（含原因）

| # | 原设计 | 实际落地 | 原因 |
|---|---|---|---|
| D1 | 前端 IndexedDB 缓存 | **后端进程内内存缓存 + gzip** | IndexedDB 缓存的是浏览器副本，多设备不一致且首次仍要拉全量；服务端缓存多设备一致、且把「首次拉取」也摊薄 |
| D2 | 「缺口回填 = 从交易所 API 拉」 | **先从原库物化到 `practice.klines`** | 原库已有完整 1h；且实测直读 1340 万行极慢。物化 = 零外部依赖 + 幂等增量 + 后续可无缝接交易所补数 |
| D3 | 「不在原表建索引」 | **严格遵守，未建任何索引** | 建索引会改变原项目存储与执行计划，越界。改为物化绕开 |
| D4 | 前端 TS + 后端 Node/TS | 后端用 **Node ESM JavaScript** | 零构建步骤，`node server/src/index.js` 直接跑，部署最简；前端保留 TS（类型是 KLineChart v10 这类复杂 API 的刚需） |
| D5 | 图表库 KLineChart | **确认 KLineChart，但必须用 v10** | v10 移除了 `applyNewData`，改为 `setDataLoader` + `subscribeBar` 增量模型；且 `setStyles` 不再支持 `'dark'` 字符串预设，须显式写深色样式 |

### 12.3 实测性能（关键）

| 场景 | 耗时 | 备注 |
|---|---|---|
| 全库 symbol 覆盖聚合（1340万行 GROUP BY） | **8.19s** | 因此改为 `practice.symbol_coverage` 缓存表 |
| 直读源表 3000 根 1h | **26.5s** | 索引不覆盖 OHLC 列，随机堆读 |
| 直读源表 3000 根（第二次） | 4.7 ~ 113s | **同一条查询时延随机跳变**，链路不稳定（overlay 隧道） |
| `EXPLAIN ANALYZE` 服务端执行耗时 | **1.3ms** | 证明瓶颈 100% 在传输层，不在 DB |
| 物化后读 3000 根（本地小表） | **< 50ms** | 物化方案生效 |
| `/api/symbols`（读缓存表） | 0.58s | 链路往返占比高 |
| `/api/klines` gzip 后传输量 | **56KB**（原 248KB） | 4.4× 压缩比 |
| 物化 1 个标的 | 1.2 ~ 3.7s | 3.3 万行 `INSERT...SELECT` |

**结论**：同机部署（应用与 DB 同机，localhost 连接）时以上网络问题全部消失；跨机访问时靠「物化 + 内存缓存 + gzip」三重措施兜住。

### 12.4 踩坑记录

1. **pg 8.23 的 SSL 语义变更**：`sslmode=require` 被当作 `verify-full`，自签证书直接报 `DEPTH_ZERO_SELF_SIGNED_CERT`。且 pg 会用连接串解析出的 `ssl` **覆盖** Pool 传入的选项。解法：在 `db.js` 内部把 `require/prefer/verify-ca` 翻译为 pg 专用的 `no-verify`。
2. **SQL 拼接把 ORDER BY 塞进 WHERE**：`WHERE ... AND ORDER BY ... LIMIT` → `syntax error at or near "ORDER"`。占位符与条件列表必须分开构建。
3. **KLineChart v10 API 断层**：`applyNewData` 已移除；`setStyles` 不认 `'dark'`；`createIndicator` 签名变为 `(value, isStack?)`；`Indicator.paneId` 决定指标落在哪个面板。
4. **`setDataLoader` 的调用顺序**：`setSymbol` / `setPeriod` 内部都会 `resetData` 触发 init 装载，所以必须**最后**调用 `setDataLoader`，否则会先用旧 loader 灌一遍旧数据。
5. **同一时间戳的 `update` 会原地替换最后一根柱** —— 这正是「形成中的 4h 蜡烛」能平滑更新的机制。
6. **统计里的 `avg(interval)` 不可直接转数字**：Postgres interval 要用 `extract(epoch from ...)` 才能拿到秒数。

### 12.5 验证结果（端到端）

| 验证项 | 方法 | 结果 |
|---|---|---|
| 4h 聚合正确性 | 服务端随机抽一根 4h，与手工聚合 1h 逐字段比对 | ✅ OHLC 完全一致 |
| 原表零污染 | 建表前后 `biz.asset_klines` 行数 + max(open_time) 比对 | ✅ 13,403,326 行未变，无越界写入 |
| 写入隔离 | 全库 schema 清点 | ✅ 写入全在 `practice`，未在其它 schema 建表 |
| 完整交易闭环 | 无头 Edge 驱动真实 UI：选设置 → 勾检查表 → 开仓 → 推进触发止损 → 强制复盘 → 统计更新 | ✅ 全通，无 JS 错误 |
| 仓位数学 | 入场 84,167.3 / 止损 83,999.0 / 风险 $100 → 数量 0.5942 | ✅ 与公式一致（100/168.3） |
| 出场数学 | 平仓价 = 止损价 → 盈亏 -$100 → R = -1.00 | ✅ 与公式一致 |
| 图表渲染 | 截图目视 + canvas 像素非空检测 | ✅ 双图 + 指标 + 标注线均正常 |
| 回放推进 | 单步按钮前后游标比对 | ✅ 481/1200 → 482/1200 |

### 12.6 v2 待办（按优先级）

1. **链上美股（Kraken xStocks）**：现货 + 永续 K 线回填进 `practice.klines`，复用现有物化/缓存/派生链路，几乎零架构改动。
2. **币安现货**：同上，走 `/api/v3/klines` 回填。
3. **图表画线标注 + 十字光标双图联动**：练 K 线需要画支撑阻力。
4. **练习题库**：按设置生成「形态识别」题（只给图不给未来）。
5. **弱项间隔重复**：基于设置期望值自动排期复练。
6. **实时模拟盘**：接 WebSocket 增量推送，走同一套交易/复盘链路。
7. **多用户 + 云同步**：目前是单用户本地存储。

---

## 13. v2 实施结果（三市场 + 移动端 · 2026-10-26 定稿，2026-10-27 复验 + 性能优化）

### 13.1 结论先撂

| 目标 | 状态 | 关键结论 |
|---|---|---|
| 币安现货数据源 | ✅ 已落地 | 12 标的 / 365 天 / 8760 根 / **0 缺口**，币安现货天然连续 |
| 链上美股数据源 | ✅ 已落地 | 8 标的，**Binance Alpha 清单 → GeckoTerminal 链上 OHLCV**（Kraken xStocks 已被证伪，见 13.3） |
| `market` 维度 schema 改造 | ✅ 已落地 | 3 张表主键改复合主键 + 会话/交易/复盘加 `market` 列，148 万行重建主键 22.5s |
| API / 前端多市场支持 | ✅ 已落地 | 市场 Tab + 市场内标的过滤 + 统计按市场隔离 |
| iPad / 移动端适配 | ✅ 已落地 | 4 个触摸视口全部 0 溢出 / 0 小触控目标 / 0 JS 错误 |

### 13.2 「币安上的链上美股」必须澄清（v1 设计的错误）

v1 假设「币安有链上美股合约 → 走币安 fapi klines 回填」。**实测证伪**：

- 币安 U 本位合约 `AssetPairs` 1463 对 + `Futures` 231 个标的里，**美股命中 0 个**；
- `TSLAXUSD` 这类 Kraken xStocks 符号在币安直接返回 `Invalid arguments`；
- **Binance Alpha（RWA）没有 klines 端点**，4 种路径变体全部 404；
- Hyperliquid 的 `cash:TSLA` 返回 `[]`，`metaAndAssetCtxs` 显示 `isDelisted: true`（对照 `xyz:XYZ100` 正常）。

**最终数据链路**：`Binance Alpha 资产清单`（拿 symbol / 链 / 合约地址）
→ `GeckoTerminal` 查该代币的 DEX 池（按 24h 成交额取前 4）
→ 各池小时级 OHLCV（= 代币的链上成交价 K 线）
→ 跨池合并。

### 13.3 链上美股三个坑（都踩过并已解决）

**① 多池合并（单池历史深度不足）**
单池历史深度取决于池子何时建立 —— 实测同一批标的里 `NVDAON` 单池 1162 根，`MSTRON` 只有 3 根、`HIMSON` 22 根。
不同池活跃期互补，合并后 `QQQON` 436→901 根、`MSTRON` 3→22 根。

**② 脏池剔除（低流动性池成交价严重偏离）**
实测 `SPYON` 历史里出现过 388（真值约 768）、`CRCLON` 出现过 0.07、`MUON` 出现过 1114。
直接取 `max(high)/min(low)` 会被这些脏点放大。
合并规则改为：先按中位 close 剔除偏离 >3% 的池 → 剩余池 `high=max / low=min / close=中位数`，
`open` 取与中位 close 最接近那个池的开盘价，`volume` 求和。

**③ 低流动性时段前向填充（ffill）—— v2 最重要的一个决定**
链上美股 24/7 交易但流动性极低，没有成交的小时 GeckoTerminal 根本不返回那一根。实测 1h 覆盖率：

| 标的 | 1h 根数 | 时间跨度 | 覆盖率 | 4h 桶覆盖 |
|---|---|---|---|---|
| NVDAON | 1162 | 1440h | 80.7% | 355/360 |
| QQQON | 901 | 1361h | 66.2% | 322/341 |
| SPYON | 843 | 1361h | 61.9% | 325/341 |
| CRCLON | 712 | 1361h | 52.3% | 303/341 |
| MUON | 434 | 1351h | 32.1% | 238/338 |
| IVVON | 5 | 578h | **0.9%** | 5/145 |
| HIMSON | 23 | 734h | **3.1%** | 21/184 |
| MSTRON | 22 | 1243h | **1.8%** | 20/311 |

小时分布是 24 小时均匀的（**不是美股休市造成的**），纯粹是流动性问题。
稀疏的 1h 会连累 4h 派生 —— 4h 桶缺成员，形态就不完整。

**解法**：`fillGaps()` 对空洞 ≤6h 的做前向填充（OHLC 全取前收、成交量 0），
>6h 的**不填**（那是数据源本身缺这段，硬填会造出假形态）。
填充行 `source` 标记 `geckoterminal_ffill`，可审计；前端顶部提示「本序列含 N 根填充哑线」。

填充前后：

| 标的 | 填充前 | 填充后 | 长空洞（未填） |
|---|---|---|---|
| CRCLON | 711 | **1172** | 22 处 |
| SPYON | 842 | **1305** | 7 处 |
| QQQON | 900 | **1289** | 9 处 |
| MUON | 434 | **846** | 48 处 |

**④ 数据健康度审计（下架过稀标的）**
回填完自动统计「真实成交根数」（`source <> 'geckoterminal_ffill'`），
<200 根的直接 `enabled=false` 下架，并把覆盖率写进 `external_ref.dataHealth`，前端在标的下拉里显示真实成交占比。
实测 `IVVON` / `HIMSON` / `MSTRON` 会被下架 —— 这种标的拿去练习没有意义。

### 13.4 `market` 维度进主键

同一个 `BTCUSDT` 在合约和现货两个市场都存在，主键里必须带 `market` 才不会互相覆盖。

| 表 | 旧主键 | 新主键 |
|---|---|---|
| `practice.klines` | (symbol, interval, open_time) | **(market, symbol, interval, open_time)** |
| `practice.symbols` | (symbol) | **(market, symbol)** |
| `practice.symbol_coverage` | (symbol, interval) | **(market, symbol, interval)** |
| `practice.sessions/trades/journal_entries` | — | 新增 `market` 列 |

迁移必须显式 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`：
`CREATE TABLE IF NOT EXISTS` 对已存在的表是 **no-op**，只写 DDL 会发现列根本没加上。
另外上次迁移在 `DROP CONSTRAINT` 之后中断会留下**无主键表**，迁移逻辑要能识别 `rows.length === 0` 并直接补建。

### 13.5 移动端 / iPad 适配（v2 追加）

**为什么单列 + Tab 切换**：iPhone 竖屏 390px 宽塞两张图，每张只剩 296px，K 线形态根本看不清。
窄屏改成单图 + `4h · 趋势` / `1h · 入场` 两个 Tab，iPad 及以上保持双图并排。

**触控目标 ≥44px**：`.input` / `select` / `textarea` / `.btn` / `.tab` 在 `@media (pointer: coarse)` 下统一顶到 44px。
速度按钮（0.5s/1s/2s/4s）原本 29×23，四连排 44px 仍塞得进 390px。

**输入框字号 ≥16px**：`.input` 类选择器特异性高于元素选择器，基础层的 `input { font-size: 16px }` **盖不住** `.input { font-size: 12px }`。
解法：`@media (any-pointer: coarse) { .input, input, select, textarea { font-size: 16px !important } }`
（用 `any-pointer` 而非 `pointer`：iPad 插着触控板时主指针仍可能是 fine）。

**回放条必须 `fixed` 不是 `sticky`**：`position: sticky; bottom: 0` 在「元素不在文档流末尾」时**完全不生效**
（实测 computed = `static`，iPhone 视口下控制条在首屏之外）。
改成 `position: fixed; bottom: 0`，`right` 用 CSS 变量 `--side-col` 对齐右侧交易面板宽度，
避免遮挡「开仓」按钮；单列布局（≤1100px）时通栏。

**副图高度必须自适应**：klinecharts 给副图（VOL）分配的默认高度是**固定 100px**（minHeight 30），
主图吸收剩余空间。矮屏（图表容器仅 200px）时副图吃掉一半，蜡烛主图被压成 **69px 的缝**。
解法：新增 `applyPaneHeights()`，按容器高度给副图分配 26%（夹在 48–100px），主图吃掉剩余空间。
实测矮屏主图 69px → **117px**，iPad 竖屏 223px → **231px**。

**矮屏横屏顶栏压成一行**：iPhone 横放 844×390 时，市场 Tab 与搜索框并排（`.symbol-picker` 改 flex-row），
顶栏从两行降到一行，省下约 35px 垂直空间；图表高度改为 `clamp(180px, calc(100dvh - 190px), 220px)` 随视口自适应。

**多视口实测（Chromium 设备仿真，2026-10-26）**

| 视口 | 横向溢出 | 溢出元素 | 小触控目标 | 输入框字号 | 回放条 | 图表 painted | JS 错误 |
|---|---|---|---|---|---|---|---|
| iPad 横屏 1180×820 | ❌ | 0 | **0** | 16px | fixed, gap 0 | ✅ | 0 |
| iPad 竖屏 820×1180 | ❌ | 0 | **0** | 16px | fixed, gap 0 | ✅ | 0 |
| iPhone 竖屏 390×844 | ❌ | 0 | **0** | 16px | fixed, gap 0 | ✅ | 0 |
| iPhone 横屏 844×390 | ❌ | 0 | **0** | 16px | fixed, gap 0 | ✅ | 0 |
| 桌面 1440×900 | ❌ | 0 | — (鼠标) | 12px | static | ✅ | 0 |

### 13.6 端到端验证（三市场闭环）

| 验证项 | perp | spot | stock |
|---|---|---|---|
| 1h 连续性（0 缺口） | ✅ 0 | ✅ 0 | ⚠️ 见 13.3（ffill 后剩 22 处 >6h 长空洞） |
| 4h 与 1h 桶严格对齐 | ✅ 301/301 | ✅ 301/301 | ✅ 312（本地桶 312，服务端一致） |
| 建会话（market 落库） | ✅ | ✅ | ✅ |
| 开仓 / 平仓 / R 倍数 | ✅ R=2.00 | ✅ R=2.00 | ✅ R=2.00 |
| 强制复盘落库 | ✅ | ✅ | ✅ |
| 统计按市场过滤 | ✅ | ✅ | ✅ |
| **市场隔离**（A 市场数据不串到 B） | ✅ 3× | ✅ 3× | ✅ 3× |

多市场闭环 **36/36 全通过**（2026-10-27 复验）。
首轮 34/36 的 2 项失败都是链上美股的数据稀疏问题，已用 ffill + 健康度审计解决。

浏览器端闭环（真实点击开仓/平仓/复盘）：**5/5 通过，0 条 JS 错误**
（perp 桌面 / spot 桌面 / stock 桌面 / perp iPad / stock iPhone）。
仓位数学精确：R = 2.00、PnL = 200.00，无浮点漂移。

### 13.7 性能与链路实测（v2 追加 · 2026-10-27）

**先撂结论**：慢的不是数据库，是**链路**。DB 服务端执行 1.1ms，跨机往返 387ms/次。

| 环节 | 实测 | 判定 |
|---|---|---|
| PG 服务端执行（索引反向扫描，873 buffer） | 1.1ms | ✅ 无问题 |
| HTTP 响应传输（gzip 后 49KB） | 27ms | ✅ 无问题 |
| DB 链路往返 | **387ms/次** | ⚠️ 瓶颈 |
| DB 链路传数据 | **≈1.3ms/行** | ⚠️ 瓶颈（1172 行 ≈ 1.5s） |

根因：`tailscale ping` 显示走 **DERP 中继（东京 tok）RTT 271ms**，非点对点直连；
跨机带宽被压到 ~195KB/s，于是「取多少行」直接决定耗时。

**三层应对（已落地）**

1. **修内存缓存命中判定的真 bug**：原判定 `bars.length >= limit`，
   而 `CRCLON` 库里只有 1172 根、请求 limit=1200 → 条件永不成立 → 每次穿透 DB。
   改为 `bars.length >= limit || exhausted`（`exhausted` = 取回数 < limit ⇒ 库里没有更多）。
2. **启动预热**（`PREWARM`，默认开）：后台并发拉取全部 enabled 标的（实测 77 个，约 60s）。
3. **stale-while-revalidate**：缓存过期后先返回旧数据、后台静默刷新，用户不卡顿。

另外 `ensureMaterialized` 增量检查加 5 分钟 TTL（每次「查 coverage + 查源表 max」
= 2 次额外往返 = 774ms 跨机成本），`spot`/`stock` 直接跳过。

| 场景 | 优化前 | 优化后 |
|---|---|---|
| stock `CRCLON` 冷读（1172 根） | 1982ms | 20ms |
| perp `BTCUSDT` 冷读（1200 根） | 2729ms | 18ms |
| TTL 过期后的请求 | 2000ms（同步阻塞） | **12ms**（SWR 快返） |
| 跨 TTL 边界连续 6 次 | 每次 2s | 19~27ms |

> **部署到 DB 同机后链路问题自动消失**（回环带宽 GB/s）。
> 本节优化在同机部署时仍有价值：首屏零等待、TTL 边界不卡顿。

### 13.8 v2 遗留与 v3 待办

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | 现货/链上美股自动定时回填 | ❌ 未做 | 目前靠脚本手动跑；生产化应加 cron |
| 2 | 链上美股 5m/15m 周期 | ❌ 未做 | 只回填 1h，4h 由 1h 派生 |
| 3 | 图表画线标注 + 十字光标双图联动 | ❌ 未做 | v3 补 |
| 4 | 练习题库 / 弱项间隔重复 | ❌ 未做 | v3 补 |
| 5 | 实时模拟盘（WebSocket 增量） | ❌ 未做 | v3 补 |
| 6 | 多用户 + 云同步 | ❌ 未做 | 单用户本地存储 |
| 7 | 链上美股真实成交比例 | ⚠️ 固有 | 链上池子流动性低，UI 已标注真实成交占比，但不可能等同传统交易所的连续行情 |

