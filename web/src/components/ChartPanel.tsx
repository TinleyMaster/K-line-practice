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
import type { Bar, ChartPeriod, OpenTrade } from '../types';
import { derive4h, fmtPrice, fmtTime, pricePrecision, FOUR_HOURS, HOUR } from '../engine/bars';
import { dir, fmtCompact, fmtPct, fmtSigned } from '../engine/format';
import { getIndicatorSpec, splitByGroup, type IndicatorSpec } from '../engine/indicators';

const CANDLE_PANE = 'candle_pane';
const TRADE_GROUP = 'trade-lines';

/**
 * 预热窗口：练习起点之前保留多少根 1h K 线喂给图表（1h / 4h 口径）。
 *
 * 为什么必须留：技术指标（MA60 / BOLL / EMA…）需要足够的历史才能算出值。
 * 如果只喂「起点之后」的数据，起点那根的指标全是空的 —— 用户看到的第一屏
 * 没有任何依据，「4h 看趋势」这条规则根本落不了地。
 *
 *   - 4h：480 根 1h = 120 根 4h（够 MA60，也够看趋势结构）
 *   - 1h：240 根 1h（够 MA60）
 *
 * 15m 单独算（见 WARMUP_15M）：它是独立序列，根数换算不同。
 */
const WARMUP_1H: Record<'4h' | '1h', number> = { '4h': 480, '1h': 240 };

/**
 * 15m 的预热根数。
 *
 * 960 根 15m = 240 小时 = 10 天 —— **与 1h 口径（240 根 1h = 240 小时）严格对齐**。
 *
 * 为什么必须对齐：
 *   15m 是 1h 的「同一时间轴高分辨率视图」。如果 15m 的历史跨度比 1h 短，
 *   用户在 1h ↔ 15m 之间切换时，视野长度会变 —— 看起来像「图表跳了一下」，
 *   很难受。跨度一致，切换才是纯粹的「同一段历史的两种粒度」。
 *
 * （v6 初版这里写的是 480 根 = 120 小时，比 1h 短一半 —— 已修正。）
 */
const WARMUP_15M = 960;

/**
 * 目标可见根数 —— 决定 barSpace，让「预热区 + 当前根」尽量铺满一屏。
 * 数值偏大 → K 线变密；偏小 → 起点前的历史被挤出视野。
 */
const TARGET_VISIBLE: Record<ChartPeriod, number> = { '4h': 120, '1h': 200, '15m': 260 };

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
 * 预热窗口左端（1h 索引）。
 *
 * 以锚点往回取 WARMUP_1H 根历史。
 * 左端还要对齐到 4h 桶边界 —— 不对齐的话，派生出来的第一根 4h 是个残桶
 * （缺前面几根 1h），它的 OHLC 与成交量都是错的，会污染所有以它为起点的指标。
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
 * 15m 的窗口（独立序列，按时间戳切）。
 *
 * 15m 是**独立序列**（不是从 1h 派生的），所以窗口按时间戳切：
 *   - **左端**：锚点往前 WARMUP_15M 根 15m（= 240 小时，与 1h 口径一致）
 *   - **右端**：当前 1h 游标所在小时的**小时末**
 *
 * ⚠️ 右端必须跟着 **cursorIdx** 走，不能跟着 anchor（= min(startCursor, cursor)）走。
 *   踩过的坑：初版右端也用 anchor，而 anchor = min(练习起点, 游标) = 起点
 *   —— 于是回放往前推进时，15m 图的右端**钉死在练习起点那一小时不动**，
 *   1h 图在走、15m 图不走，看起来像「15m 数据没刷新」。
 *
 * 语义边界（为什么右端可以落在「当前这一小时」内部）：
 *   15m 图 = 1h 引擎**已经揭示**的那一小时 + 这一小时内部的 15m 路径。
 *   当前这根 1h 已经在引擎里了（bars1h[cursor]），引擎知道它的 OHLC；
 *   15m 视图额外展示这一小时**内部的走势** —— 这正是「精入场」要看的东西。
 *   关键红线：绝不显示 cursor **之后**的任何数据（未来）。
 */
function calcWindow15m(
  bars15m: Bar[],
  bars1h: Bar[],
  anchor: number,
  cursorIdx: number,
): { from: number; to: number } {
  if (!bars15m.length || anchor < 0 || cursorIdx < 0) return { from: 0, to: -1 };
  const anchorBar = bars1h[anchor];
  const cursorBar = bars1h[cursorIdx];
  if (!anchorBar || !cursorBar) return { from: 0, to: -1 };

  // 当前 1h 根覆盖 [cursorBar.time, cursorBar.time + 1h)
  const hourEnd = cursorBar.time + HOUR;
  // 15m 序列里 ≤ hourEnd 的最后一根
  let to = -1;
  for (let i = 0; i < bars15m.length; i++) {
    if (bars15m[i].time < hourEnd) to = i;
    else break;
  }
  if (to < 0) return { from: 0, to: -1 };

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

function createFeed(): Feed {
  const feed: Feed = {
    current: [],
    loader: {
      getBars: (params) => {
        if (params.type === 'init') params.callback(feed.current.slice());
        else params.callback([]);
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
 * 这里按容器高度给每个副图按权重分配，夹在 [48, 100]，
 * 容器越大副图绝对值封顶在 100px（保持桌面观感），越小则按比例收缩。
 * 主图至少保留 40% 高度。
 */
function applyPaneHeights(chart: Chart, container: HTMLElement, paneIds: string[], weights: number[]) {
  const h = container.clientHeight;
  if (!h || !paneIds.length) return;

  // 主图至少留 40%，剩余按权重分给副图
  const available = Math.max(0, h * 0.6);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

  paneIds.forEach((paneId, i) => {
    const share = (available * (weights[i] ?? 0.3)) / totalWeight;
    const paneH = Math.round(Math.min(100, Math.max(48, share)));
    chart.setPaneOptions({ id: paneId, height: paneH, minHeight: 40 });
  });
}

/**
 * 把可见根数调成目标值。
 *
 * klinecharts 默认 barSpace 较大（约 8~10px），一屏只能显示 ~100 根。
 * 预热区有 120~240 根历史，不主动缩小 barSpace 的话，起点前的历史会被
 * 挤出视野 —— 用户就又看不到「练习起点之前长什么样」了。
 *
 * 但也不能一味压小：每根 K 线至少 4px 才看得清实体，
 * 窄屏（手机）必须按容器宽度封顶，否则要么挤成一团要么稀疏得没法读。
 */
function applyTargetBarSpace(chart: Chart, target: number) {
  const size = chart.getSize();
  if (!size || !size.width) return;
  // 右侧价格轴占 ~64px，再留一点余量
  const usable = Math.max(160, size.width - 72);
  // 每根至少 4px 才看得清 → 窄屏下的可见根数上限
  const maxByWidth = Math.floor(usable / 4);
  const realTarget = Math.max(20, Math.min(target, maxByWidth));
  const space = usable / realTarget;
  chart.setBarSpace(Math.max(2.5, Math.min(20, space)));
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
 */
function syncFeed(chart: Chart, feed: Feed, target: KLineData[]) {
  const prev = feed.current.length;
  if (target.length < prev) {
    feed.current = target;
    chart.resetData();
    return;
  }
  if (target.length === prev) {
    const sameHead =
      target.length > 0 &&
      feed.current.length > 0 &&
      target[0].timestamp === feed.current[0].timestamp;
    if (!sameHead) {
      feed.current = target;
      chart.resetData();
      return;
    }
    if (target.length > 0) feed.subCb?.(target[target.length - 1]);
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
  bars1h: Bar[];
  /** 15m 独立序列（仅 BTC/ETH 有，其他标的为空数组） */
  bars15m: Bar[];
  cursor: number;
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
  bars1h,
  bars15m,
  cursor,
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

  pinnedRef.current = pinnedTime;

  // 游标只用于「初始化时取已揭示切片」，不作为重建图表的依赖
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const startCursorRef = useRef(startCursor);
  startCursorRef.current = startCursor;
  // 周期镜像：给只跑一次的 effect（图表实例初始化）读取最新周期
  const periodRef = useRef(period);
  periodRef.current = period;

  /**
   * 预热窗口左端（1h 索引）—— 见 calcWindowStart 的说明。
   */
  const windowStart = useMemo(
    () => calcWindowStart(bars1h, resolveAnchor(startCursor, cursor), period === '15m' ? '1h' : period),
    [bars1h, cursor, startCursor, period],
  );

  const revealed1h = useMemo(
    () => (cursor < 0 ? [] : bars1h.slice(windowStart, cursor + 1)),
    [bars1h, cursor, windowStart],
  );
  const revealed4h = useMemo(() => derive4h(revealed1h), [revealed1h]);

  /** 15m 的窗口（独立序列，按时间戳切；右端跟随 cursor） */
  const window15m = useMemo(
    () => calcWindow15m(bars15m, bars1h, resolveAnchor(startCursor, cursor), cursor),
    [bars15m, bars1h, cursor, startCursor],
  );
  const revealed15m = useMemo(
    () =>
      window15m.to < window15m.from
        ? []
        : bars15m.slice(window15m.from, window15m.to + 1),
    [bars15m, window15m],
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
    chart.setOffsetRightDistance(64);

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
      if (ev.key === 'Escape') setPinnedTime(null);
    };

    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKey);

    const ro = new ResizeObserver(() => {
      chart.resize();
      applyPaneHeights(chart, containerRef.current!, paneIdsRef.current, weightsRef.current);
      applyTargetBarSpace(chart, TARGET_VISIBLE[periodRef.current]);
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

  // ---------- 换标的 / 换周期 / 换起点：重建 feed 并 init ----------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || bars1h.length === 0) return;

    const key = `${symbol}|${period}|${startCursorRef.current}`;
    if (loadedKeyRef.current === key) return;

    const last = bars1h[bars1h.length - 1];
    const precision = pricePrecision(last.close);

    const feed = createFeed();
    feedRef.current = feed;

    const c = cursorRef.current;
    const anchor = resolveAnchor(startCursorRef.current, c);

    let series: Bar[];
    if (period === '15m') {
      const w = calcWindow15m(bars15m, bars1h, anchor, c);
      series = w.to < w.from ? [] : bars15m.slice(w.from, w.to + 1);
    } else {
      const winStart = c >= 0 ? calcWindowStart(bars1h, anchor, period) : 0;
      const revealed = c >= 0 ? bars1h.slice(winStart, c + 1) : [];
      series = period === '4h' ? derive4h(revealed) : revealed;
    }
    feed.current = series.map(toKLineData);

    chart.setSymbol({ ticker: `${symbol}-${period}`, pricePrecision: precision, volumePrecision: 2 });
    chart.setPeriod({ type: 'hour', span: period === '4h' ? 4 : period === '15m' ? 0.25 : 1 });
    chart.setDataLoader(feed.loader);
    chart.resetData();
    applyTargetBarSpace(chart, TARGET_VISIBLE[period]);
    applyPaneHeights(chart, containerRef.current!, paneIdsRef.current, weightsRef.current);

    loadedKeyRef.current = key;
  }, [symbol, period, bars1h, bars15m, startCursor]);

  // ---------- 游标推进：增量同步 ----------
  useEffect(() => {
    const chart = chartRef.current;
    const feed = feedRef.current;
    if (!chart || !feed) return;
    if (loadedKeyRef.current !== `${symbol}|${period}|${startCursorRef.current}`) return;

    syncFeed(chart, feed, activeBars.map(toKLineData));
    // 回退导致 resetData 时，barSpace 会被重置 —— 补一次
    applyTargetBarSpace(chart, TARGET_VISIBLE[period]);
  }, [activeBars, symbol, period]);

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
            ? '15m 为 1h 同一时间轴的高分辨率视图（右端锚定当前小时），回放推进仍按 1h'
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
