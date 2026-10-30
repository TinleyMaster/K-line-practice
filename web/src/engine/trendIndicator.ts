/**
 * 自定义指标：趋势结构（Trend Structure）
 *
 * 复现 MT5 指标 "Trend.mq5" 的核心逻辑：
 *   - 趋势 K 线识别（实体大、影线小）
 *   - 中期高低点标记（左右各 swingWin 根内的最高/最低，才是真正的拐点）
 *   - 防守位计算（下跌趋势 = 最后一个中期高点；上涨趋势 = 最后一个中期低点）
 *   - EMA 共振验证（21 / 55 / 144）
 *
 * 通过 klinecharts 的 registerIndicator 注册，名字为 'TRENDSTRUCT'，
 * 以便 IndicatorPicker / ChartPanel 的通用装载逻辑能识别它。
 */
import { registerIndicator, registerOverlay } from 'klinecharts';

registerIndicator({
  name: 'TRENDSTRUCT',
  shortName: 'TrendStruct',
  series: 'price',
  calcParams: [40, 15, 6, 21, 55, 144],
  precision: 2,
  shouldOhlc: true,
  figures: [
    { key: 'emaFast', title: 'EMA21: ', type: 'line' },
    { key: 'emaMid', title: 'EMA55: ', type: 'line' },
    { key: 'emaSlow', title: 'EMA144: ', type: 'line' },
    { key: 'defense', title: '防守位: ', type: 'line' },
    { key: 'trendBull', title: '多头趋势K: ', type: 'circle', attrs: () => ({ r: 3.5 }) },
    { key: 'trendBear', title: '空头趋势K: ', type: 'circle', attrs: () => ({ r: 3.5 }) },
    { key: 'midHigh', title: '中期高点: ', type: 'circle', attrs: () => ({ r: 3.5 }) },
    { key: 'midLow', title: '中期低点: ', type: 'circle', attrs: () => ({ r: 3.5 }) },
  ],
  calc: (dataList, indicator) => {
    const params = indicator.calcParams as number[];
    const minBody = Number(params?.[0] ?? 10);
    const maxShadow = Number(params?.[1] ?? 30);
    const swingWin = Math.max(1, Number(params?.[2] ?? 6)); // 左侧窗口：与之前几根比
    const rightWin = 1; // 右侧只等 1 根确认 ⇒ 拐点近乎实时出现，不再滞后 6 根
    const fastP = Math.max(1, Number(params?.[3] ?? 21));
    const midP = Math.max(1, Number(params?.[4] ?? 55));
    const slowP = Math.max(1, Number(params?.[5] ?? 144));

    // 先在整个数据上计算 swing high / low：左侧 swingWin 根 + 右侧 rightWin 根都更低/更高
    const swingHigh: boolean[] = new Array(dataList.length).fill(false);
    const swingLow: boolean[] = new Array(dataList.length).fill(false);
    for (let i = 0; i < dataList.length; i++) {
      if (i - swingWin < 0 || i + rightWin >= dataList.length) continue;
      let isH = true;
      let isL = true;
      for (let j = i - swingWin; j <= i + rightWin; j++) {
        if (j === i) continue;
        if (dataList[j].high >= dataList[i].high) isH = false;
        if (dataList[j].low <= dataList[i].low) isL = false;
      }
      if (isH) swingHigh[i] = true;
      if (isL) swingLow[i] = true;
    }

    let emaFastVal: number | undefined;
    let emaMidVal: number | undefined;
    let emaSlowVal: number | undefined;
    let closeSumFast = 0;
    let closeSumMid = 0;
    let closeSumSlow = 0;

    let lastMidHigh: number | null = null;
    let lastMidLow: number | null = null;

    return dataList.map((k, i) => {
      const range = k.high - k.low;
      const body = Math.abs(k.close - k.open);
      const bodyPct = range > 0 ? (body / range) * 100 : 0;
      const shadowPct = range > 0 ? ((range - body) / range) * 100 : 0;

      let trendBull: number | undefined;
      let trendBear: number | undefined;
      if (k.close > k.open && bodyPct >= minBody && shadowPct <= maxShadow) {
        trendBull = k.close;
      }
      if (k.close < k.open && bodyPct >= minBody && shadowPct <= maxShadow) {
        trendBear = k.close;
      }

      const midHigh = swingHigh[i] ? k.high : undefined;
      const midLow = swingLow[i] ? k.low : undefined;
      if (midHigh !== undefined) lastMidHigh = midHigh;
      if (midLow !== undefined) lastMidLow = midLow;

      let defense: number | undefined;
      if (k.close < k.open && lastMidHigh !== null) defense = lastMidHigh;
      else if (k.close > k.open && lastMidLow !== null) defense = lastMidLow;

      const close = k.close;
      // fast EMA
      if (i < fastP - 1) {
        closeSumFast += close;
      } else if (i === fastP - 1) {
        closeSumFast += close;
        emaFastVal = closeSumFast / fastP;
      } else if (emaFastVal !== undefined) {
        emaFastVal = (2 * close + (fastP - 1) * emaFastVal) / (fastP + 1);
      }
      // mid EMA
      if (i < midP - 1) {
        closeSumMid += close;
      } else if (i === midP - 1) {
        closeSumMid += close;
        emaMidVal = closeSumMid / midP;
      } else if (emaMidVal !== undefined) {
        emaMidVal = (2 * close + (midP - 1) * emaMidVal) / (midP + 1);
      }
      // slow EMA
      if (i < slowP - 1) {
        closeSumSlow += close;
      } else if (i === slowP - 1) {
        closeSumSlow += close;
        emaSlowVal = closeSumSlow / slowP;
      } else if (emaSlowVal !== undefined) {
        emaSlowVal = (2 * close + (slowP - 1) * emaSlowVal) / (slowP + 1);
      }

      return {
        emaFast: i >= fastP - 1 ? emaFastVal : undefined,
        emaMid: i >= midP - 1 ? emaMidVal : undefined,
        emaSlow: i >= slowP - 1 ? emaSlowVal : undefined,
        defense,
        trendBull,
        trendBear,
        midHigh,
        midLow,
        lastMidHigh,
        lastMidLow,
      };
    });
  },
  createTooltipDataSource: (params) => {
    const { indicator, crosshair } = params as {
      indicator: { result: Array<Record<string, number | null | undefined>> };
      crosshair: { dataIndex?: number };
    };
    const idx = crosshair?.dataIndex;
    const result = indicator?.result;
    const fmt = (v: number | null | undefined) =>
      v == null || !Number.isFinite(v as number) ? '—' : (v as number).toLocaleString('en-US', { maximumFractionDigits: 1 });
    if (idx == null || !result || !result[idx]) {
      return { name: '趋势结构', calcParamsText: '', features: [], legends: [] };
    }
    const cur = result[idx];
    const trend = cur.trendBull != null ? '多' : cur.trendBear != null ? '空' : '无';
    const trendColor = cur.trendBull != null ? '#0ECB81' : cur.trendBear != null ? '#F6465D' : '#848E9C';
    return {
      name: '趋势结构',
      calcParamsText: '',
      features: [],
      legends: [
        { title: '防守位', value: fmt(cur.defense) },
        { title: '趋势K', value: { text: trend, color: trendColor } },
        { title: '近期高点', value: fmt(cur.lastMidHigh) },
        { title: '近期低点', value: fmt(cur.lastMidLow) },
      ],
    };
  },
  styles: {
    lines: [
      { color: '#F6465D', size: 1.5 },
      { color: '#2962FF', size: 1.5 },
      { color: '#FFFFFF', size: 1.5 },
      { color: '#9C27B0', size: 1.5, style: 'dashed' },
    ],
    circles: [
      { upColor: '#0ECB81', downColor: '#0ECB81', noChangeColor: '#0ECB81' }, // trendBull 多头趋势K（绿）
      { upColor: '#F6465D', downColor: '#F6465D', noChangeColor: '#F6465D' }, // trendBear 空头趋势K（红）
      { upColor: '#FFA726', downColor: '#FFA726', noChangeColor: '#FFA726' }, // midHigh 中期高点（橙）
      { upColor: '#42A5F5', downColor: '#42A5F5', noChangeColor: '#42A5F5' }, // midLow 中期低点（蓝）
    ],
  },
});

// 回测买卖点标记 overlay
registerOverlay({
  name: 'backtestMarker',
  totalStep: 1,
  createPointFigures: ({ coordinates, overlay }) => {
    const c = coordinates[0];
    const ext = (overlay.extendData || {}) as { label?: string; color?: string; kind?: string; side?: string };
    const color = ext.color || '#FCD535';
    const label = ext.label || '';
    const isEntry = ext.kind === 'entry';
    // 箭头：入场向上/向下三角，出场用小圆
    if (isEntry) {
      const tri = ext.side === 'short'
        ? [{ x: c.x, y: c.y }, { x: c.x - 6, y: c.y - 10 }, { x: c.x + 6, y: c.y - 10 }]
        : [{ x: c.x, y: c.y }, { x: c.x - 6, y: c.y + 10 }, { x: c.x + 6, y: c.y + 10 }];
      return [
        { type: 'polygon', attrs: { coordinates: tri }, styles: { style: 'fill', color, borderColor: color, borderSize: 1 } },
        { type: 'text', attrs: { x: c.x, y: ext.side === 'short' ? c.y - 16 : c.y + 16, text: label, align: 'center', baseline: 'middle' }, styles: { color, size: 10, weight: 'bold' } },
      ];
    }
    return [
      { type: 'circle', attrs: { x: c.x, y: c.y, r: 4 }, styles: { style: 'fill', color, borderColor: color, borderSize: 1 } },
      { type: 'text', attrs: { x: c.x, y: c.y + 14, text: label, align: 'center', baseline: 'middle' }, styles: { color, size: 9 } },
    ];
  },
});
