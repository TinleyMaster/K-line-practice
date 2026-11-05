/**
 * 自定义指标：SuperTrend（超级趋势）with Entry
 *
 * 复刻 TradingView 经典 "Supertrend" 指标 + 入场箭头：
 *   - 以 ATR（Wilder 平滑）构建上下通道（hl2 ± factor × ATR）；
 *   - 通道在趋势内不回穿价格（finalUpper / finalLower 的「夹逼」逻辑）；
 *   - 趋势方向 dir：收盘上穿下轨 → 转多(1)，下穿上轨 → 转空(-1)；
 *   - 超级趋势线：多头段画在 finalLower（绿线在价格下方），空头段画在 finalUpper（红线在价格上方）；
 *   - **Entry 信号**：方向翻转的那根 K 线标记买卖箭头 —— 转多=绿上三角（bar 下方），转空=红下三角（bar 上方）。
 *
 * 这是 TradingView 用户最熟悉的「带入场箭头的超级趋势」：线告诉你持哪边，箭头告诉你何时换边。
 *
 * 通过 registerIndicator 注册为 'SUPERTREND'，走与 TRENDSTRUCT / PINBAR 完全相同的通用装载逻辑
 * （IndicatorBar 自动出现芯片、点击即在蜡烛主图上加载）。
 *
 * calcParams = [atrPeriod, factor]
 *   - atrPeriod（默认 10）：ATR 周期，越大越平滑、信号越少；
 *   - factor（默认 3.0）：通道宽度乘数，越大过滤假信号但越滞后。
 */

import { registerFigure, registerIndicator } from 'klinecharts';

/**
 * 自定义图形：SuperTrend 入场箭头。
 * 复用 TRENDSTRUCT/PINBAR 里「klinecharts 内置 figure 没有三角箭头」的解决思路，
 * 用 registerFigure 注册一个轻量三角形：
 *   - 看多入场 → 向上三角（绿），画在 K 线**下方**，指向蜡烛暗示反转向上；
 *   - 看空入场 → 向下三角（红），画在 K 线**上方**，指向蜡烛暗示反转向下。
 * 颜色由 attrs.color 传入（不写死），位置由 indicator 的 attrs 回调给出
 * （已换算成像素坐标 + 固定 8px 偏移，缩放下都在蜡烛外侧、不盖实体）。
 */
registerFigure({
  name: 'stEntryArrow',
  draw: (ctx, attrs) => {
    const a = attrs as { x?: number; y?: number; dir?: 'up' | 'down'; color?: string };
    const { x, y, dir, color } = a;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    const s = 5;
    ctx.save();
    ctx.fillStyle = color || '#FCD535';
    ctx.beginPath();
    if (dir === 'up') {
      ctx.moveTo(x, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.lineTo(x + s, y + s);
    } else {
      ctx.moveTo(x, y + s);
      ctx.lineTo(x - s, y - s);
      ctx.lineTo(x + s, y - s);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },
  checkEventOn: () => false,
});

registerIndicator({
  name: 'SUPERTREND',
  shortName: 'SuperTrend',
  series: 'price',
  calcParams: [10, 3],
  precision: 2,
  shouldOhlc: true,
  figures: [
    { key: 'stUp', title: 'SuperTrend 多: ', type: 'line' },
    { key: 'stDown', title: 'SuperTrend 空: ', type: 'line' },
    {
      key: 'buy',
      title: '买入: ',
      type: 'stEntryArrow',
      attrs: (params) => {
        const c = (params as { coordinate: { current: Record<string, number> } }).coordinate.current;
        const v = c && c.buy;
        if (typeof v !== 'number') return null;
        return { x: c.x, y: v - 8, dir: 'up', color: '#0ECB81' };
      },
    },
    {
      key: 'sell',
      title: '卖出: ',
      type: 'stEntryArrow',
      attrs: (params) => {
        const c = (params as { coordinate: { current: Record<string, number> } }).coordinate.current;
        const v = c && c.sell;
        if (typeof v !== 'number') return null;
        return { x: c.x, y: v + 8, dir: 'down', color: '#F6465D' };
      },
    },
  ],
  calc: (dataList, indicator) => {
    const params = (indicator.calcParams as number[]) || [];
    const atrPeriod = Math.max(1, Math.round(Number(params?.[0] ?? 10)));
    const factor = Math.max(0.01, Number(params?.[1] ?? 3));

    const n = dataList.length;

    // 真实波幅 TR 与 Wilder 平滑的 ATR（前 atrPeriod-1 根为 NaN）
    const tr = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const k = dataList[i] as { open: number; high: number; low: number; close: number };
      const prevClose = i > 0 ? dataList[i - 1].close : k.open;
      tr[i] = Math.max(
        k.high - k.low,
        Math.abs(k.high - prevClose),
        Math.abs(k.low - prevClose),
      );
    }
    const atr = new Array<number>(n).fill(NaN);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (i < atrPeriod) {
        sum += tr[i];
        if (i === atrPeriod - 1) atr[i] = sum / atrPeriod;
      } else if (Number.isFinite(atr[i - 1])) {
        atr[i] = (atr[i - 1] * (atrPeriod - 1) + tr[i]) / atrPeriod;
      }
    }

    // 基础通道（hl2 ± factor × ATR）
    const upperBand = new Array<number>(n).fill(NaN); // 上轨（空头段用）
    const lowerBand = new Array<number>(n).fill(NaN); // 下轨（多头段用）
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(atr[i])) continue;
      const hl2 = (dataList[i].high + dataList[i].low) / 2;
      upperBand[i] = hl2 + factor * atr[i];
      lowerBand[i] = hl2 - factor * atr[i];
    }

    const stUp = new Array<number | undefined>(n).fill(undefined);
    const stDown = new Array<number | undefined>(n).fill(undefined);
    const buy = new Array<number | undefined>(n).fill(undefined);
    const sell = new Array<number | undefined>(n).fill(undefined);

    let prevFinalUpper = NaN;
    let prevFinalLower = NaN;
    let prevTrend = 0; // 1=多 / -1=空 / 0=未就绪
    let prevClose = NaN;

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(atr[i])) {
        prevClose = dataList[i].close;
        continue;
      }
      const close = dataList[i].close;

      // finalUpper：仅在上一收盘位于上轨之上时才允许「抬升」，否则下修 —— 通道不回穿价格
      let fu = upperBand[i];
      if (Number.isFinite(prevFinalUpper) && prevClose > prevFinalUpper) {
        fu = Math.max(upperBand[i], prevFinalUpper);
      }
      let fl = lowerBand[i];
      if (Number.isFinite(prevFinalLower) && prevClose < prevFinalLower) {
        fl = Math.min(lowerBand[i], prevFinalLower);
      }

      // 方向判定（经典口径）：收盘上穿下轨→多，下穿上轨→空，否则延续
      let trend: number;
      if (prevTrend === 0) trend = 1;
      else if (close > prevFinalUpper) trend = 1;
      else if (close < prevFinalLower) trend = -1;
      else trend = prevTrend;

      const stVal = trend === -1 ? fu : fl;
      if (trend === 1) stUp[i] = stVal;
      else stDown[i] = stVal;

      // Entry：方向翻转 → 入场箭头（转多=绿上三角在低点下，转空=红下三角在高点上）
      if (prevTrend !== 0 && trend !== prevTrend) {
        if (trend === 1) buy[i] = dataList[i].low;
        else sell[i] = dataList[i].high;
      }

      prevFinalUpper = fu;
      prevFinalLower = fl;
      prevTrend = trend;
      prevClose = close;
    }

    return dataList.map((_, i) => ({
      stUp: stUp[i],
      stDown: stDown[i],
      buy: buy[i],
      sell: sell[i],
    }));
  },
  createTooltipDataSource: (params) => {
    const { indicator, crosshair } = params as {
      indicator: { result: Array<Record<string, number | null | undefined>> };
      crosshair: { dataIndex?: number };
    };
    const idx = crosshair?.dataIndex;
    const result = indicator?.result;
    const fmt = (v: number | null | undefined) =>
      v == null || !Number.isFinite(v as number)
        ? '—'
        : (v as number).toLocaleString('en-US', { maximumFractionDigits: 1 });
    if (idx == null || !result || !result[idx]) {
      return { name: 'SuperTrend', calcParamsText: '', features: [], legends: [] };
    }
    const cur = result[idx];
    const isUp = cur.stUp != null;
    const dirText = isUp ? '多头趋势 (持多)' : cur.stDown != null ? '空头趋势 (持空)' : '预热中';
    const stVal = isUp ? cur.stUp : cur.stDown;
    const legends: Array<{ title: string; value: string }> = [
      { title: '趋势', value: dirText },
      { title: 'SuperTrend', value: fmt(stVal) },
    ];
    if (cur.buy != null) legends.push({ title: '信号', value: '▲ 买入 (转多)' });
    else if (cur.sell != null) legends.push({ title: '信号', value: '▼ 卖出 (转空)' });
    return {
      name: 'SuperTrend',
      calcParamsText: '',
      features: [],
      legends,
    };
  },
  styles: {
    lines: [
      { color: '#0ECB81', size: 2 }, // stUp（绿）
      { color: '#F6465D', size: 2 }, // stDown（红）
    ],
  },
});
