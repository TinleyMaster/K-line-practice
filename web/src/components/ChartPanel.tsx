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
import type { Bar, OpenTrade } from '../types';
import { derive4h, fmtPrice, fmtTime, pricePrecision } from '../engine/bars';
import { dir, fmtCompact, fmtPct, fmtSigned } from '../engine/format';
import { getIndicatorSpec, splitByGroup, type IndicatorSpec } from '../engine/indicators';

const CANDLE_PANE = 'candle_pane';
const TRADE_GROUP = 'trade-lines';

/** 币安配色：涨 #F6465D / 跌 #0ECB81，网格极淡，数字统一 #EAECEF */
const BINANCE_STYLES: DeepPartial<Styles> = {
  grid: {
    show: true,
    horizontal: { color: 'rgba(255,255,255,0.04)', style: 'solid' },
    vertical: { color: 'rgba(255,255,255,0.04)', style: 'solid' },
  },
  candle: {
    type: 'candle_solid',
    bar: {
      upColor: '#F6465D',
      downColor: '#0ECB81',
      noChangeColor: '#848E9C',
      upBorderColor: '#F6465D',
      downBorderColor: '#0ECB81',
      upWickColor: '#F6465D',
      downWickColor: '#0ECB81',
      noChangeBorderColor: '#848E9C',
      noChangeWickColor: '#848E9C',
    },
    priceMark: {
      show: true,
      high: { color: '#848E9C', textSize: 10 },
      low: { color: '#848E9C', textSize: 10 },
      last: {
        show: true,
        upColor: '#F6465D',
        downColor: '#0ECB81',
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
 */
function syncFeed(chart: Chart, feed: Feed, target: KLineData[]) {
  const prev = feed.current.length;
  if (target.length < prev) {
    feed.current = target;
    chart.resetData();
    return;
  }
  if (target.length === prev) {
    if (target.length > 0) feed.subCb?.(target[target.length - 1]);
    feed.current = target;
    return;
  }
  if (prev > 0) feed.subCb?.(target[prev - 1]);
  for (let i = prev; i < target.length; i++) feed.subCb?.(target[i]);
  feed.current = target;
}

export type ChartPeriod = '4h' | '1h';

interface Props {
  symbol: string;
  bars1h: Bar[];
  cursor: number;
  openTrade: OpenTrade | null;
  /** 4h 周期启用的指标名列表 */
  indicators4h: string[];
  /** 1h 周期启用的指标名列表 */
  indicators1h: string[];
  /** 当前显示的周期 */
  period: ChartPeriod;
  onPeriodChange: (p: ChartPeriod) => void;
}

export function ChartPanel({
  symbol,
  bars1h,
  cursor,
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
  // 已装载的周期/标的，用于判断是否需要重新 init
  const loadedKeyRef = useRef<string>('');
  // 上一次处理过的点击（用于去重同一次物理点击的重复派发）
  const lastClickRef = useRef<{ ts: number; at: number } | null>(null);

  /** 十字光标所在那根 K 线（跟随） */
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  /** 被点击锁定的那根 K 线 */
  const [pinnedTime, setPinnedTime] = useState<number | null>(null);
  /** 锁定标记在画布上的 x 像素位置 */
  const [pinX, setPinX] = useState<number | null>(null);

  // 游标只用于「初始化时取已揭示切片」，不作为重建图表的依赖
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const revealed1h = useMemo(() => (cursor < 0 ? [] : bars1h.slice(0, cursor + 1)), [bars1h, cursor]);
  const revealed4h = useMemo(() => derive4h(revealed1h), [revealed1h]);

  const activeBars = period === '4h' ? revealed4h : revealed1h;

  // 切换周期后，上一根锁定的 K 线在新序列里不存在 → 清除锁定与悬停
  useEffect(() => {
    setPinnedTime(null);
    setHoverTime(null);
  }, [period, symbol]);

  // ---------- 初始化图表实例 ----------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = init(el, { styles: BINANCE_STYLES, locale: 'zh-CN' });
    if (!chart) return;
    chartRef.current = chart;
    chart.setOffsetRightDistance(64);

    const ro = new ResizeObserver(() => {
      chart.resize();
      applyPaneHeights(chart, containerRef.current!, paneIdsRef.current, weightsRef.current);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      dispose(chart);
      chartRef.current = null;
    };
  }, []);

  // ---------- 点击 K 线 / 十字光标跟随 ----------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // onCandleBarClick 的载荷：{ dataIndex, x, data: { current, prev } }
    const onBarClick = (data?: unknown) => {
      const d = data as { data?: { current?: KLineData } } | undefined;
      const k = d?.data?.current;
      if (!k?.timestamp) return;
      // klinecharts 的 candle_solid 会画「影线 + 实体」两个 rect，
      // 两个 rect 都挂了同一个 click handler —— 一次物理点击会被派发两次。
      // 不去重的话，「再点一次解除锁定」的 toggle 会被自己抵消（点了等于没点）。
      const now = performance.now();
      const last = lastClickRef.current;
      if (last && last.ts === k.timestamp && now - last.at < 60) return;
      lastClickRef.current = { ts: k.timestamp, at: now };
      // 再点同一根 = 解除锁定
      setPinnedTime((prev) => (prev === k.timestamp ? null : k.timestamp));
    };

    // onCrosshairChange 的载荷：Crosshair（含 kLineData）
    const onCrosshair = (data?: unknown) => {
      const c = data as { kLineData?: KLineData } | undefined;
      setHoverTime(c?.kLineData?.timestamp ?? null);
    };

    chart.subscribeAction('onCandleBarClick', onBarClick);
    chart.subscribeAction('onCrosshairChange', onCrosshair);
    return () => {
      chart.unsubscribeAction('onCandleBarClick', onBarClick);
      chart.unsubscribeAction('onCrosshairChange', onCrosshair);
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
      const px = chart.convertToPixel({ timestamp: pinnedTime }) as Partial<Coordinate>;
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

  // ---------- 换标的 / 换周期：重建 feed 并 init ----------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || bars1h.length === 0) return;

    const key = `${symbol}|${period}`;
    if (loadedKeyRef.current === key) return;

    const last = bars1h[bars1h.length - 1];
    const precision = pricePrecision(last.close);

    const feed = createFeed();
    feedRef.current = feed;

    const revealed = cursorRef.current >= 0 ? bars1h.slice(0, cursorRef.current + 1) : [];
    feed.current = (period === '4h' ? derive4h(revealed) : revealed).map(toKLineData);

    chart.setSymbol({ ticker: `${symbol}-${period}`, pricePrecision: precision, volumePrecision: 2 });
    chart.setPeriod({ type: 'hour', span: period === '4h' ? 4 : 1 });
    chart.setDataLoader(feed.loader);
    chart.resetData();

    loadedKeyRef.current = key;
  }, [symbol, period, bars1h]);

  // ---------- 游标推进：增量同步 ----------
  useEffect(() => {
    const chart = chartRef.current;
    const feed = feedRef.current;
    if (!chart || !feed) return;
    if (loadedKeyRef.current !== `${symbol}|${period}`) return;

    syncFeed(chart, feed, activeBars.map(toKLineData));
  }, [activeBars, symbol, period]);

  // ---------- 持仓：画入场/止损/目标线（只在 1h 图上） ----------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.removeOverlay({ groupId: TRADE_GROUP });
    if (!openTrade || period !== '1h') return;

    const ts = revealed1h.length ? revealed1h[revealed1h.length - 1].time : Date.now();
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
  }, [openTrade, revealed1h, period]);

  // ---------- 详情：锁定 > 悬停 > 最新一根 ----------
  const detail = useMemo(() => {
    if (!activeBars.length) return null;
    const ts = pinnedTime ?? hoverTime ?? activeBars[activeBars.length - 1].time;
    const idx = activeBars.findIndex((b) => b.time === ts);
    if (idx < 0) return null;
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

  return (
    <div className="chart-panel">
      <div className="chart-toolbar">
        <div className="period-tabs" role="tablist" aria-label="K线周期">
          <button
            role="tab"
            aria-selected={period === '4h'}
            className={`period-tab ${period === '4h' ? 'active' : ''}`}
            onClick={() => onPeriodChange('4h')}
          >
            <span className="period-main">4h</span>
            <span className="period-sub">趋势</span>
          </button>
          <button
            role="tab"
            aria-selected={period === '1h'}
            className={`period-tab ${period === '1h' ? 'active' : ''}`}
            onClick={() => onPeriodChange('1h')}
          >
            <span className="period-main">1h</span>
            <span className="period-sub">入场</span>
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

      <div className="chart-canvas-wrap">
        <div ref={containerRef} className="chart-canvas" />
        {locked && pinX !== null && <div className="pin-marker" style={{ left: `${pinX}px` }} />}
      </div>

      <div className="chart-foot">
        <span className="muted">点击 K 线锁定查看该根详情，再次点击解除</span>
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
