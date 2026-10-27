import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PkResponse } from '../types';

/**
 * 胜率 PK（v6）。
 *
 * 刻意**不只比胜率** —— 胜率高但赔率差的打法（1:0.5）长期期望为负，
 * 光看胜率会误导人。所以并列展示期望 R / 累计 R / 盈亏比 / 回撤 / 守规则率。
 *
 * 视觉上做成对比条：左边一个数、右边一个数，条的长度按比例，
 * 领先方加高亮边框。
 */
export function PkView({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<PkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .pk()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (loading && !data) return <div className="view-loading">PK 数据加载中…</div>;
  if (error) return <div className="notice error">{error}</div>;
  if (!data) return null;

  if (data.players.length === 0) {
    return (
      <div className="stats-view">
        <div className="notice info">
          还没有账号。两人各自注册登录后，这里会显示胜率对比。
        </div>
      </div>
    );
  }

  const [a, b] = data.players;

  return (
    <div className="stats-view">
      <div className="pk-header">
        {data.players.map((p) => (
          <div key={p.userId} className="pk-name">
            <span className="pk-avatar">{p.displayName.slice(0, 1).toUpperCase()}</span>
            <strong>{p.displayName}</strong>
            <span className="muted">@{p.username}</span>
          </div>
        ))}
      </div>

      {data.players.length < 2 ? (
        <div className="notice info">只有一个账号，再注册一个就能对比了。</div>
      ) : (
        <>
          {data.players.length > 2 && (
            <div className="notice info">
              当前有 {data.players.length} 个账号，对比条只展示前两位（
              {a.displayName} vs {b.displayName}）—— 本项目定位是两人 PK。
            </div>
          )}
          <div className="pk-table">
            {data.comparisons.map((c) => {
              const va = c.values.find((v) => v.userId === a.userId);
              const vb = c.values.find((v) => v.userId === b.userId);
              const na = typeof va?.value === 'number' ? va.value : 0;
              const nb = typeof vb?.value === 'number' ? vb.value : 0;
              const max = Math.max(Math.abs(na), Math.abs(nb), 1e-9);
              const aLead = c.leader === a.userId;
              const bLead = c.leader === b.userId;
              const aPct = (Math.abs(na) / max) * 100;
              const bPct = (Math.abs(nb) / max) * 100;
              return (
                <div key={c.key} className="pk-row">
                  <div className="pk-side left">
                    <span className={`pk-val ${aLead ? 'lead' : ''}`}>{va?.display ?? '—'}</span>
                    <div className="pk-bar-track">
                      <div
                        className={`pk-bar-fill ${aLead ? 'lead' : ''}`}
                        style={{ width: `${aPct}%` }}
                      />
                    </div>
                  </div>
                  <div className="pk-dim">
                    <span className="pk-dim-label">{c.label}</span>
                    {c.leader === null && data.players.length >= 2 && (
                      <span className="pk-tie">平</span>
                    )}
                  </div>
                  <div className="pk-side right">
                    <div className="pk-bar-track">
                      <div
                        className={`pk-bar-fill ${bLead ? 'lead' : ''}`}
                        style={{ width: `${bPct}%` }}
                      />
                    </div>
                    <span className={`pk-val ${bLead ? 'lead' : ''}`}>{vb?.display ?? '—'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="pk-foot">
        <span className="muted">
          数据截至 {new Date(data.generatedAt).toLocaleString('zh-CN')} · 只统计已平仓交易
        </span>
      </div>
    </div>
  );
}
