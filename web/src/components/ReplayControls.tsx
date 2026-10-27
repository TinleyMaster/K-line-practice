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
        <button className="btn btn-step" onClick={onBack4h} disabled={atStart} title="后退一根 4h（4 根 1h）">
          <span className="lbl-full">⏪ 退4h</span>
          <span className="lbl-mini">⏪</span>
        </button>
        <button className="btn btn-step" onClick={onPrev} disabled={atStart} title="后退一根 1h">
          <span className="lbl-full">◀ 后退</span>
          <span className="lbl-mini">◀</span>
        </button>
        <button className="btn primary btn-play" onClick={playing ? onPause : onPlay} disabled={atEnd}>
          <span className="lbl-full">{playing ? '⏸ 暂停' : '▶ 播放'}</span>
          <span className="lbl-mini">{playing ? '⏸' : '▶'}</span>
        </button>
        <button className="btn btn-step" onClick={onNext} disabled={atEnd} title="前进一根 1h">
          <span className="lbl-full">单步 ▶</span>
          <span className="lbl-mini">▶</span>
        </button>
        <button className="btn btn-step" onClick={onJump4h} disabled={atEnd} title="前进一根 4h">
          <span className="lbl-full">4h ⏩</span>
          <span className="lbl-mini">⏩</span>
        </button>
      </div>

      {/* 速度是「播放」的附属配置 —— 暂停时藏起来，点播放才展开 */}
      {playing && (
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
        </div>
      )}

      <button className="btn tiny ghost replay-reset" onClick={onReset}>
        ↺ 重置
      </button>

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
