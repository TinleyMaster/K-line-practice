import { useEffect } from 'react';

interface Props {
  playing: boolean;
  speed: number;
  cursor: number;
  total: number;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onJump4h: () => void;
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
  onPlay,
  onPause,
  onNext,
  onJump4h,
  onSpeed,
  onReset,
}: Props) {
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => onNext(), speed);
    return () => clearInterval(timer);
  }, [playing, speed, onNext]);

  const atEnd = cursor >= total - 1;

  return (
    <div className="replay-controls">
      <button className="btn primary" onClick={playing ? onPause : onPlay} disabled={atEnd}>
        {playing ? '⏸ 暂停' : '▶ 播放'}
      </button>
      <button className="btn" onClick={onNext} disabled={atEnd}>
        ⏭ 单步
      </button>
      <button className="btn" onClick={onJump4h} disabled={atEnd}>
        ⏩ 下一根4h
      </button>
      <button className="btn ghost" onClick={onReset}>
        ↺ 重置
      </button>

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

      <div className="replay-progress">
        <div
          className="replay-progress-bar"
          style={{ width: `${total > 0 ? ((cursor + 1) / total) * 100 : 0}%` }}
        />
      </div>
      <div className="replay-count">
        {cursor + 1} / {total}
      </div>
    </div>
  );
}
