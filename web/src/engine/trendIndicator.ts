/**
 * 自定义指标：趋势结构（Trend Structure）
 *
 * 复现 MT5 指标 "Trend.mq5" 的核心逻辑：
 *   - 趋势 K 线识别（实体大、影线小）
 *   - 中期高低点标记（锚定 MACD 结构：零轴上方死叉前一段的极高=高点，零轴下方金叉前一段的极低=低点）
 *   - 防守位计算（下跌趋势 = 最后一个中期高点；上涨趋势 = 最后一个中期低点）
 *   - EMA 共振验证（21 / 55 / 144）
 *
 * 通过 klinecharts 的 registerIndicator 注册，名字为 'TRENDSTRUCT'，
 * 以便 IndicatorPicker / ChartPanel 的通用装载逻辑能识别它。
 */
import { registerIndicator, registerOverlay } from 'klinecharts';

/**
 * 合并连续同类型摆动点：保证高/低严格交替。
 * 当序列里出现两个及以上连续低点（或连续高点）时，只保留最极端的那个
 * （低点取更低、高点取更高），其余丢弃。这样 H-L-H-L 结构才干净，
 * 之后才能可靠地判断"更高高/更高低"等趋势特征。
 */
function enforceAlternation(highsIn: (number | null)[], lowsIn: (number | null)[]) {
  const n = highsIn.length;
  const pts: { i: number; type: 'H' | 'L'; v: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (highsIn[i] != null) pts.push({ i, type: 'H', v: highsIn[i] as number });
    else if (lowsIn[i] != null) pts.push({ i, type: 'L', v: lowsIn[i] as number });
  }
  // 反复扫描，合并相邻同类型点，直到严格交替
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k + 1 < pts.length; k++) {
      if (pts[k].type === pts[k + 1].type) {
        const a = pts[k];
        const b = pts[k + 1];
        const keep = a.type === 'H' ? (a.v >= b.v ? a : b) : (a.v <= b.v ? a : b);
        pts.splice(k, 2, keep);
        changed = true;
        break;
      }
    }
  }
  const highs = new Array(n).fill(null);
  const lows = new Array(n).fill(null);
  for (const p of pts) {
    if (p.type === 'H') highs[p.i] = p.v;
    else lows[p.i] = p.v;
  }
  return { highs, lows };
}

/** 一段被识别出的趋势行情 */
export interface TrendMove {
  dir: 'up' | 'down';
  startIdx: number;
  endIdx: number;
  startPrice: number;
  endPrice: number;
}

/**
 * 从 TRENDSTRUCT 指标的结算结果（midHigh / midLow 仅在拐点处非空）重建严格交替的摆动序列。
 */
export function buildSeq(
  result: Array<{ midHigh?: number | null; midLow?: number | null }>,
): Array<{ i: number; type: 'H' | 'L'; price: number }> {
  const seq: Array<{ i: number; type: 'H' | 'L'; price: number }> = [];
  for (let i = 0; i < result.length; i++) {
    const r = result[i];
    if (r && r.midHigh != null) seq.push({ i, type: 'H', price: r.midHigh as number });
    else if (r && r.midLow != null) seq.push({ i, type: 'L', price: r.midLow as number });
  }
  return seq;
}

/**
 * 从摆动序列识别"趋势行情"：用结构破坏判定（而非单根冲动）。
 *   - 上涨行情：只要低点持续抬高（HL）就延续，直到出现更低低（LL）才结束；
 *   - 下跌行情：高点持续降低（LH）就延续，直到出现更高高（HH）才结束。
 * 中途的更低高 / 更高低只是回调，不破坏趋势。
 * 只保留"真正展开"的行情：至少延伸过一次（出现更高高 / 更低低），且幅度 > minMagnitude。
 * 与 server/src/services/analyze_trends.mjs 的 detectMoves 同算法、同口径。
 */
export function detectTrendMoves(
  seq: Array<{ i: number; type: 'H' | 'L'; price: number }>,
  minMagnitude = 0.01,
): TrendMove[] {
  const out: Array<TrendMove & { ext: boolean; legs: number }> = [];
  let cur: (TrendMove & { ext: boolean; legs: number }) | null = null;
  let lastHigh: { i: number; price: number } | null = null;
  let lastLow: { i: number; price: number } | null = null;
  for (const s of seq) {
    if (s.type === 'H') {
      if (cur && cur.dir === 'up') {
        if (lastHigh && s.price > lastHigh.price) {
          cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true;
        }
      } else if (cur && cur.dir === 'down') {
        if (lastHigh && s.price < lastHigh.price) {
          cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true;
        } else {
          out.push(cur); cur = null;
        }
      }
      if (!cur && lastHigh && lastLow && s.price < lastHigh.price) {
        cur = { dir: 'down', startIdx: lastHigh.i, startPrice: lastHigh.price, endIdx: s.i, endPrice: s.price, legs: 1, ext: false };
        out.push(cur);
      }
      lastHigh = { i: s.i, price: s.price };
    } else {
      if (cur && cur.dir === 'up') {
        if (lastLow && s.price > lastLow.price) {
          cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true;
        } else {
          out.push(cur); cur = null;
        }
      } else if (cur && cur.dir === 'down') {
        if (lastLow && s.price < lastLow.price) {
          cur.endIdx = s.i; cur.endPrice = s.price; cur.legs++; cur.ext = true;
        }
      }
      if (!cur && lastHigh && lastLow && s.price > lastLow.price) {
        cur = { dir: 'up', startIdx: lastLow.i, startPrice: lastLow.price, endIdx: s.i, endPrice: s.price, legs: 1, ext: false };
        out.push(cur);
      }
      lastLow = { i: s.i, price: s.price };
    }
  }
  if (cur) out.push(cur);
  return out
    .filter((m) => m.ext && Math.abs(m.endPrice - m.startPrice) / m.startPrice > minMagnitude)
    .map(({ ext, legs, ...rest }) => rest);
}

registerIndicator({
  name: 'TRENDSTRUCT',
  shortName: 'TrendStruct',
  series: 'price',
  calcParams: [40, 15, 12, 26, 9, 21, 55, 144],
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
    const minBody = Number(params?.[0] ?? 40);
    const maxShadow = Number(params?.[1] ?? 15);
    // 摆动高低点改为"锚定 MACD 交叉"：高位 = 零轴上方死叉前一段的极高；低位 = 零轴下方金叉前一段的极低。
    // 这样只保留由 MACD 结构确认的趋势拐点，避免满屏高低点。
    const mFast = Math.max(1, Number(params?.[2] ?? 12));
    const mSlow = Math.max(1, Number(params?.[3] ?? 26));
    const mSig = Math.max(1, Number(params?.[4] ?? 9));
    const fastP = Math.max(1, Number(params?.[5] ?? 21));
    const midP = Math.max(1, Number(params?.[6] ?? 55));
    const slowP = Math.max(1, Number(params?.[7] ?? 144));

    const n = dataList.length;

    // EMA 计算（自动跳过前导 warmup 的空值）
    const emaOf = (vals: number[], period: number): (number | null)[] => {
      const out: (number | null)[] = new Array(n).fill(null);
      let ema: number | null = null;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        if (v == null || !Number.isFinite(v)) continue;
        if (count < period - 1) { sum += v; count++; }
        else if (count === period - 1) { sum += v; ema = sum / period; out[i] = ema; count++; }
        else { ema = (2 * v + (period - 1) * (ema as number)) / (period + 1); out[i] = ema; count++; }
      }
      return out;
    };

    const closes = dataList.map((k) => k.close);
    const emaMF = emaOf(closes, mFast);
    const emaMS = emaOf(closes, mSlow);
    const macdLine: (number | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (emaMF[i] != null && emaMS[i] != null) macdLine[i] = (emaMF[i] as number) - (emaMS[i] as number);
    }
    const signal = emaOf(macdLine as number[], mSig);

    // 锚定摆动：以 MACD 交叉为每段端点，每段（上一交叉 → 本交叉）只取一个极值。
    // 死叉且位于零轴上方 → 该段极高记为高点；金叉且位于零轴下方 → 该段极低记为低点。
    // 找不到明确对应极值时（"没有对应"），取该段内最近的极值，效果一致。
    const highs: (number | null)[] = new Array(n).fill(null);
    const lows: (number | null)[] = new Array(n).fill(null);
    let prevCross = -1;
    for (let i = 1; i < n; i++) {
      const m0 = macdLine[i - 1] as number | null;
      const m1 = macdLine[i] as number | null;
      const s0 = signal[i - 1] as number | null;
      const s1 = signal[i] as number | null;
      if (m0 == null || m1 == null || s0 == null || s1 == null) continue; // warmup
      const golden = m0 <= s0 && m1 > s1; // 金叉
      const death = m0 >= s0 && m1 < s1; // 死叉
      if (golden || death) {
        const start = Math.max(0, prevCross + 1);
        if (death && m1 > 0) {
          // 零轴上方死叉：取前一段（上一交叉 → 本死叉）的极高作为高点
          let best = start;
          let bestH = -Infinity;
          for (let j = start; j <= i; j++) {
            if (dataList[j].high > bestH) { bestH = dataList[j].high; best = j; }
          }
          highs[best] = dataList[best].high;
        }
        if (golden && m1 < 0) {
          // 零轴下方金叉：取前一段的极低作为低点
          let best = start;
          let bestL = Infinity;
          for (let j = start; j <= i; j++) {
            if (dataList[j].low < bestL) { bestL = dataList[j].low; best = j; }
          }
          lows[best] = dataList[best].low;
        }
        prevCross = i;
      }
    }

    // 合并连续同类型点：保证高/低严格交替（出现两个及以上连续低点/高点时只保留最极端的那个）
    const merged = enforceAlternation(highs, lows);
    const swingHigh = merged.highs;
    const swingLow = merged.lows;

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

      const midHigh = swingHigh[i] ?? undefined;
      const midLow = swingLow[i] ?? undefined;
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

// 多周期共振标记：1h 与 15m（独立周期）摆动高低点价格重合处画空心环，提示强 S/R。
// 只用空心环（不用文字标签），避免标签压在 K 线上；含义由颜色区分（橙红=阻力 / 青=支撑）。
registerOverlay({
  name: 'confluenceMarker',
  totalStep: 1,
  createPointFigures: ({ coordinates, overlay }) => {
    const c = coordinates[0];
    const ext = (overlay.extendData || {}) as { kind?: 'high' | 'low' };
    const isHigh = ext.kind === 'high';
    const ring = isHigh ? '#FF7043' : '#26C6DA'; // 阻力橙红 / 支撑青
    return [
      {
        type: 'circle',
        attrs: { x: c.x, y: c.y, r: 9 },
        styles: { style: 'stroke', color: ring, borderColor: ring, borderSize: 2 },
      },
    ];
  },
});

/**
 * 趋势行情色块区间标记：在每段被识别出的趋势行情上，用半透明色块填出它的"价格区间"，
 * 并在起止摆动点画实心圆。上涨=绿色、下跌=红色。
 *
 * 每个 overlay 实例承载一段趋势，points 固定 6 个（数据坐标）：
 *   [0..3] = 区间矩形的四个角（startTime,top / endTime,top / endTime,bottom / startTime,bottom）
 *   [4]    = 起点摆动点（timestamp, startPrice）
 *   [5]    = 终点摆动点（timestamp, endPrice）
 * createPointFigures 据此画出 1 个矩形 + 2 个圆心。
 */
registerOverlay({
  name: 'trendRegime',
  totalStep: 6,
  createPointFigures: ({ coordinates, overlay }) => {
    const ext = (overlay.extendData || {}) as { dir?: 'up' | 'down' };
    const dir = ext.dir || 'up';
    const fill = dir === 'up' ? 'rgba(14,203,129,0.12)' : 'rgba(246,70,93,0.12)';
    const border = dir === 'up' ? 'rgba(14,203,129,0.55)' : 'rgba(246,70,93,0.55)';
    const mc = dir === 'up' ? '#0ECB81' : '#F6465D';
    if (coordinates.length < 6) return [];
    const xs = coordinates.slice(0, 4).map((p) => p.x);
    const ys = coordinates.slice(0, 4).map((p) => p.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    return [
      {
        type: 'rect',
        attrs: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        styles: { style: 'fill', color: fill, borderColor: border, borderSize: 1 },
      },
      {
        type: 'circle',
        attrs: { x: coordinates[4].x, y: coordinates[4].y, r: 5 },
        styles: { style: 'fill', color: mc, borderColor: '#ffffff', borderSize: 1.5 },
      },
      {
        type: 'circle',
        attrs: { x: coordinates[5].x, y: coordinates[5].y, r: 5 },
        styles: { style: 'fill', color: mc, borderColor: '#ffffff', borderSize: 1.5 },
      },
    ] as never;
  },
});
