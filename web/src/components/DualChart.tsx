import { useEffect, useMemo, useRef, useState } from 'react';
import {
  dispose,
  init,
  type Chart,
  type DataLoader,
  type DeepPartial,
  type KLineData,
  type Styles,
} from 'klinecharts';
import type { Bar, OpenTrade } from '../types';
import { derive4h, pricePrecision } from '../engine/bars';
import { BREAKPOINTS, useMediaQuery } from '../hooks/useMediaQuery';

const CANDLE_PANE = 'candle_pane';
const VOLUME_PANE = 'volume_pane';
const TRADE_GROUP = 'trade-lines';

const DARK_STYLES: DeepPartial<Styles> = {
  grid: {
    show: true,
    horizontal: { color: 'rgba(255,255,255,0.06)', style: 'solid' },
    vertical: { color: 'rgba(255,255,255,0.04)', style: 'solid' },
  },
  candle: {
    type: 'candle_solid',
    bar: {
      upColor: '#ef4d4d',
      downColor: '#22c55e',
      noChangeColor: '#8b8b8b',
      upBorderColor: '#ef4d4d',
      downBorderColor: '#22c55e',
      upWickColor: '#ef4d4d',
      downWickColor: '#22c55e',
      noChangeBorderColor: '#8b8b8b',
      noChangeWickColor: '#8b8b8b',
    },
    priceMark: {
      show: true,
      high: { color: '#8b8b8b', textSize: 10 },
      low: { color: '#8b8b8b', textSize: 10 },
      last: {
        show: true,
        upColor: '#ef4d4d',
        downColor: '#22c55e',
        noChangeColor: '#8b8b8b',
        text: { size: 10, color: '#8b8b8b' },
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
    tickText: { color: '#8b8b8b', size: 10, family: 'inherit', weight: 'normal', marginStart: 8, marginEnd: 8 },
  },
  yAxis: {
    show: true,
    axisLine: { color: 'rgba(255,255,255,0.12)' },
    tickLine: { color: 'rgba(255,255,255,0.12)' },
    tickText: { color: '#8b8b8b', size: 10, family: 'inherit', weight: 'normal', marginStart: 4, marginEnd: 8 },
  },
  separator: { size: 1, color: 'rgba(255,255,255,0.08)', fill: true, activeBackgroundColor: 'rgba(255,255,255,0.04)' },
  crosshair: {
    show: true,
    horizontal: {
      show: true,
      line: { color: 'rgba(255,255,255,0.35)', style: 'dashed', dashedValue: [2, 2] },
      text: {
        show: true,
        color: '#0d1117',
        size: 10,
        family: 'inherit',
        weight: 'normal',
        backgroundColor: '#8b8b8b',
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
        color: '#0d1117',
        size: 10,
        family: 'inherit',
        weight: 'normal',
        backgroundColor: '#8b8b8b',
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
 * 副图（VOL）高度自适应。
 *
 * klinecharts 给副图分配的默认高度是固定 100px（minHeight 30），
 * 主图（candle_pane）吸收剩余空间。在矮屏（手机横放，图表容器仅 200px）
 * 副图会吃掉一半，蜡烛主图被压成一条缝，完全没法看形态。
 *
 * 这里按容器高度给副图分配 26%，夹在 [48, 100]，
 * 容器越大副图绝对值封顶在 100px（保持桌面观感），越小则按比例收缩。
 */
function applyPaneHeights(chart: Chart, container: HTMLElement) {
  const h = container.clientHeight;
  if (!h) return;
  const volH = Math.round(Math.min(100, Math.max(48, h * 0.26)));
  chart.setPaneOptions({ id: VOLUME_PANE, height: volH, minHeight: 40 });
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

interface Props {
  symbol: string;
  bars1h: Bar[];
  cursor: number;
  openTrade: OpenTrade | null;
  chartHeight?: number;
}

export function DualChart({ symbol, bars1h, cursor, openTrade }: Props) {
  const topRef = useRef<HTMLDivElement>(null);
  const botRef = useRef<HTMLDivElement>(null);
  const chart4hRef = useRef<Chart | null>(null);
  const chart1hRef = useRef<Chart | null>(null);
  const feed4hRef = useRef<Feed | null>(null);
  const feed1hRef = useRef<Feed | null>(null);
  const loadedSymbolRef = useRef<string>('');

  // 窄屏（手机竖屏 / 矮屏横屏）改为单图 + Tab 切换，iPad 及以上保持双图
  const isNarrow = useMediaQuery(BREAKPOINTS.singleChart);
  const [pane, setPane] = useState<'4h' | '1h'>('4h');

  const revealed1h = useMemo(() => (cursor < 0 ? [] : bars1h.slice(0, cursor + 1)), [bars1h, cursor]);
  const revealed4h = useMemo(() => derive4h(revealed1h), [revealed1h]);

  // 游标只用于「初始化时取已揭示切片」，不作为重建图表的依赖
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // ---------- 初始化图表实例 ----------
  useEffect(() => {
    if (!topRef.current || !botRef.current) return;

    const c4 = init(topRef.current, { styles: DARK_STYLES, locale: 'zh-CN' });
    const c1 = init(botRef.current, { styles: DARK_STYLES, locale: 'zh-CN' });
    if (!c4 || !c1) return;
    chart4hRef.current = c4;
    chart1hRef.current = c1;

    c4.createIndicator({ name: 'MA', paneId: CANDLE_PANE, id: 'ma4h', calcParams: [20, 60] });
    c4.createIndicator({ name: 'VOL', paneId: VOLUME_PANE, id: 'vol4h' });
    c1.createIndicator({ name: 'MA', paneId: CANDLE_PANE, id: 'ma1h', calcParams: [5, 20, 60] });
    c1.createIndicator({ name: 'VOL', paneId: VOLUME_PANE, id: 'vol1h' });

    c4.setOffsetRightDistance(60);
    c1.setOffsetRightDistance(60);

    // 副图高度随容器自适应（必须在指标创建之后，副图才会存在）
    applyPaneHeights(c4, topRef.current);
    applyPaneHeights(c1, botRef.current);

    const ro = new ResizeObserver(() => {
      c4.resize();
      c1.resize();
      applyPaneHeights(c4, topRef.current!);
      applyPaneHeights(c1, botRef.current!);
    });
    ro.observe(topRef.current);
    ro.observe(botRef.current);

    return () => {
      ro.disconnect();
      dispose(c4);
      dispose(c1);
      chart4hRef.current = null;
      chart1hRef.current = null;
    };
  }, []);

  // ---------- 换标的 / 换数据集：重建 feed 并 init ----------
  useEffect(() => {
    const c4 = chart4hRef.current;
    const c1 = chart1hRef.current;
    if (!c4 || !c1 || bars1h.length === 0) return;

    const last = bars1h[bars1h.length - 1];
    const precision = pricePrecision(last.close);

    const feed4 = createFeed();
    const feed1 = createFeed();
    feed4hRef.current = feed4;
    feed1hRef.current = feed1;

    const initial1h = (cursorRef.current >= 0 ? bars1h.slice(0, cursorRef.current + 1) : []).map(toKLineData);
    const initial4h = derive4h(
      cursorRef.current >= 0 ? bars1h.slice(0, cursorRef.current + 1) : [],
    ).map(toKLineData);
    feed1.current = initial1h;
    feed4.current = initial4h;

    c4.setSymbol({ ticker: `${symbol}-4h`, pricePrecision: precision, volumePrecision: 2 });
    c4.setPeriod({ type: 'hour', span: 4 });
    c4.setDataLoader(feed4.loader);

    c1.setSymbol({ ticker: `${symbol}-1h`, pricePrecision: precision, volumePrecision: 2 });
    c1.setPeriod({ type: 'hour', span: 1 });
    c1.setDataLoader(feed1.loader);

    loadedSymbolRef.current = symbol;
  }, [symbol, bars1h]);

  // ---------- 游标推进：增量同步 ----------
  useEffect(() => {
    const c4 = chart4hRef.current;
    const c1 = chart1hRef.current;
    const f4 = feed4hRef.current;
    const f1 = feed1hRef.current;
    if (!c4 || !c1 || !f4 || !f1) return;
    if (loadedSymbolRef.current !== symbol) return;

    syncFeed(c1, f1, revealed1h.map(toKLineData));
    syncFeed(c4, f4, revealed4h.map(toKLineData));
  }, [revealed1h, revealed4h, symbol]);

  // ---------- 持仓：画入场/止损/目标线 ----------
  useEffect(() => {
    const c1 = chart1hRef.current;
    if (!c1) return;
    c1.removeOverlay({ groupId: TRADE_GROUP });
    if (!openTrade) return;

    const ts = revealed1h.length ? revealed1h[revealed1h.length - 1].time : Date.now();
    const lines: Array<{ value: number; color: string; label: string }> = [
      { value: openTrade.entryPrice, color: '#3b82f6', label: '入场' },
      { value: openTrade.stopLoss, color: '#ef4d4d', label: '止损' },
    ];
    if (openTrade.takeProfit !== null) {
      lines.push({ value: openTrade.takeProfit, color: '#22c55e', label: '目标' });
    }
    for (const l of lines) {
      c1.createOverlay({
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
  }, [openTrade, revealed1h]);

  return (
    <div className={`dual-chart ${isNarrow ? 'narrow' : ''}`}>
      {isNarrow && (
        <div className="pane-switch" role="tablist" aria-label="图表周期">
          <button
            role="tab"
            aria-selected={pane === '4h'}
            className={`pane-tab ${pane === '4h' ? 'active' : ''}`}
            onClick={() => setPane('4h')}
          >
            4h · 趋势
          </button>
          <button
            role="tab"
            aria-selected={pane === '1h'}
            className={`pane-tab ${pane === '1h' ? 'active' : ''}`}
            onClick={() => setPane('1h')}
          >
            1h · 入场
          </button>
        </div>
      )}

      <div className={`chart-block ${isNarrow && pane !== '4h' ? 'pane-off' : ''}`}>
        <div className="chart-title">
          <span className="chart-tag trend">4h · 趋势</span>
          <span className="chart-hint">只做顺着 4h 方向的单</span>
        </div>
        <div ref={topRef} className="chart-canvas" />
      </div>
      <div className={`chart-block ${isNarrow && pane !== '1h' ? 'pane-off' : ''}`}>
        <div className="chart-title">
          <span className="chart-tag entry">1h · 入场</span>
          <span className="chart-hint">看到 1h 收盘确认再动手</span>
        </div>
        <div ref={botRef} className="chart-canvas" />
      </div>
    </div>
  );
}
