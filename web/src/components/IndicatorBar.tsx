import { useMemo } from 'react';
import {
  ALL_INDICATORS,
  MAX_RESIDENT_PANES,
  getIndicatorSpec,
} from '../engine/indicators';
import type { ChartPeriod } from '../types';

interface Props {
  /** 4h 周期当前选中的指标名 */
  value4h: string[];
  /** 1h 周期当前选中的指标名（15m 复用这一套） */
  value1h: string[];
  onChange: (period: '4h' | '1h', names: string[]) => void;
  /** 图表当前周期 —— 工具栏编辑的就是当前周期那一档 */
  currentPeriod: ChartPeriod;
}

/** 15m 复用 1h 的指标配置 */
function tabOf(period: ChartPeriod): '4h' | '1h' {
  return period === '4h' ? '4h' : '1h';
}

/**
 * 币安风格技术指标工具栏：横排在图表下方，点击指标即直接在 K 线上加载 / 卸载。
 *
 * - 主图叠加（MA / BOLL / Pinbar …）点一下画在蜡烛上；
 * - 独立副图（VOL / MACD / RSI …）点一下自动开新窗格；
 * - 高亮 = 当前周期已启用；副图达上限后其余副图置灰，需先取消一个；
 * - 右侧「清空 / 默认」一键重置当前周期。
 * 编辑的是「当前图表周期」对应的那一档（4h / 1h），与周期 Tab 联动。
 */
export function IndicatorBar({ value4h, value1h, onChange, currentPeriod }: Props) {
  const period = tabOf(currentPeriod);
  const current = period === '4h' ? value4h : value1h;

  const activePaneCount = useMemo(
    () => current.filter((n) => getIndicatorSpec(n)?.group === 'pane').length,
    [current],
  );

  const toggle = (name: string) => {
    const spec = getIndicatorSpec(name);
    if (!spec) return;
    const next = current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name];
    onChange(period, next);
  };

  // 主图叠加在前、独立副图在后；两组之间插一条分隔，帮助区分
  const firstPaneIdx = ALL_INDICATORS.findIndex((s) => s.group === 'pane');

  return (
    <div className="ind-bar" role="toolbar" aria-label="技术指标">
      <span className="ind-bar-period" title="当前编辑的指标档位（跟随图表周期）">
        {period}
      </span>
      <div className="ind-bar-scroll">
        {ALL_INDICATORS.map((spec, i) => {
          const checked = current.includes(spec.name);
          const paneFull =
            spec.group === 'pane' && !checked && activePaneCount >= MAX_RESIDENT_PANES;
          return (
            <span className="ind-bar-item" key={spec.name}>
              {i === firstPaneIdx && <span className="ind-bar-sep" aria-hidden />}
              <button
                type="button"
                className={`ind-chip ${spec.group === 'pane' ? 'pane' : 'overlay'} ${
                  checked ? 'on' : ''
                } ${paneFull ? 'limited' : ''}`}
                title={
                  paneFull
                    ? `副图最多常驻 ${MAX_RESIDENT_PANES} 个，请先取消一个`
                    : spec.label
                }
                disabled={paneFull}
                aria-pressed={checked}
                onClick={() => toggle(spec.name)}
              >
                {spec.label}
              </button>
            </span>
          );
        })}
      </div>
      <div className="ind-bar-actions">
        <button
          type="button"
          className="btn tiny ghost"
          onClick={() => onChange(period, [])}
          disabled={current.length === 0}
        >
          清空
        </button>
        <button
          type="button"
          className="btn tiny ghost"
          onClick={() => onChange(period, ['MA', 'VOL'])}
        >
          默认
        </button>
      </div>
    </div>
  );
}
