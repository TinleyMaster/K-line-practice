import { useState } from 'react';
import { usePracticeStore } from '../store/usePracticeStore';
import type { JournalEntry } from '../types';
import { fmtTime } from '../engine/bars';

/**
 * 待补复盘列表（v6）。
 *
 * 强制复盘弹窗被跳过时，这里会出现一条待补记录 ——
 * 纪律指标照样能反映出「这笔没复盘」，但不会把人卡死。
 */
export function PendingJournal() {
  const skipped = usePracticeStore((s) => s.skippedJournal);
  const fill = usePracticeStore((s) => s.fillSkippedJournal);
  const [editing, setEditing] = useState<JournalEntry | null>(null);
  const [followedPlan, setFollowedPlan] = useState<boolean | null>(null);
  const [content, setContent] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  if (skipped.length === 0) return null;

  const startEdit = (e: JournalEntry) => {
    setEditing(e);
    setFollowedPlan(null);
    setContent('');
    setMsg(null);
  };

  const submit = async () => {
    if (!editing || followedPlan === null || content.trim().length < 5) return;
    try {
      await fill(editing.id, {
        followedPlan,
        emotion: null,
        mistakeTag: null,
        content: content.trim(),
      });
      setEditing(null);
    } catch (err) {
      setMsg((err as Error).message);
    }
  };

  return (
    <div className="panel pending-journal">
      <div className="panel-head">
        <h3>待补复盘</h3>
        <span className="muted">{skipped.length} 笔未写</span>
      </div>

      {skipped.map((e) => (
        <div key={e.id} className="pending-row">
          <div className="pending-info">
            <strong>{e.symbol ?? '—'}</strong>
            <span className="muted">
              {fmtTime(e.createdAt)} · {e.setup ?? '未标注设置'}
            </span>
            {typeof e.snapshot?.r === 'number' && (
              <span className={e.snapshot.r >= 0 ? 'up' : 'down'}>
                {e.snapshot.r >= 0 ? '+' : ''}
                {(e.snapshot.r as number).toFixed(2)}R
              </span>
            )}          </div>
          <button className="btn tiny" onClick={() => startEdit(e)}>
            补写
          </button>
        </div>
      ))}

      {editing && (
        <div className="pending-editor">
          <div className="field">
            <span>是否完全按计划执行？</span>
            <div className="btn-row">
              <button
                className={`btn ${followedPlan === true ? 'active success' : ''}`}
                onClick={() => setFollowedPlan(true)}
              >
                是
              </button>
              <button
                className={`btn ${followedPlan === false ? 'active danger' : ''}`}
                onClick={() => setFollowedPlan(false)}
              >
                否
              </button>
            </div>
          </div>
          <div className="field">
            <span>复盘内容（{content.trim().length}/200）</span>
            <textarea
              className="input textarea"
              maxLength={200}
              value={content}
              onChange={(ev) => setContent(ev.target.value)}
              placeholder="如果重来一次你会怎么做？"
            />
          </div>
          {msg && <div className="notice error">{msg}</div>}
          <div className="btn-row">
            <button
              className="btn primary"
              disabled={followedPlan === null || content.trim().length < 5}
              onClick={submit}
            >
              保存
            </button>
            <button className="btn ghost" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
