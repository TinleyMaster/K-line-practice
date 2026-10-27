import { useEffect } from 'react';

interface Props {
  playing: boolean;
  speed: number;
  cursor: number;
  total: number;
  /** 是否处于「回看模式」（游标落后于已回放到的最远处） */
  lookback: boolean;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onJump4h: () => void;
  onBack4h: () => void;
  onSpeed: (ms: number) => void;
  onReset: () => void;
}

const SPEEDS = [
  { label: '0.5s', ms: 500 },
  { label: '1s', ms: 1000 },
  { label: '2s', ms: 2000 },
  { label: '4s', ms: 4000 },
];

export function ReplayControls({
  playing,
  speed,
  cursor,
  total,
  lookback,
  onPlay,
  onPause,
  onNext,
  onPrev,
  onJump4h,
  onBack4h,
  onSpeed,
  onReset,
}: Props) {
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => onNext(), speed);
    return () => clearInterval(timer);
  }, [playing, speed, onNext]);

  const atEnd = cursor >= total - 1;
  const atStart = cursor <= 0;

  return (
    <div className="replay-controls">
      <div className="replay-btns">
        <button className="btn" onClick={onBack4h} disabled={atStart} title="后退一根 4h（4 根 1h）">
          ⏪ 退4h
        </button>
        <button className="btn" onClick={onPrev} disabled={atStart} title="后退一根 1h">
          ◀ 后退
        </button>
        <button className="btn primary" onClick={playing ? onPause : onPlay} disabled={atEnd}>
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button className="btn" onClick={onNext} disabled={atEnd} title="前进一根 1h">
          单步 ▶
        </button>
        <button className="btn" onClick={onJump4h} disabled={atEnd} title="前进一根 4h">
          4h ⏩
        </button>
      </div>

      <div className="speed-group">
        {SPEEDS.map((s) => (
          <button
            key={s.ms}
            className={`btn tiny ${speed === s.ms ? 'active' : ''}`}
            onClick={() => onSpeed(s.ms)}
          >
            {s.label}
          </button>
        ))}
        <button className="btn tiny ghost" onClick={onReset}>
          ↺ 重置
        </button>
      </div>

      <div className="replay-progress">
        <div
          className="replay-progress-bar"
          style={{ width: `${total > 0 ? ((cursor + 1) / total) * 100 : 0}%` }}
        />
      </div>
      <div className="replay-count">
        {lookback && <span className="lookback-badge">回看</span>}
        {cursor + 1} / {total}
      </div>
    </div>
  );
}
