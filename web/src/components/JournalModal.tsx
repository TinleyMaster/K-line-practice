import { useEffect, useState } from 'react';
import type { ClosedTrade } from '../types';
import { fmtPrice, fmtTime } from '../engine/bars';

interface Props {
  trade: ClosedTrade;
  onSave: (payload: {
    followedPlan: boolean;
    emotion: string | null;
    mistakeTag: string | null;
    content: string;
  }) => void;
  /** 跳过（关掉弹窗不写内容）—— 记为待补，不阻塞继续练习 */
  onSkip?: () => void;
}

const EMOTIONS = ['平静', '犹豫', 'FOMO', '贪婪', '恐慌', '懊恼', '报复性'];
const MISTAKES = [
  '没等确认就进',
  '逆着 4h 方向',
  '止损太近',
  '止损太远',
  '仓位过大',
  '没有计划',
  '追高',
  '过早止盈',
];

/**
 * 强制复盘弹窗。
 *
 * v5 的问题：这个弹窗**无法关闭** —— 用户被卡死，只能写完复盘才能继续。
 * v6 补了三条退出路径：
 *   1. 右上角 ✕ → 跳过（记为「待补复盘」，不阻塞继续练习）
 *   2. ESC 键 → 同上
 *   3. 点遮罩空白 → 同上
 *
 * 设计取舍：跳过**不是**无视 —— 它会留一条 skipped 记录，
 * 纪律统计里算「没复盘」，顶栏显示待补数量，事后可补写。
 * 完全不让逃会逼用户乱写（写了也不认真）；完全放任不管则纪律指标失真。
 */
export function JournalModal({ trade, onSave, onSkip }: Props) {
  const [followedPlan, setFollowedPlan] = useState<boolean | null>(null);
  const [emotions, setEmotions] = useState<string[]>([]);
  const [mistakes, setMistakes] = useState<string[]>([]);
  const [content, setContent] = useState('');

  const toggle = (arr: string[], set: (v: string[]) => void, v: string) => {
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  };

  const canSave = followedPlan !== null && content.trim().length >= 5;

  // ESC 跳过
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onSkip?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip]);

  const exitText = {
    stop: '止损离场',
    target: '到达目标',
    manual: '手动平仓',
    session_end: '练习结束',
  }[trade.exitReason];

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        // 点遮罩空白处 = 跳过
        if (e.target === e.currentTarget) onSkip?.();
      }}
    >
      <div className="modal">
        <div className="modal-head">
          <h3>强制复盘</h3>
          <div className="modal-head-right">
            <span className="muted">不写复盘就不许开下一单</span>
            <button
              className="btn tiny ghost modal-close"
              onClick={onSkip}
              title="跳过（记为待补复盘，不阻塞继续）"
              aria-label="跳过复盘"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="trade-summary">
          <div>
            <span className="muted">标的/方向</span>
            <strong>
              {trade.symbol} · {trade.side === 'long' ? '多' : '空'}
            </strong>
          </div>
          <div>
            <span className="muted">入场 → 出场</span>
            <strong>
              {fmtPrice(trade.entryPrice)} → {fmtPrice(trade.exitPrice)}
            </strong>
          </div>
          <div>
            <span className="muted">离场原因</span>
            <strong>{exitText}</strong>
          </div>
          <div>
            <span className="muted">结果</span>
            <strong className={trade.rMultiple >= 0 ? 'up' : 'down'}>
              {trade.rMultiple >= 0 ? '+' : ''}
              {trade.rMultiple.toFixed(2)}R · ${trade.pnl.toFixed(2)}
            </strong>
          </div>
          <div>
            <span className="muted">持仓时长</span>
            <strong>
              {((trade.exitTime - trade.entryTime) / 3600000).toFixed(1)} 小时
            </strong>
          </div>
          <div>
            <span className="muted">时间</span>
            <strong>{fmtTime(trade.entryTime)}</strong>
          </div>
        </div>

        {trade.setup && (
          <div className="journal-setup">
            <span className="muted">使用的设置：</span>
            <strong>{trade.setup}</strong>
          </div>
        )}

        {trade.notes && (
          <div className="journal-setup">
            <span className="muted">开仓备注：</span>
            <span>{trade.notes}</span>
          </div>
        )}

        <div className="field">
          <span>是否完全按计划执行？</span>
          <div className="btn-row">
            <button
              className={`btn ${followedPlan === true ? 'active success' : ''}`}
              onClick={() => setFollowedPlan(true)}
            >
              是，完整执行
            </button>
            <button
              className={`btn ${followedPlan === false ? 'active danger' : ''}`}
              onClick={() => setFollowedPlan(false)}
            >
              否，有违规则
            </button>
          </div>
        </div>

        <div className="field">
          <span>当时的情绪（可多选）</span>
          <div className="chip-row">
            {EMOTIONS.map((e) => (
              <button
                key={e}
                className={`chip ${emotions.includes(e) ? 'active' : ''}`}
                onClick={() => toggle(emotions, setEmotions, e)}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>犯的错误（可多选）</span>
          <div className="chip-row">
            {MISTAKES.map((m) => (
              <button
                key={m}
                className={`chip ${mistakes.includes(m) ? 'active wrong' : ''}`}
                onClick={() => toggle(mistakes, setMistakes, m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>
            复盘：如果重来一次你会怎么做？（{content.trim().length}/200）
          </span>
          <textarea
            className="input textarea"
            maxLength={200}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="例：4h 已经是下降趋势，我不该因为看到 1h 一根阳线就追多；等回调到均线再进，或者直接不做。"
          />
        </div>

        <button
          className="btn primary wide"
          disabled={!canSave}
          onClick={() =>
            onSave({
              followedPlan: followedPlan as boolean,
              emotion: emotions.join(',') || null,
              mistakeTag: mistakes.join(',') || null,
              content: content.trim(),
            })
          }
        >
          保存复盘
        </button>

        {onSkip && (
          <button className="btn ghost wide modal-skip" onClick={onSkip}>
            跳过（记为待补，不阻塞继续）
          </button>
        )}
      </div>
    </div>
  );
}
