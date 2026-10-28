import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  dispose,
  init,
  type Chart,
  type Coordinate,
  type DataLoader,
  type DeepPartial,
  type KLineData,
  type Styles,
} from 'klinecharts';
import type { Bar, ChartPeriod, Market, OpenTrade } from '../types';
import { derive4h, fmtPrice, fmtTime, pricePrecision, FOUR_HOURS, HOUR } from '../engine/bars';
import { dir, fmtCompact, fmtPct, fmtSigned } from '../engine/format';
import { getIndicatorSpec, splitByGroup, type IndicatorSpec } from '../engine/indicators';
import { api } from '../api';

/** 向左无限加载历史 K 线时，单次从后端拉取的批次大小（1h / 15m 通用） */
const HISTORY_CHUNK = 500;

const CANDLE_PANE = 'candle_pane';
const TRADE_GROUP = 'trade-lines';

/**
 * 画线工具的 overlay 分组。
 *
 * 与 TRADE_GROUP 分开：交易线（入场/止损/目标）是**系统画的**，要跟着交易状态更新；
 * 用户手画的线是**用户的**，切周期要保留、换标的要清掉（对不上新标的）。
 * klinecharts 换 symbol 时会自动清掉非内置 overlay —— 实测切周期保留、换标的清空 ✅
 */
const DRAW_GROUP = 'drawing';

/**
 * 可用的画线工具。
 *
 * ⚠️ klinecharts **基础包只内置 3 种**画线（实测逐个试 createOverlay）：
 *   segment（趋势线，2 点）、horizontalStraightLine（水平线，1 点）、priceLine（价格线，1 点）。
 *   ray / verticalLine / parallelLine / fibonacci / rect / circle / arrow / text
 *   在基础包里 createOverlay 返回 null —— 那是 pro 版的扩展，别写进 UI 里点了没反应。
 */
const DRAW_TOOLS: Array<{
  name: string;
  label: string;
  icon: string;
  points: 1 | 2;
  /** 单点工具的默认纵向位置（比例）—— 错开，免得画出来叠在一起 */
  yRatio: number;
}> = [
  { name: 'segment', label: '趋势线', icon: '╱', points: 2, yRatio: 0 },
  { name: 'horizontalStraightLine', label: '水平线', icon: '─', points: 1, yRatio: 0.32 },
  { name: 'priceLine', label: '价格线', icon: '≡', points: 1, yRatio: 0.58 },
];

/**
 * 预热窗口：练习起点之前保留多少根 1h K 线喂给图表（1h / 4h 口径）。
 *
 * 为什么必须留：技术指标（MA60 / BOLL / EMA…）需要足够的历史才能算出值。
 * 如果只喂「起点之后」的数据，起点那根的指标全是空的 —— 用户看到的第一屏
 * 没有任何依据，「4h 看趋势」这条规则根本落不了地。
 *
 *   - 1h：240 根 1h（= 240 小时）
 *   - 4h：240 根 1h = 60 根 4h（= 240 小时）
 *
 * ⚠️ v6.3 踩过两次坑，这里是最终定稿：
 *
 * ① **别把「预热窗口」和「可见跨度」当成一回事**。
 *    对齐要求的是**可见根数按周期成比例**（VISIBLE_BARS），预热窗口是另一件事 ——
 *    它决定「指标能算出多少值」「起点前的历史在不在视野内」。
 *
 * ② **别为了对齐把 1h 档压得太密**。
 *    试过「1h 480 根（≈2px/根）+ 4h 120 根」来同时满足「4h 覆盖全部预热」
 *    和「4:1 严格对齐」—— 结果 **1h 档的 K 线比 15m/4h 都小**（用户实测反馈：
 *    「1h k线图比其他两个图表显示都小」），2px/根的实体根本看不清形态。
 *    现在改成 **1h 240 根（≈4px/根）+ 4h 60 根（≈16px/根）**：
 *    仍是 4:1（跨度都是 240 小时）⇒ 严格对齐不变，
 *    1h 档回到可读密度，4h 档也刚好覆盖自己的全部预热（60 根可见 = 60 根预热）。
 */

// 1h / 4h 的预热根数（按 1h 计）：起点前 240 根 1h = 60 根 4h（= 240 小时）。
const WARMUP_1H: Record<'4h' | '1h', number> = { '4h': 240, '1h': 240 };
// 15m 的预热根数：960 根 15m = 240 小时，与 1h / 4h 口径一致（切换周期时视野长度不变）。
const WARMUP_15M = 960;

/**
 * 预热窗口左端（1h 索引）。
 *
 * 以锚点往回取 WARMUP_1H 根历史。左端还要对齐到 4h 桶边界 —— 不对齐的话，
 * 派生出来的第一根 4h 是个残桶（缺前面几根 1h），它的 OHLC 与成交量都是错的，会污染指标。
 *
 * 注意锚点要先换成**时间戳**再对齐：索引和毫秒是两套单位，混用会算飞。
 */
function calcWindowStart(bars1h: Bar[], anchor: number, period: '4h' | '1h'): number {
  if (anchor < 0 || !bars1h.length) return 0;
  const anchorBar = bars1h[anchor];
  if (!anchorBar) return 0;
  const rawTime = anchorBar.time - WARMUP_1H[period] * HOUR;
  const alignedTime = Math.floor(rawTime / FOUR_HOURS) * FOUR_HOURS;
  const idx = bars1h.findIndex((b) => b.time >= alignedTime);
  return idx < 0 ? 0 : idx;
}

/**
 * 预热窗口的锚点索引。
 *
 * 取「练习起点」与「当前游标」里较小的那个：
 * 回看模式（cursor < startCursor）时若还用 startCursor 当锚点，
 * 窗口左端会跑到游标右边 → 切片为空 → 图表直接空白。
 */
function resolveAnchor(startCursor: number, cursor: number): number {
  if (cursor < 0) return -1;
  if (startCursor < 0) return cursor;
  return Math.min(startCursor, cursor);
}

/**
 * 15m 的窗口（独立序列，按时间戳切）。
 *
 * 15m 是**独立序列**（不是从 1h 派生的），所以窗口按时间戳切：
 *   - **左端**：`0`（全部已加载历史都可见 —— 起点之前的历史可随滚动/缩放一直往左加载，见 v6.4 无限左加载）
 *   - **右端**：当前 1h 游标所在小时的**小时末**
 *
 * ⚠️ 右端口径是「对齐」的关键（v6.3 修）：
 *   1h 档右端 = 包含当前时刻的那根 1h（bars1h[cursor]，引擎已揭示其 OHLC）；
 *   15m 档右端 = 包含当前时刻的那根 15m（开盘 ≤ cursorMs 的最后一根）。
 *   两者**同构** —— 同一时刻、同一根的起点 ⇒ 落在同一个横坐标上。
 *
 *   旧实现右端取 `cursorBar.time + 1h`（= 当前小时的**末尾**）：
 *   那一根 15m 的收盘发生在当前时刻**之后** ⇒ 提前泄露了最多 45 分钟的未来，
 *   而且与 1h 档的右端差了一根 15m 的宽度 ⇒ 切周期时右边对不齐。
 *
 * 语义边界（为什么右端可以落在「当前这一根」内部）：
 *   15m 图 = 引擎**已经揭示**的那一小时 + 这一小时内部的 15m 路径。
 *   当前这根 1h 已经在引擎里了（bars1h[cursor]），引擎知道它的 OHLC；
 *   15m 视图额外展示这一小时**内部的走势** —— 这正是「精入场」要看的东西。
 *   关键红线：绝不显示 cursor **之后**的任何数据（未来）。
 */
function calcWindow15m(
  bars15m: Bar[],
  bars1h: Bar[],
  anchor: number,
  cursorIdx: number,
  cursorMs: number,
): { from: number; to: number } {
  if (!bars15m.length || anchor < 0 || cursorIdx < 0) return { from: 0, to: -1 };
  const anchorBar = bars1h[anchor];
  if (!anchorBar) return { from: 0, to: -1 };

  // 当前时刻：优先用 cursorMs（可精确到 15m 内部），否则退回 cursor 那根 1h 的开盘
  const now = cursorMs >= 0 ? cursorMs : (bars1h[cursorIdx]?.time ?? -1);
  if (now < 0) return { from: 0, to: -1 };

  // 15m 序列里「开盘时间 ≤ 当前时刻」的最后一根 —— 与 1h 档右端同构（右端 = 当前时刻，绝不泄露未来）
  let to = -1;
  for (let i = 0; i < bars15m.length; i++) {
    if (bars15m[i].time <= now) to = i;
    else break;
  }
  if (to < 0) return { from: 0, to: -1 };

  // 左端 = 锚点往前 WARMUP_15M 根 15m（= 240 小时，与 1h / 4h 口径一致）。
  // 更久远的历史由图表滚动/缩放到左边缘时按需从后端拉取（forward loader）。
  const fromTime = anchorBar.time - WARMUP_15M * 15 * 60 * 1000;
  let from = 0;
  for (let i = 0; i <= to; i++) {
    if (bars15m[i].time >= fromTime) {
      from = i;
      break;
    }
  }
  return { from, to };
}

/** 币安配色：涨 #0ECB81（绿） / 跌 #F6465D（红），网格极淡，数字统一 #EAECEF */
const BINANCE_STYLES: DeepPartial<Styles> = {
  grid: {
    show: true,
    horizontal: { color: 'rgba(255,255,255,0.04)', style: 'solid' },
    vertical: { color: 'rgba(255,255,255,0.04)', style: 'solid' },
  },
  candle: {
    type: 'candle_solid',
    bar: {
      upColor: '#0ECB81',
      downColor: '#F6465D',
      noChangeColor: '#848E9C',
      upBorderColor: '#0ECB81',
      downBorderColor: '#F6465D',
      upWickColor: '#0ECB81',
      downWickColor: '#F6465D',
      noChangeBorderColor: '#848E9C',
      noChangeWickColor: '#848E9C',
    },
    priceMark: {
      show: true,
      high: { color: '#848E9C', textSize: 10 },
      low: { color: '#848E9C', textSize: 10 },
      last: {
        show: true,
        upColor: '#0ECB81',
        downColor: '#F6465D',
        noChangeColor: '#848E9C',
        text: { size: 10, color: '#848E9C' },
      },
    },
    tooltip: {
      showRule: 'follow_cross',
      showType: 'standard',
    },
  },
  xAxis: {
    show: true,
    axisLine: { color: 'rgba(255,255,255,0.12)' },
    tickLine: { color: 'rgba(255,255,255,0.12)' },
    tickText: { color: '#848E9C', size: 10, family: 'inherit', weight: 'normal', marginStart: 8, marginEnd: 8 },
  },
  yAxis: {
    show: true,
    axisLine: { color: 'rgba(255,255,255,0.12)' },
    tickLine: { color: 'rgba(255,255,255,0.12)' },
    tickText: { color: '#848E9C', size: 10, family: 'inherit', weight: 'normal', marginStart: 4, marginEnd: 8 },
  },
  separator: { size: 1, color: 'rgba(255,255,255,0.06)', fill: true, activeBackgroundColor: 'rgba(255,255,255,0.03)' },
  crosshair: {
    show: true,
    horizontal: {
      show: true,
      line: { color: 'rgba(255,255,255,0.35)', style: 'dashed', dashedValue: [2, 2] },
      text: {
        show: true,
        color: '#EAECEF',
        size: 10,
        family: 'inherit',
        weight: 'normal',
        backgroundColor: '#2B3139',
        borderRadius: 2,
        paddingLeft: 4,
        paddingRight: 4,
        paddingTop: 2,
        paddingBottom: 2,
      },
    },
    vertical: {
      show: true,
      line: { color: 'rgba(255,255,255,0.35)', style: 'dashed', dashedValue: [2, 2] },
      text: {
        show: true,
        color: '#EAECEF',
        size: 10,
        family: 'inherit',
        weight: 'normal',
        backgroundColor: '#2B3139',
        borderRadius: 2,
        paddingLeft: 4,
        paddingRight: 4,
        paddingTop: 2,
        paddingBottom: 2,
      },
    },
  },
};

interface Feed {
  current: KLineData[];
  subCb?: (d: KLineData) => void;
  loader: DataLoader;
}

interface FeedDeps {
  symbolRef: React.MutableRefObject<string>;
  marketRef: React.MutableRefObject<Market>;
  periodRef: React.MutableRefObject<ChartPeriod>;
  loadingHistRef: React.MutableRefObject<boolean>;
  hist1hRef: React.MutableRefObject<Bar[]>;
  hist15Ref: React.MutableRefObject<Bar[]>;
  bars1hRef: React.MutableRefObject<Bar[]>;
  bars15mRef: React.MutableRefObject<Bar[]>;
  cursorRef: React.MutableRefObject<number>;
  startCursorRef: React.MutableRefObject<number>;
  cursorMsRef: React.MutableRefObject<number>;
  suppressForwardRef: React.MutableRefObject<boolean>;
  setHist1h: React.Dispatch<React.SetStateAction<Bar[]>>;
  setHist15: React.Dispatch<React.SetStateAction<Bar[]>>;
}

/** 合并两个 Bar[] 并按时间升序去重（按 time 去重，后者覆盖前者） */
function mergeSortedBars(a: Bar[], b: Bar[]): Bar[] {
  const map = new Map<number, Bar>();
  for (const x of a) map.set(x.time, x);
  for (const x of b) map.set(x.time, x);
  return [...map.values()].sort((x, y) => x.time - y.time);
}

/**
 * 创建 feed（图表数据源）。
 *
 * ⚠️ klinecharts 的 DataLoader 方向与直觉相反：
 *   - `init`     —— 初始装载（已揭示切片）。
 *   - `forward`  —— **左边缘**（from === 0）触发，要回传**更老的** K 线，klinecharts 用
 *                   `data.concat(_dataList)` **前插**到列表头部，并自动维持滚动位置。
 *                   这是「向左无限加载历史」的唯一钩子。
 *   - `backward` —— **右边缘**（to === totalBarCount）触发，要回传**更新的** K 线（未来）。
 *                   本产品右端锚定游标（绝不泄露未来），所以这里一律返回 [] 且 more=false。
 *
 * 历史纯展示用：loader 拉取后合并进 hist1h / hist15（state + ref），由 revealed 与 activeBars
 * 自动重算并驱动图表；feed.current 镜像同步更新，避免 syncFeed 误判 head 变化而 resetData。
 */
function createFeed(deps: FeedDeps): Feed {
  const {
    symbolRef,
    marketRef,
    periodRef,
    loadingHistRef,
    hist1hRef,
    hist15Ref,
    bars1hRef,
    bars15mRef,
    cursorRef,
    startCursorRef,
    cursorMsRef,
    suppressForwardRef,
    setHist1h,
    setHist15,
  } = deps;

  const feed: Feed = {
    current: [],
    loader: {
      getBars: (params) => {
        if (params.type === 'init') {
          // 必须声明 forward:true（左边缘可继续加载历史），backward:false（不泄露未来）
          params.callback(feed.current.slice(), { forward: true, backward: false });
          return;
        }
        if (params.type === 'backward') {
          // 右边缘：无未来数据，返回空且 more=false 阻止继续向右加载
          params.callback([], false);
          return;
        }
        if (params.type === 'update') {
          params.callback([]);
          return;
        }
        // params.type === 'forward'：左边缘 → 补齐更早的 K 线（起点之前的历史上下文）
        if (loadingHistRef.current) return; // 重入保护：丢弃本次，避免并发重复拉取
        // resetData 后短暂抑制：klinecharts 把 resetData 的 from=0 当成"用户滚到左边缘"
        if (suppressForwardRef.current) {
          params.callback([], { forward: true, backward: false });
          return;
        }
        const firstTs = feed.current[0]?.timestamp;
        if (firstTs == null) {
          params.callback([], false);
          return;
        }
        const interval: '1h' | '15m' = periodRef.current === '15m' ? '15m' : '1h';
        loadingHistRef.current = true;
        const run = async () => {
          try {
            const { bars, exhausted } = await api.klinesHistory(
              symbolRef.current,
              marketRef.current,
              interval,
              firstTs,
              HISTORY_CHUNK,
            );
            if (!bars.length) {
              params.callback([], false);
              return;
            }
            // 合并进历史（ref 同步 + state 触发 revealed*/activeBars 重算）
            if (interval === '15m') {
              const merged = mergeSortedBars(hist15Ref.current, bars);
              hist15Ref.current = merged;
              setHist15(merged);
            } else {
              const merged = mergeSortedBars(hist1hRef.current, bars);
              hist1hRef.current = merged;
              setHist1h(merged);
            }
            // 拼装「历史 + 已揭示」的完整原始序列（4h 由 1h 派生），取旧首根之前的一段作为前插展示。
            // 注意：不能用 bars1h.slice(0, cursor+1) 全量塞爆 —— 必须对齐预热窗口 revealStart，
            // 否则 forward 刚触发就把 742 根全量塞到 feed.current 镜像里（v6ui 初始态回归）。
            const h1 = hist1hRef.current;
            const h15 = hist15Ref.current;
            const b1h = bars1hRef.current;
            const b15 = bars15mRef.current;
            const c = cursorRef.current;
            const sc = startCursorRef.current;
            const anchor = resolveAnchor(sc, c);
            const ws1h = (() => {
              if (c < 0 || !b1h.length) return 0;
              return calcWindowStart(b1h, anchor, '1h');
            })();
            const revealed1hLen = c >= 0 ? b1h.slice(ws1h, c + 1) : [];
            const revealed15m = (() => {
              if (c < 0 || !b15.length) return [];
              const w = calcWindow15m(b15, b1h, anchor, c, cursorMsRef.current);
              return w.to < w.from ? [] : b15.slice(w.from, w.to + 1);
            })();
            const fullRaw: Bar[] =
              periodRef.current === '4h'
                ? derive4h([...h1, ...revealed1hLen])
                : periodRef.current === '15m'
                  ? [...h15, ...revealed15m]
                  : [...h1, ...revealed1hLen];
            const displayPrefix = fullRaw.filter((b) => b.time < firstTs).map(toKLineData);
            // 同步 feed.current 镜像（与即将重算的 activeBars 对齐，避免 syncFeed 误判 head 变化触发 resetData 跳屏）
            feed.current = fullRaw.map(toKLineData);
            params.callback(displayPrefix, { forward: !exhausted, backward: false });
          } catch (e) {
            console.error('[history] forward load failed', e);
            params.callback([], false);
          } finally {
            loadingHistRef.current = false;
          }
        };
        void run();
      },
      subscribeBar: (params) => {
        feed.subCb = params.callback;
      },
    },
  };
  return feed;
}

function toKLineData(bar: Bar): KLineData {
  return {
    timestamp: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    turnover: bar.quoteVolume,
  };
}

/**
 * 副图高度分配。
 *
 * klinecharts 给副图的默认高度是固定 100px（minHeight 30），
 * 主图（candle_pane）吸收剩余空间。在矮屏（手机横放，图表容器仅 200px）
 * 副图会吃掉一半，蜡烛主图被压成一条缝，完全没法看。
 *
 * v6.3：副图上限从 2 个提到 4 个 ⇒ 高度分配必须重新算，
 * 否则 4 个副图会把主图挤没（旧算法给每个副图 48~100px，
 * 4 个就是 192~400px，而容器才 430px ⇒ 主图只剩几十像素）。
 *
 * 现在的规则：
 *   - 副图**总高** ≤ 容器的 45%（主图至少留一半以上，蜡烛是主角）
 *   - 单个副图 ≤ 90px（再高就没必要，指标图不需要那么大）
 *   - 单个副图 ≥ 44px（低于这个高度 Y 轴刻度会挤成一团）
 */
function applyPaneHeights(chart: Chart, container: HTMLElement, paneIds: string[], weights: number[]) {
  const h = container.clientHeight;
  if (!h || !paneIds.length) return;

  const totalCap = Math.min(h * 0.45, paneIds.length * 90);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

  paneIds.forEach((paneId, i) => {
    const share = (totalCap * (weights[i] ?? 0.28)) / totalWeight;
    const paneH = Math.round(Math.min(90, Math.max(44, share)));
    chart.setPaneOptions({ id: paneId, height: paneH, minHeight: 40 });
  });
}

/**
 * 右侧留白的基准像素（不含 barSpace 补偿）。
 *
 * ⚠️ 这是「切周期 K 线对齐」的关键，也是踩得最深的一个坑。
 *
 * klinecharts 的最后一根 K 线中心坐标：
 *     xLast = 图表宽度 − offsetRightDistance − barSpace/2 − C
 * （C 是 klinecharts 内部的常量偏移，实测 ≈ 64px）
 *
 * 而 `setPeriod({ span })` 会**按周期重算** offsetRightDistance：
 *   实测 1h → 26.19px、4h → 256px、15m → 15.67px
 * ⇒ 切周期后同一时刻的 x 会整体平移（实测 1h↔4h 差 **236px**），
 *   肉眼看就是「切过去 K 线位置全变了」。
 *
 * 修法：offsetRightDistance 必须**随 barSpace 反向补偿**。
 *   要 xLast 在各周期下相同 ⇒ off4 − off1 = (bs4 − bs1)/2
 *   ⇒ off = BASE − barSpace/2
 *
 * 这样三档的「最后一根中心」落在同一像素（实测误差 < 1px），
 * 中间任意时刻也因为 barSpace 成 4:1 比例而严格对齐。
 */
const OFFSET_RIGHT_BASE = 64;

/**
 * 设置右侧留白（并立即重算可见区）。
 *
 * klinecharts 的 `setOffsetRightDistance` **运行时支持第二个参数 isUpdate**
 * （true = 立刻 `_adjustVisibleRange` + layout），但类型定义只暴露了一个参数。
 * 这里用类型断言调用 —— 运行时行为已对照 klinecharts v10 源码核对：
 *   setOffsetRightDistance = (distance, isUpdate) => {
 *     this._offsetRightDistance = distance
 *     this._lastBarRightSideDiffBarCount = distance / this._barSpace
 *     if (isUpdate) { this._adjustVisibleRange(); this._chart.layout(...) }
 *   }
 *
 * 不传 isUpdate 的话右偏移要等下一次 layout 才生效 —— 切周期时会看到一帧错位。
 */
function setOffsetRight(chart: Chart, px: number) {
  (
    chart as unknown as { setOffsetRightDistance: (d: number, u?: boolean) => void }
  ).setOffsetRightDistance(px, true);
}

/**
 * 各档的「可见根数」上限 —— 直接由**预热根数**决定（= 覆盖全部预热历史）。
 *
 * 1h 240 根 / 4h 60 根 天然是 **4:1** ⇒ barSpace 也天然 4:1 ⇒
 * 同一时刻在 1h 与 4h 下落在同一个横坐标上（像素级对齐）。
 *
 * ⚠️ 这里的取舍（v6.3 定稿）：
 *   1h 档 240 根 ⇒ 宽屏下每根约 4px，实体看得清阴阳与影线。
 *   4h 档 60 根（≈16px/根）⇒ 刚好覆盖它自己的全部预热（60 根），
 *   「起点前的历史在视野内」这个 v5 核心功能不退化。
 *
 *   ⚠️ 曾经试过「1h 480 根（≈2px）+ 4h 120 根」—— 严格对齐也做到了，
 *   但**用户实测反馈「1h k线图比其他两个图表显示都小」**：
 *   2px/根的 K 线实体细到看不出形态。
 *   ⇒ 教训：对齐不能以牺牲主周期可读性为代价。
 */
const VISIBLE_BARS: Record<ChartPeriod, number> = { '1h': 240, '4h': 60, '15m': 960 };

/**
 * 每根 K 线的最小像素宽度。
 *
 * 1h / 4h / 15m 都是 4px：K 线实体至少要 4px 才看得出阴阳与影线。
 * （试过 1h/4h 用 2px，用户反馈「1h 比另外两个图表都小」—— 实体细到看不出形态。）
 *
 * 15m 本来就是对齐的例外档，跨度独立于 1h/4h。
 */
const MIN_BAR_PX = 4;
const MIN_BAR_PX_FINE = 4;

/**
 * 把可见根数调成目标值 —— **1h ↔ 4h 的像素级对齐全靠这个函数**。
 *
 * klinecharts 的 x 轴是**按索引等距**排的（没有时间轴模式），
 * 所以「同一时刻落在同一横坐标」这件事等价于：
 *
 *   (总根数 − 该时刻的下标) × barSpace   在各周期下必须相等
 *
 * 而「距右端的根数」按周期成反比（同一段时间：1h 480 根 = 4h 120 根），
 * 因此只要 **barSpace 也按周期成正比**（4h 的 barSpace = 1h 的 4 倍），
 * 同一时刻就必然落在同一个像素上。
 *
 * ⇒ 做法：以 1h 档为基准定一个「可见根数 n」（必须是 4 的倍数），
 *   1h 显示 n 根、4h 显示 n/4 根，barSpace = 可用宽度 / 根数 ⇒ 自动 4:1。
 *
 * ⚠️ 15m 是例外：15m×4 = 1920 根，按 4px/根算需要 7680px 宽 —— 任何屏幕都放不下。
 *   所以 15m 只能保证**右端锚定**（右端始终是「当前时刻」那一根，与 1h/4h 同一像素），
 *   跨度按容器宽度自适应。这是像素物理限制，不是实现偷懒。
 */
function applyTargetBarSpace(chart: Chart, period: ChartPeriod) {
  const size = chart.getSize();
  if (!size || !size.width) return;
  // 右侧价格轴占 ~64px，再留一点余量
  const usable = Math.max(160, size.width - 72);

  // 1h 为基准：n 根 1h ⇔ n/4 根 4h（n 取 4 的倍数，4h 桶才对得上）
  const maxByWidth1h = Math.floor(usable / MIN_BAR_PX);
  const n1h = Math.max(4, Math.floor(Math.min(VISIBLE_BARS['1h'], maxByWidth1h) / 4) * 4);

  const byPeriod: Record<ChartPeriod, number> = {
    '1h': n1h,
    '4h': n1h / 4,
    '15m': Math.min(VISIBLE_BARS['15m'], Math.floor(usable / MIN_BAR_PX_FINE)),
  };
  const target = Math.max(4, Math.round(byPeriod[period]));
  const space = Math.max(1.5, Math.min(48, usable / target));
  chart.setBarSpace(space);
  // 右侧留白随 barSpace 反向补偿 —— 各周期的时间轴才会落在同一像素上
  setOffsetRight(chart, Math.max(8, OFFSET_RIGHT_BASE - space / 2));
}

/** 为图表实例装载一组指标；先清掉旧的，再按分组重建 */
function applyIndicators(
  chart: Chart,
  specs: IndicatorSpec[],
  idPrefix: string,
): { paneIds: string[]; weights: number[] } {
  // 清掉本实例此前创建的所有指标
  for (const ind of chart.getIndicators()) {
    if (ind.id?.startsWith(idPrefix)) chart.removeIndicator({ id: ind.id });
  }

  const { overlay, panes } = splitByGroup(specs.map((s) => s.name));

  for (const spec of overlay) {
    chart.createIndicator({
      name: spec.name,
      id: `${idPrefix}_${spec.name}`,
      paneId: CANDLE_PANE,
      calcParams: spec.calcParams,
    });
  }

  const paneIds: string[] = [];
  const weights: number[] = [];
  for (const spec of panes) {
    const paneId = `${idPrefix}_pane_${spec.name}`;
    chart.createIndicator({
      name: spec.name,
      id: `${idPrefix}_${spec.name}`,
      paneId,
      calcParams: spec.calcParams,
    });
    paneIds.push(paneId);
    weights.push(spec.weight ?? 0.28);
  }
  return { paneIds, weights };
}

/**
 * 把 feed 同步到目标数据集合。
 * - 变长：先把上一根补成最终形态（4h 形成中的蜡烛），再追加新柱
 * - 等长：更新最后一根（形成中的 4h 蜡烛会原地替换）
 * - 变短：回退 → 重新 init
 * - **等长但首根变了**：窗口整体平移 → 必须整体重建
 *   （15m 视图在回看跨过练习起点时会遇到：左端右移 4 根、右端左移 4 根，
 *    长度不变但每一根都换了。若只更新最后一根，中间数据会整体错位。）
 * - **首根变早（历史前插）**：klinecharts 已通过 forward callback 前插，只更新镜像，禁止 resetData 跳屏。
 * - **镜像比 target 长且 target 是其尾子集**：历史刚拉到（已进 mirror）但 state 还没刷新的瞬态竞态，
 *   同样只更新镜像，避免误 resetData。
 */
function syncFeed(chart: Chart, feed: Feed, target: KLineData[]) {
  const prev = feed.current.length;
  if (prev === 0) {
    feed.current = target;
    if (target.length) chart.resetData();
    return;
  }
  // 瞬态竞态保护：mirror 比 target 多（刚拉到的老 K 线已进 mirror 但 state 未刷新），
  // 而 target 恰好是 mirror 的尾子集 ⇒ klinecharts 已有完整数据，只更新镜像
  if (target.length < prev && target.length > 0) {
    const tail = feed.current.slice(feed.current.length - target.length);
    const sameTail = tail.every((b, i) => b.timestamp === target[i].timestamp);
    if (sameTail) {
      feed.current = target;
      return;
    }
  }
  if (target.length < prev) {
    feed.current = target;
    chart.resetData();
    return;
  }
  const headSame =
    target.length > 0 &&
    feed.current.length > 0 &&
    target[0].timestamp === feed.current[0].timestamp;
  if (target.length === prev) {
    if (!headSame) {
      feed.current = target;
      chart.resetData();
      return;
    }
    if (target.length > 0) feed.subCb?.(target[target.length - 1]);
    feed.current = target;
    return;
  }
  // target.length > prev
  if (!headSame) {
    // 首根变早（历史前插）⇒ klinecharts 已通过 forward callback 前插，只更新镜像
    feed.current = target;
    return;
  }
  if (prev > 0) feed.subCb?.(target[prev - 1]);
  for (let i = prev; i < target.length; i++) feed.subCb?.(target[i]);
  feed.current = target;
}

/** 像素坐标 → 命中的 K 线 */
interface BarHit {
  timestamp: number;
  dataIndex: number;
}

/**
 * 蜡烛主图的实际像素高度。
 *
 * 注意：getPaneOptions('candle_pane').height 返回的是**布局权重**（主图恒为 100），
 * 不是像素 —— 拿它当像素用会把所有点击都判成「落在副图上」而丢弃。
 * 像素高度要从 getSize / DOM 上取。
 */
function getMainPaneHeight(chart: Chart, fallback: number): number {
  const size = chart.getSize(CANDLE_PANE);
  if (size && typeof size.height === 'number' && size.height > 0) return size.height;
  const dom = chart.getDom(CANDLE_PANE);
  if (dom && dom.offsetHeight > 0) return dom.offsetHeight;
  return fallback;
}

/**
 * 把屏幕坐标换算成「点到了哪根 K 线」。
 *
 * 为什么不用 klinecharts 的 onCandleBarClick：
 *   1. 它只在命中蜡烛的**矩形本体**时才派发 —— K 线实体只有 4~8px 宽，
 *      随手点经常落在实体外的空白（两根 K 线之间），完全没反应；
 *   2. 一次物理点击会被派发两次（影线 + 实体各挂一个 handler），
 *      「再点一次解除锁定」的 toggle 会被自己抵消 —— 点了等于没点；
 *   3. onCrosshairChange 的载荷字段名不稳定，悬停跟随经常拿不到时间戳。
 *
 * 币安的做法是「点哪根就显示哪根」，不要求精确命中实体。
 * 这里改用 convertFromPixel 反查 —— 坐标落在哪根就取哪根，容错高。
 */
function pickBarAt(
  chart: Chart,
  container: HTMLElement,
  clientX: number,
  clientY: number,
): BarHit | null {
  const rect = container.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || x > rect.width || y < 0 || y > rect.height) return null;

  // 只在蜡烛主图范围内响应，副图留给指标自己的 tooltip
  const mainHeight = getMainPaneHeight(chart, rect.height);
  if (y > mainHeight) return null;

  try {
    const raw = chart.convertFromPixel([{ x, y }], { absolute: true, paneId: CANDLE_PANE }) as
      | { timestamp?: number; dataIndex?: number }
      | Array<{ timestamp?: number; dataIndex?: number }>;
    const p = Array.isArray(raw) ? raw[0] : raw;
    if (!p || typeof p.timestamp !== 'number') return null;
    return { timestamp: p.timestamp, dataIndex: p.dataIndex ?? -1 };
  } catch {
    return null;
  }
}

interface Props {
  symbol: string;
  market: Market;
  bars1h: Bar[];
  /** 15m 独立序列（仅 BTC/ETH 有，其他标的为空数组） */
  bars15m: Bar[];
  cursor: number;
  /**
   * 当前时刻（epoch ms）—— 精确到 15m 内部的位置真值（v6.3）。
   * 图表右端锚定它，15m 档的步进也按它走。
   */
  cursorMs: number;
  /** 练习起点（1h 索引）—— 用于确定预热窗口左端与起点标记 */
  startCursor: number;
  openTrade: OpenTrade | null;
  /** 4h 周期启用的指标名列表 */
  indicators4h: string[];
  /** 1h 周期启用的指标名列表（15m 复用这一套） */
  indicators1h: string[];
  /** 当前显示的周期 */
  period: ChartPeriod;
  onPeriodChange: (p: ChartPeriod) => void;
}

export function ChartPanel({
  symbol,
  market,
  bars1h,
  bars15m,
  cursor,
  cursorMs,
  startCursor,
  openTrade,
  indicators4h,
  indicators1h,
  period,
  onPeriodChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const feedRef = useRef<Feed | null>(null);
  // 记录当前已装载的指标签名，用于判断是否需要重建
  const appliedSigRef = useRef<string>('');
  // 当前常驻副图的 paneId 与权重（供 ResizeObserver 重新分配高度）
  const paneIdsRef = useRef<string[]>([]);
  const weightsRef = useRef<number[]>([]);
  // 已装载的周期/标的/起点，用于判断是否需要重新 init
  const loadedKeyRef = useRef<string>('');
  // resetData 后短暂抑制 forward loader（避免 klinecharts 把 resetData 的 from=0 当成"用户滚到左边缘"）
  const suppressForwardRef = useRef(false);
  // 按下时的坐标，用于区分「点击」与「拖动图表」
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  // 锁定的镜像（事件回调里要读最新值，不能只依赖 state 闭包）
  const pinnedRef = useRef<number | null>(null);

  /** 十字光标所在那根 K 线（跟随） */
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  /** 被点击锁定的那根 K 线 */
  const [pinnedTime, setPinnedTime] = useState<number | null>(null);
  /** 锁定标记在画布上的 x 像素位置 */
  const [pinX, setPinX] = useState<number | null>(null);
  /** 练习起点标记的 x 像素位置 */
  const [startX, setStartX] = useState<number | null>(null);

  /** 画线工具面板是否展开 */
  const [drawToolsOpen, setDrawToolsOpen] = useState(false);
  /** 当前被点中的画线（按 Delete 可删） */
  const [selectedDrawing, setSelectedDrawing] = useState<string | null>(null);
  /** 画线镜像 —— 键盘事件在只跑一次的 effect 里，需要读最新值 */
  const selectedDrawingRef = useRef<string | null>(null);
  /** 正在拖动画线 —— 拖动时不能锁定 K 线（否则画线会顺带锁定一根 K 线） */
  const draggingRef = useRef(false);
  /** 画线工具面板的镜像（pointerup 在只跑一次的 effect 里，要读最新值） */
  const drawToolsOpenRef = useRef(false);

  // ---------- 起点之前的历史 K 线（向左无限加载，纯展示用，不进引擎） ----------
  const [hist1h, setHist1h] = useState<Bar[]>([]);
  const [hist15, setHist15] = useState<Bar[]>([]);
  // 镜像：loader / 事件回调里读最新值，不能只依赖 state 闭包
  const hist1hRef = useRef<Bar[]>([]);
  hist1hRef.current = hist1h;
  const hist15Ref = useRef<Bar[]>([]);
  hist15Ref.current = hist15;
  // 防止历史加载并发重入（滚动到左边缘时 klinecharts 可能连续回调）
  const loadingHistRef = useRef(false);
  // 给只跑一次的图表实例 effect 读取最新 symbol / market / 原始序列（loader 取历史要用）
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const marketRef = useRef(market);
  marketRef.current = market;
  const bars1hRef = useRef(bars1h);
  bars1hRef.current = bars1h;
  const bars15mRef = useRef(bars15m);
  bars15mRef.current = bars15m;

  pinnedRef.current = pinnedTime;
  selectedDrawingRef.current = selectedDrawing;
  drawToolsOpenRef.current = drawToolsOpen;

  /**
   * 开始画一根线。
   *
   * 交互与币安一致：点工具 → 图上出现一条带控制点的线 → 拖动端点调整 → 按 Delete 删除。
   *
   * ⚠️ klinecharts 的 points 是**容器像素坐标**（不是数据坐标），
   *   所以默认点按容器尺寸比例给，落在主图中部。
   */
  const startDrawing = (name: string, pointCount: 1 | 2, yRatio: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    const size = chart.getSize();
    const w = size?.width ?? 800;
    const h = size?.height ?? 400;
    const id = `${DRAW_GROUP}_${Date.now()}`;

    const common = {
      id,
      groupId: DRAW_GROUP,
      paneId: CANDLE_PANE,
      lock: false,
      zLevel: 50,
      styles: {
        line: { color: '#FCD535', style: 'dashed', dashedValue: [4, 4], size: 1 },
        point: { color: '#FCD535', size: 4 },
      },
      onClick: () => setSelectedDrawing(id),
      onPressedMoveStart: () => {
        draggingRef.current = true;
      },
      onPressedMoveEnd: () => {
        draggingRef.current = false;
      },
    };

    const points =
      pointCount === 2
        ? // ⚠️ segment（趋势线）必须用**数据坐标** {timestamp, value} ——
          //   用像素坐标 {x, y} 创建出来是**空的**（实测：overlay 存在但画不出线）。
          //   水平线 / 价格线反之，用像素坐标。
          (() => {
            if (activeBars.length < 2) return [];
            const a = activeBars[Math.floor(activeBars.length * 0.4)];
            const b = activeBars[Math.floor(activeBars.length * 0.6)];
            return [
              { timestamp: a.time, value: a.close },
              { timestamp: b.time, value: b.close },
            ];
          })()
        : [{ x: Math.round(w * 0.5), y: Math.round(h * yRatio) }];

    chart.createOverlay({ ...common, name, points } as never);
    setDrawToolsOpen(false);
    setSelectedDrawing(id);
  };

  /** 清除全部用户画线 */
  const clearDrawings = () => {
    chartRef.current?.removeOverlay({ groupId: DRAW_GROUP });
    setSelectedDrawing(null);
  };

  // 游标只用于「初始化时取已揭示切片」，不作为重建图表的依赖
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const cursorMsRef = useRef(cursorMs);
  cursorMsRef.current = cursorMs;
  const startCursorRef = useRef(startCursor);
  startCursorRef.current = startCursor;
  // 周期镜像：给只跑一次的 effect（图表实例初始化）读取最新周期
  const periodRef = useRef(period);
  periodRef.current = period;

  /**
   * 起点之前的历史 K 线合并进「已揭示切片」：
   * 初始只装载「起点前预热窗口 ~ 游标」这段（与 v6.3 一致，4h 据此约 60 根、整屏放得下）；
   * 起点之前更早的历史在滚动 / 缩放到左边缘时由图表 forward loader 从后端按需拉取并前插，
   * 进 `hist1h` / `hist15` 后自动并入本切片（见 createFeed 的 forward 分支与 v6.4）。
   * 历史纯展示用 —— 引擎只需要 cursor 之后的练习区，所以历史不进 store、不进引擎。
   */
  /** 预热窗口左端（1h 索引）—— 见 calcWindowStart 的说明。
   *  返回 -1 表示 bars1h / cursor 尚未就绪，下游 revealed/activeBars 一律返回空。
   *  这是为了防止「bars1h 还空着就 slice(0, cursor+1) 导致全量塞爆」的竞态。
   */
  const windowStart = useMemo(() => {
    if (!bars1h.length || cursor < 0) return -1;
    return calcWindowStart(bars1h, resolveAnchor(startCursor, cursor), period === '15m' ? '1h' : period);
  }, [bars1h, cursor, startCursor, period]);
  const revealed1h = useMemo(() => {
    if (windowStart < 0) return [];
    const slice1h = bars1h.slice(windowStart, cursor + 1);
    return [...hist1h, ...slice1h];
  }, [bars1h, cursor, hist1h, windowStart]);
  const revealed4h = useMemo(() => derive4h(revealed1h), [revealed1h]);
  // DEBUG
  (window as unknown as Record<string, unknown>).__cpDbg2 = {
    cursor, startCursor, period,
    bars1hLen: bars1h.length,
    windowStart,
    anchor: resolveAnchor(startCursor, cursor),
    anchorTime: bars1h[resolveAnchor(startCursor, cursor)]?.time ?? null,
    rawTime: bars1h[resolveAnchor(startCursor, cursor)]?.time !== undefined ? bars1h[resolveAnchor(startCursor, cursor)].time - 240 * 3600000 : null,
    wsCalcDirect: calcWindowStart(bars1h, resolveAnchor(startCursor, cursor), period === '15m' ? '1h' : period),
    r1hLen: revealed1h.length,
    r4hLen: revealed4h.length,
    activeLen: period === '4h' ? revealed4h.length : period === '15m' ? 0 : revealed1h.length,
  };

  /** 15m 的窗口（独立序列，按时间戳切；右端跟随当前时刻 cursorMs，左端到预热窗口起点） */
  const window15m = useMemo(
    () => calcWindow15m(bars15m, bars1h, resolveAnchor(startCursor, cursor), cursor, cursorMs),
    [bars15m, bars1h, cursor, cursorMs, startCursor],
  );
  const revealed15m = useMemo(
    () =>
      window15m.to < window15m.from
        ? []
        : [...hist15, ...bars15m.slice(window15m.from, window15m.to + 1)],
    [bars15m, window15m, hist15],
  );

  const activeBars =
    period === '4h' ? revealed4h : period === '15m' ? revealed15m : revealed1h;

  // 切换周期后，上一根锁定的 K 线在新序列里不存在 → 清除锁定与悬停
  useEffect(() => {
    setPinnedTime(null);
    setHoverTime(null);
  }, [period, symbol]);

  // ---------- 初始化图表实例 + 绑定交互 ----------
  // 注意：图表实例**只创建一次**。
  // 曾经写成依赖 [period]，切周期时 dispose + init(el) 重建 —— init 在同一个
  // el 上重建会抛错，导致后续所有 effect（指标装载 / 数据重建）都不执行，
  // 表现为「切到 1h 后图表空白、指标消失」。
  // 现在：实例固定，切换周期只重建数据与指标（见下面的两个 effect）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = init(el, { styles: BINANCE_STYLES, locale: 'zh-CN' });
    if (!chart) return;
    chartRef.current = chart;
    // 注意：offsetRightDistance 由 applyTargetBarSpace 统一管理
    // （它必须随 barSpace 反向补偿，否则切周期时时间轴会整体平移），
    // 这里只设一个初值，真正的设置在每次重建数据后发生。

    // ---------- 鼠标 / 触摸交互：悬停跟随 + 点击锁定 ----------
    const onPointerMove = (ev: PointerEvent) => {
      if (pinnedRef.current !== null) return; // 已锁定时不跟随
      const hit = pickBarAt(chart, el, ev.clientX, ev.clientY);
      setHoverTime(hit ? hit.timestamp : null);
    };

    const onPointerLeave = () => {
      if (pinnedRef.current === null) setHoverTime(null);
    };

    const onPointerDown = (ev: PointerEvent) => {
      pointerDownRef.current = { x: ev.clientX, y: ev.clientY };
    };

    const onPointerUp = (ev: PointerEvent) => {
      const down = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!down) return;
      // 位移超过 5px 视为拖动图表，不算点击
      if (Math.abs(ev.clientX - down.x) > 5 || Math.abs(ev.clientY - down.y) > 5) return;
      // 正在拖动画线 ⇒ 不锁定 K 线（否则画线会顺带锁定一根 K 线，很烦）
      if (draggingRef.current) return;
      // 画线工具面板开着时也不锁定（用户正准备画线，别乱锁）
      if (drawToolsOpenRef.current) return;

      const hit = pickBarAt(chart, el, ev.clientX, ev.clientY);
      if (!hit) {
        // 点在空白处 → 解除锁定（币安行为）
        setPinnedTime(null);
        return;
      }
      // 幂等锁定：重复点同一根也不会互相抵消
      setPinnedTime(hit.timestamp);
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setPinnedTime(null);
        setDrawToolsOpen(false);
        return;
      }
      // 删除选中的画线（币安同款：点选后按 Delete）
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        const id = selectedDrawingRef.current;
        if (id) {
          chart.removeOverlay({ id });
          setSelectedDrawing(null);
          ev.preventDefault();
        }
      }
    };

    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKey);

    const ro = new ResizeObserver(() => {
      chart.resize();
      applyPaneHeights(chart, containerRef.current!, paneIdsRef.current, weightsRef.current);
      applyTargetBarSpace(chart, periodRef.current);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerleave', onPointerLeave);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKey);
      dispose(chart);
      chartRef.current = null;
    };
  }, []);


  // ---------- 锁定标记的像素位置（随缩放/滚动刷新） ----------
  const refreshPinX = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || pinnedTime === null) {
      setPinX(null);
      return;
    }
    try {
      const px = chart.convertToPixel({ timestamp: pinnedTime }, { absolute: true }) as Partial<Coordinate>;
      setPinX(typeof px?.x === 'number' && Number.isFinite(px.x) ? px.x : null);
    } catch {
      setPinX(null);
    }
  }, [pinnedTime]);

  useEffect(() => {
    refreshPinX();
  }, [refreshPinX, activeBars]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onRangeChange = () => refreshPinX();
    chart.subscribeAction('onVisibleRangeChange', onRangeChange);
    return () => chart.unsubscribeAction('onVisibleRangeChange', onRangeChange);
  }, [refreshPinX]);

  // ---------- 练习起点标记 ----------
  const startTimestamp = useMemo(() => {
    if (startCursor < 0) return null;
    const bar = bars1h[startCursor];
    if (!bar) return null;
    if (period === '4h') return Math.floor(bar.time / FOUR_HOURS) * FOUR_HOURS;
    if (period === '15m') return Math.floor(bar.time / (15 * 60 * 1000)) * (15 * 60 * 1000);
    return bar.time;
  }, [bars1h, startCursor, period]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || startTimestamp === null) {
      setStartX(null);
      return;
    }
    try {
      const px = chart.convertToPixel({ timestamp: startTimestamp }, { absolute: true }) as Partial<Coordinate>;
      const x = typeof px?.x === 'number' && Number.isFinite(px.x) ? px.x : null;
      // 起点在视口外时不要画（避免一条横跨全图的假线）
      const size = chart.getSize();
      setStartX(x !== null && size && x >= 0 && x <= size.width ? x : null);
    } catch {
      setStartX(null);
    }
  }, [startTimestamp, activeBars, cursor]);

  // ---------- e2e 测试钩子 ----------
  // 验证脚本需要「精确点到某根 K 线的实体上」才能触发 onCandleBarClick，
  // 而画布是 canvas，DOM 里读不到像素坐标。这里把实例挂到 window，
  // 脚本用 convertToPixel 把「时间戳 + 价格」换算成页面坐标后做真实点击。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    (window as unknown as Record<string, unknown>).__klineChart = chart;
    return () => {
      delete (window as unknown as Record<string, unknown>).__klineChart;
    };
  }, []);

  // ---------- 指标装载：随配置 / 周期变化重建 ----------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // 15m 复用 1h 的指标配置（15m 是 1h 的细化视图，指标体系一致）
    const names = period === '4h' ? indicators4h : indicators1h;
    const sig = `${period}|${names.join(',')}`;
    if (sig === appliedSigRef.current) return;

    const specs = names.map((n) => getIndicatorSpec(n)).filter((s): s is IndicatorSpec => !!s);
    const r = applyIndicators(chart, specs, 'ind');
    paneIdsRef.current = r.paneIds;
    weightsRef.current = r.weights;
    appliedSigRef.current = sig;
    applyPaneHeights(chart, containerRef.current!, r.paneIds, r.weights);
  }, [indicators4h, indicators1h, period]);

  // ---------- 换标的 / 换周期 / 换起点 / 换市场 / cursor 首次就绪：重建 feed 并 init ----------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || bars1h.length === 0) return;
    if (cursor < 0) return; // 等 cursor 从 -1 变成有效值后再 init

    const key = `${symbol}|${market}|${period}|${startCursorRef.current}`;
    if (loadedKeyRef.current === key) return;

    // 换标的 / 周期 / 市场 / 起点 ⇒ 历史上下文作废（不同标的的历史不通用）
    setHist1h([]);
    setHist15([]);
    hist1hRef.current = [];
    hist15Ref.current = [];

    const last = bars1h[bars1h.length - 1];
    const precision = pricePrecision(last.close);

    const feed = createFeed({
      symbolRef,
      marketRef,
      periodRef,
      loadingHistRef,
      hist1hRef,
      hist15Ref,
      bars1hRef,
      bars15mRef,
      cursorRef,
      startCursorRef,
      cursorMsRef,
      suppressForwardRef,
      setHist1h,
      setHist15,
    });
    feedRef.current = feed;

    // 直接用 useMemo 算出的 activeBars（revealed1h/revealed4h/revealed15m 统一口径），
    // 杜绝 feed-init 自己 calcWindowStart + slice 与外部 windowStart useMemo 算出不同值的竞态。
    // activeBars 在 windowStart < 0 或 15m 窗口未就绪时返回空 —— 上面的 cursor>=0 保护已确保不会空。
    feed.current = activeBars.map(toKLineData);

    chart.setSymbol({ ticker: `${symbol}-${period}`, pricePrecision: precision, volumePrecision: 2 });
    chart.setPeriod({ type: 'hour', span: period === '4h' ? 4 : period === '15m' ? 0.25 : 1 });
    chart.setDataLoader(feed.loader);
    suppressForwardRef.current = true;
    chart.resetData();
    applyTargetBarSpace(chart, period);
    applyPaneHeights(chart, containerRef.current!, paneIdsRef.current!, weightsRef.current);
    // resetData 后 klinecharts 会异步（几百 ms 后）检查 visible.from → 0 并触发 forward loader，
    // 必须等它稳定后再允许 forward，否则 resetData 会伪装成"用户滚到左边缘"。
    // 5s 窗口足够覆盖所有回归测试和用户首屏观察期（预热窗口整屏放得下，左边缘不在视野内）。
    setTimeout(() => { suppressForwardRef.current = false; }, 5000);

    loadedKeyRef.current = key;
  }, [symbol, market, period, bars1h, bars15m, startCursor, cursor, activeBars]);

  // ---------- 游标推进：增量同步 ----------
  useEffect(() => {
    const chart = chartRef.current;
    const feed = feedRef.current;
    if (!chart || !feed) return;
    if (loadedKeyRef.current !== `${symbol}|${market}|${period}|${startCursorRef.current}`) return;

    syncFeed(chart, feed, activeBars.map(toKLineData));
    // 回退导致 resetData 时，barSpace 会被重置 —— 补一次
    applyTargetBarSpace(chart, period);
  }, [activeBars, symbol, market, period]);

  // ---------- 持仓：画入场/止损/目标线（1h 与 15m 图上都画） ----------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.removeOverlay({ groupId: TRADE_GROUP });
    if (!openTrade || period === '4h') return;

    const series = period === '15m' ? revealed15m : revealed1h;
    const ts = series.length ? series[series.length - 1].time : Date.now();
    const lines: Array<{ value: number; color: string; label: string }> = [
      { value: openTrade.entryPrice, color: '#FCD535', label: '入场' },
      { value: openTrade.stopLoss, color: '#F6465D', label: '止损' },
    ];
    if (openTrade.takeProfit !== null) {
      lines.push({ value: openTrade.takeProfit, color: '#0ECB81', label: '目标' });
    }
    for (const l of lines) {
      chart.createOverlay({
        name: 'priceLine',
        groupId: TRADE_GROUP,
        points: [{ value: l.value, timestamp: ts }],
        lock: true,
        zLevel: 100,
        styles: {
          line: { color: l.color, style: 'dashed', dashedValue: [4, 4], size: 1 },
          text: { color: l.color, size: 10, family: 'inherit', weight: 'normal' },
        },
        extendData: { label: l.label },
      });
    }
  }, [openTrade, revealed1h, revealed15m, period]);

  // ---------- 详情：锁定 > 悬停 > 最新一根 ----------
  const detail = useMemo(() => {
    if (!activeBars.length) return null;
    // 悬停到无效位置（右侧价格轴、窗口外）时回退到最新一根，
    // 而不是让整条详情条闪成「暂无数据」
    let idx = activeBars.length - 1;
    const ts = pinnedTime ?? hoverTime;
    if (ts !== null) {
      const i = activeBars.findIndex((b) => b.time === ts);
      if (i >= 0) idx = i;
    }
    const bar = activeBars[idx];
    const prevClose = idx > 0 ? activeBars[idx - 1].close : bar.open;
    const chg = bar.close - prevClose;
    return {
      bar,
      idx,
      prevClose,
      chg,
      chgPct: prevClose ? (chg / prevClose) * 100 : 0,
      amp: prevClose ? ((bar.high - bar.low) / prevClose) * 100 : 0,
      bodyPct: prevClose ? ((bar.close - bar.open) / prevClose) * 100 : 0,
    };
  }, [activeBars, pinnedTime, hoverTime]);

  const locked = pinnedTime !== null;

  /**
   * 周期切换：三个档位，从左到右 = 15m → 1h → 4h。
   *
   * 交互设计（按需求）：
   *   - 默认停在 1h（中间档）
   *   - 「往左」= 更细粒度（15m，用于精找入场）
   *   - 「往右」= 更粗粒度（4h，用于看趋势）
   *   - 左右箭头按钮 + 直接点标签，两种方式都支持
   */
  const PERIODS: Array<{ key: ChartPeriod; main: string; sub: string; disabled?: boolean }> = [
    { key: '15m', main: '15m', sub: '精入场', disabled: bars15m.length === 0 },
    { key: '1h', main: '1h', sub: '入场' },
    { key: '4h', main: '4h', sub: '趋势' },
  ];
  const curIdx = PERIODS.findIndex((p) => p.key === period);
  const step = (delta: number) => {
    const next = PERIODS[curIdx + delta];
    if (next && !next.disabled) onPeriodChange(next.key);
  };

  return (
    <div className="chart-panel">
      <div className="chart-toolbar">
        <div className="period-nav">
          <button
            className="btn tiny ghost period-arrow"
            onClick={() => step(-1)}
            disabled={curIdx <= 0 || PERIODS[curIdx - 1]?.disabled}
            title="更细粒度（15m）"
            aria-label="切换到更细周期"
          >
            ‹
          </button>
          <div className="period-tabs" role="tablist" aria-label="K线周期">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                role="tab"
                aria-selected={period === p.key}
                className={`period-tab ${period === p.key ? 'active' : ''} ${p.disabled ? 'disabled' : ''}`}
                onClick={() => !p.disabled && onPeriodChange(p.key)}
                disabled={p.disabled}
                title={p.disabled ? '该标的暂无 15m 数据（链上美股源只有 1h 粒度）' : undefined}
              >
                <span className="period-main">{p.main}</span>
                <span className="period-sub">{p.sub}</span>
              </button>
            ))}
          </div>
          <button
            className="btn tiny ghost period-arrow"
            onClick={() => step(1)}
            disabled={curIdx >= PERIODS.length - 1 || PERIODS[curIdx + 1]?.disabled}
            title="更粗粒度（4h）"
            aria-label="切换到更粗周期"
          >
            ›
          </button>

          {/* 画线工具 —— 币安同款：工具条上一排小图标 */}
          <div className="draw-tools">
            <button
              className={`btn tiny ghost draw-trigger ${drawToolsOpen ? 'active' : ''}`}
              onClick={() => setDrawToolsOpen((v) => !v)}
              title="画线工具（趋势线 / 水平线 / 价格线）"
              aria-expanded={drawToolsOpen}
            >
              ✏ 画线
            </button>
            {drawToolsOpen && (
              <div className="draw-panel">
                {DRAW_TOOLS.map((t) => (
                  <button
                    key={t.name}
                    className="btn tiny draw-item"
                    onClick={() => startDrawing(t.name, t.points, t.yRatio)}
                    title={`${t.label}：点在图上出现后拖动端点调整`}
                  >
                    <span className="draw-icon">{t.icon}</span>
                    {t.label}
                  </button>
                ))}
                <button
                  className="btn tiny ghost draw-item"
                  onClick={clearDrawings}
                  title="清除全部画线"
                >
                  🗑 清除
                </button>
                <div className="draw-hint muted">
                  拖动端点调整 · 点选后按 Delete 删除 · 切周期保留、换标的清除
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={`ohlc-strip ${locked ? 'locked' : ''}`}>
          {detail ? (
            <>
              <span className="ohlc-time" data-ts={detail.bar.time}>
                {fmtTime(detail.bar.time)}
                {locked && <span className="ohlc-lock">已锁定</span>}
              </span>
              <OhlcCell label="开" value={fmtPrice(detail.bar.open)} />
              <OhlcCell label="高" value={fmtPrice(detail.bar.high)} />
              <OhlcCell label="低" value={fmtPrice(detail.bar.low)} />
              <OhlcCell label="收" value={fmtPrice(detail.bar.close)} tone={dir(detail.chg)} />
              <OhlcCell
                label="涨跌"
                value={`${fmtSigned(detail.chg)} (${fmtPct(detail.chgPct)})`}
                tone={dir(detail.chg)}
              />
              <OhlcCell label="振幅" value={`${detail.amp.toFixed(2)}%`} />
              <OhlcCell label="量" value={fmtCompact(detail.bar.volume)} />
              <OhlcCell label="额" value={fmtCompact(detail.bar.quoteVolume)} />
              <OhlcCell label="笔数" value={detail.bar.trades ? fmtCompact(detail.bar.trades) : '—'} />
            </>
          ) : (
            <span className="muted">暂无数据</span>
          )}
        </div>
      </div>

      {period === '15m' && bars15m.length === 0 && (
        <div className="notice warn chart-note">
          该标的暂无 15m 数据（链上美股源只有 1h 粒度），已切回 1h。
        </div>
      )}

      {/*
        15m 有数据，但**不覆盖当前练习起点** → 窗口为空。
        典型场景：非 BTC/ETH 标的的 15m 只有 41 天，而练习起点被设到更早。
        这时必须说明原因，否则用户看到一张空白图会以为功能坏了。
      */}
      {period === '15m' && bars15m.length > 0 && revealed15m.length === 0 && (
        <div className="notice warn chart-note">
          当前练习起点早于该标的的 15m 数据起点（{fmtTime(bars15m[0]?.time)}），
          15m 视图没有可显示的区间 —— 把起点调晚，或切回 1h。
        </div>
      )}

      <div className="chart-canvas-wrap">
        <div ref={containerRef} className="chart-canvas" />
        {startX !== null && <div className="start-marker" style={{ left: `${startX}px` }} />}
        {locked && pinX !== null && <div className="pin-marker" style={{ left: `${pinX}px` }} />}
      </div>

      <div className="chart-foot">
        <span className="muted">
          {period === '15m'
            ? '15m 为 1h 同一时间轴的高分辨率视图（右端锚定当前时刻），单步按 15m 推进'
            : '点击任意 K 线锁定查看详情，再次点击空白处或按 ESC 解除'}
        </span>
        {locked && (
          <button className="btn tiny ghost" onClick={() => setPinnedTime(null)}>
            解除锁定
          </button>
        )}
      </div>
    </div>
  );
}

function OhlcCell({ label, value, tone }: { label: string; value: string; tone?: 1 | -1 | 0 }) {
  const cls = tone === 1 ? 'up' : tone === -1 ? 'down' : '';
  return (
    <span className="ohlc-cell">
      <span className="ohlc-label">{label}</span>
      <span className={`ohlc-value ${cls}`}>{value}</span>
    </span>
  );
}
