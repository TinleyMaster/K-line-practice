import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bar } from '../types';
import { fmtTime } from '../engine/bars';
import { markPopupOpen } from '../engine/popup';
import { usePopupPosition } from '../hooks/usePopupPosition';
import { resolveStartRange } from '../store/usePracticeStore';

interface Props {
  bars1h: Bar[];
  /** 当前起点索引 */
  cursor: number;
  /** 是否为用户手动指定 */
  isManual: boolean;
  onSet: (time: number | null) => void;
  /** 受控的展开状态 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const HOUR = 3600_000;

/** 快捷区间：往前推多久开始练 */
const QUICK_RANGES = [
  { label: '1天', ms: 24 * HOUR },
  { label: '1周', ms: 7 * 24 * HOUR },
  { label: '1月', ms: 30 * 24 * HOUR },
  { label: '3月', ms: 90 * 24 * HOUR },
];

/** <input type="datetime-local"> 要的是本地时间字符串 */
function toLocalInput(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function StartTimePicker({ bars1h, cursor, isManual, onSet, open, onOpenChange }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 弹窗打开时标记 body，让吸底回放条降级，避免盖住弹窗底部
  useEffect(() => {
    markPopupOpen('start', open);
    return () => markPopupOpen('start', false);
  }, [open]);

  // 弹窗永远落在视口内（桌面/横屏下 absolute 会掉出屏幕）
  usePopupPosition(open, panelRef, triggerRef);

  const currentBar = cursor >= 0 ? bars1h[cursor] : null;
  const lastBar = bars1h.length ? bars1h[bars1h.length - 1] : null;
  const firstBar = bars1h.length ? bars1h[0] : null;

  /**
   * 起点的**实际可调范围**（不是数据范围）。
   *
   * ⚠️ v6.3 修：之前 input 的 min/max 用的是数据边界，
   *   但 `resolveStartIndex` 会把起点夹在 [第480根, 第1140根]
   *   （前留 120 根 4h 趋势上下文、后留 60 根 1h 未来）——
   *   用户选到范围外的时间 ⇒ 起点不动 ⇒ 「起点调节失效」。
   *   现在 min/max 直接用真实边界，选不超出就一定生效。
   */
  const range = useMemo(() => resolveStartRange(bars1h), [bars1h]);

  // 快捷区间基于「数据末端」倒推，但要裁进可调范围 —— 否则点了也不动
  const quickOptions = useMemo(() => {
    if (!lastBar) return [];
    return QUICK_RANGES.map((r) => {
      const raw = lastBar.time - r.ms;
      const time = Math.max(range.minTime, Math.min(range.maxTime, raw));
      return { ...r, time, clipped: time !== raw };
    });
  }, [lastBar, range]);

  const [localValue, setLocalValue] = useState(() =>
    currentBar ? toLocalInput(currentBar.time) : '',
  );

  const applyLocal = (v: string) => {
    setLocalValue(v);
    if (!v) return;
    const t = new Date(v).getTime();
    if (Number.isFinite(t)) onSet(t);
  };

  const pickQuick = (time: number) => {
    setLocalValue(toLocalInput(time));
    onSet(time);
  };

  return (
    <div className="start-picker">
      <button
        ref={triggerRef}
        className={`start-trigger ${open ? 'active' : ''} ${isManual ? 'manual' : ''}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <span>⏱ 起点</span>
        <span className="start-value">
          {currentBar ? fmtTime(currentBar.time) : '—'}
          {isManual && <em className="start-badge">自定义</em>}
        </span>
      </button>

      {open && (
        <div className="start-panel" ref={panelRef}>
          <div className="start-row">
            <span className="muted">指定时间</span>
            <input
              className="input"
              type="datetime-local"
              value={localValue}
              onChange={(e) => applyLocal(e.target.value)}
              min={bars1h.length ? toLocalInput(range.minTime) : undefined}
              max={bars1h.length ? toLocalInput(range.maxTime) : undefined}
            />
          </div>

          <div className="start-row">
            <span className="muted">快捷</span>
            <div className="start-quick">
              {quickOptions.map((q) => (
                <button key={q.label} className="btn tiny" onClick={() => pickQuick(q.time)}>
                  {`往前 ${q.label}`}
                </button>
              ))}
            </div>
          </div>

          <div className="start-row">
            <span className="muted">可调范围</span>
            <span className="start-range">
              {bars1h.length ? fmtTime(range.minTime) : '—'} ~{' '}
              {bars1h.length ? fmtTime(range.maxTime) : '—'}
            </span>
          </div>

          <div className="start-row">
            <span className="muted">数据范围</span>
            <span className="start-range">
              {firstBar ? fmtTime(firstBar.time) : '—'} ~ {lastBar ? fmtTime(lastBar.time) : '—'}
            </span>
          </div>

          <div className="ind-foot">
            <button
              className="btn tiny"
              onClick={() => {
                setLocalValue('');
                onSet(null);
              }}
              disabled={!isManual}
            >
              恢复自动
            </button>
            <button className="btn tiny" onClick={() => onOpenChange(false)}>
              完成
            </button>
          </div>

          <div className="start-hint">
            起点前会自动保留至少 120 根 4h 趋势上下文，起点后至少留 60 根 1h 作为「未来」
            —— 所以「可调范围」比「数据范围」窄，只能在上面的区间里选。
          </div>
        </div>
      )}
    </div>
  );
}
