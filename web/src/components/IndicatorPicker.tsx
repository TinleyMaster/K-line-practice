import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ALL_INDICATORS,
  MAX_RESIDENT_PANES,
  getIndicatorSpec,
  type IndicatorSpec,
} from '../engine/indicators';
import { markPopupOpen } from '../engine/popup';
import { usePopupPosition } from '../hooks/usePopupPosition';

interface Props {
  /** 4h 周期当前选中的指标名 */
  value4h: string[];
  /** 1h 周期当前选中的指标名 */
  value1h: string[];
  onChange: (period: '4h' | '1h', names: string[]) => void;
  /** 受控的展开状态 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const OVERLAY_SPECS = ALL_INDICATORS.filter((i) => i.group === 'overlay');
const PANE_SPECS = ALL_INDICATORS.filter((i) => i.group === 'pane');

export function IndicatorPicker({ value4h, value1h, onChange, open, onOpenChange }: Props) {
  const [period, setPeriod] = useState<'4h' | '1h'>('4h');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 弹窗打开时标记 body，让吸底回放条降级，避免盖住弹窗底部
  useEffect(() => {
    markPopupOpen('indicator', open);
    return () => markPopupOpen('indicator', false);
  }, [open]);

  // 弹窗永远落在视口内（桌面/横屏下 absolute 会掉出屏幕）
  usePopupPosition(open, panelRef, triggerRef);

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

  const renderItem = (spec: IndicatorSpec) => {
    const checked = current.includes(spec.name);
    const paneFull = spec.group === 'pane' && !checked && activePaneCount >= MAX_RESIDENT_PANES;
    return (
      <label
        key={spec.name}
        className={`ind-item ${checked ? 'on' : ''} ${paneFull ? 'limited' : ''}`}
        title={paneFull ? `最多同时常驻 ${MAX_RESIDENT_PANES} 个副图，请先取消一个` : spec.label}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={paneFull}
          onChange={() => toggle(spec.name)}
        />
        <span className="ind-name">{spec.label}</span>
        <span className="ind-code">{spec.name}</span>
      </label>
    );
  };

  return (
    <div className="ind-picker">
      <button
        ref={triggerRef}
        className={`ind-trigger ${open ? 'active' : ''}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <span>📊 技术指标</span>
        <span className="ind-trigger-count">{current.length} 个</span>
      </button>

      {open && (
        <div className="ind-panel" ref={panelRef}>
          <div className="ind-period">
            <button
              className={`ind-period-tab ${period === '4h' ? 'active' : ''}`}
              onClick={() => setPeriod('4h')}
            >
              4h 趋势
            </button>
            <button
              className={`ind-period-tab ${period === '1h' ? 'active' : ''}`}
              onClick={() => setPeriod('1h')}
            >
              1h 入场
            </button>
          </div>

          <div className="ind-group">
            <div className="ind-group-title">
              主图叠加 <span className="muted">画在 K 线上，不占额外高度</span>
            </div>
            <div className="ind-list">{OVERLAY_SPECS.map(renderItem)}</div>
          </div>

          <div className="ind-group">
            <div className="ind-group-title">
              独立副图{' '}
              <span className="muted">
                最多常驻 {MAX_RESIDENT_PANES} 个（当前 {activePaneCount}）
              </span>
            </div>
            <div className="ind-list">{PANE_SPECS.map(renderItem)}</div>
          </div>

          <div className="ind-foot">
            <button
              className="btn tiny"
              onClick={() => onChange(period, [])}
              disabled={current.length === 0}
            >
              清空
            </button>
            <button
              className="btn tiny"
              onClick={() =>
                onChange(
                  period,
                  period === '4h' ? ['MA', 'VOL'] : ['MA', 'VOL'],
                )
              }
            >
              恢复默认（MA+VOL）
            </button>
            <button className="btn tiny" onClick={() => onOpenChange(false)}>
              完成
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
