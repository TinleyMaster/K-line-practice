import { useEffect, useState } from 'react';
import { api } from '../api';
import type { StatsResponse } from '../types';

const MARKET_LABEL: Record<string, string> = {
  perp: '合约',
  spot: '现货',
  stock: '链上美股',
};

export function StatsView({ refreshKey }: { refreshKey: number }) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .stats()
      .then((s) => {
        if (alive) {
          setStats(s);
          setError(null);
        }
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (loading && !stats) return <div className="view-loading">统计加载中…</div>;
  if (error) return <div className="notice error">{error}</div>;
  if (!stats) return null;

  const o = stats.overall;
  const maxBucket = Math.max(1, ...stats.rDistribution.map((d) => d.n));

  return (
    <div className="stats-view">
      <div className="card-row">
        <div className="stat-card">
          <span className="muted">已平仓交易</span>
          <strong>{o.closed}</strong>
        </div>
        <div className="stat-card">
          <span className="muted">胜率</span>
          <strong>{(o.winRate * 100).toFixed(1)}%</strong>
        </div>
        <div className="stat-card">
          <span className="muted">单笔期望</span>
          <strong className={o.expectancy >= 0 ? 'up' : 'down'}>{o.expectancy.toFixed(3)}R</strong>
        </div>
        <div className="stat-card">
          <span className="muted">累计 R</span>
          <strong className={o.totalR >= 0 ? 'up' : 'down'}>{o.totalR.toFixed(2)}R</strong>
        </div>
        <div className="stat-card">
          <span className="muted">最大回撤</span>
          <strong className="down">{(o.maxDrawdown * 100).toFixed(1)}%</strong>
        </div>
        <div className="stat-card">
          <span className="muted">守规则率</span>
          <strong>
            {stats.discipline.adherenceRate === null
              ? '—'
              : `${(stats.discipline.adherenceRate * 100).toFixed(0)}%`}
          </strong>
        </div>
      </div>

      <div className="stats-grid">
        <section className="panel">
          <div className="panel-head">
            <h3>按设置分组</h3>
            <span className="muted">期望为负的设置要么改规则，要么少做</span>
          </div>
          {stats.bySetup.length === 0 ? (
            <div className="empty">还没有已平仓交易</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>设置</th>
                    <th>笔数</th>
                    <th>胜率</th>
                    <th>累计R</th>
                    <th>平均R</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.bySetup.map((s) => (
                    <tr key={s.setup} className={s.avgR < 0 ? 'row-bad' : ''}>
                      <td>{s.setup}</td>
                      <td>{s.trades}</td>
                      <td>{(s.winRate * 100).toFixed(0)}%</td>
                      <td className={s.totalR >= 0 ? 'up' : 'down'}>{s.totalR.toFixed(2)}R</td>
                      <td className={s.avgR >= 0 ? 'up' : 'down'}>{s.avgR.toFixed(2)}R</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>R 分布</h3>
            <span className="muted">左尾决定你能不能活下来</span>
          </div>
          {stats.rDistribution.length === 0 ? (
            <div className="empty">暂无数据</div>
          ) : (
            <div className="r-bars">
              {stats.rDistribution.map((d) => (
                <div key={d.bucket} className="r-bar-row">
                  <span className="r-bar-label">{d.bucket}</span>
                  <div className="r-bar-track">
                    <div
                      className={`r-bar-fill ${d.bucket.startsWith('-') ? 'neg' : 'pos'}`}
                      style={{ width: `${(d.n / maxBucket) * 100}%` }}
                    />
                  </div>
                  <span className="r-bar-n">{d.n}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>按标的</h3>
          </div>
          {stats.bySymbol.length === 0 ? (
            <div className="empty">暂无数据</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>标的</th>
                    <th>市场</th>
                    <th>笔数</th>
                    <th>胜率</th>
                    <th>累计R</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.bySymbol.map((s) => (
                    <tr key={`${s.market ?? 'perp'}:${s.symbol}`}>
                      <td>{s.symbol}</td>
                      <td className="muted">{MARKET_LABEL[s.market ?? 'perp'] ?? s.market}</td>
                      <td>{s.trades}</td>
                      <td>{(s.winRate * 100).toFixed(0)}%</td>
                      <td className={s.totalR >= 0 ? 'up' : 'down'}>{s.totalR.toFixed(2)}R</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>离场原因</h3>
          </div>
          {stats.byExitReason.length === 0 ? (
            <div className="empty">暂无数据</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>原因</th>
                    <th>笔数</th>
                    <th>平均R</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byExitReason.map((s) => (
                    <tr key={s.exitReason}>
                      <td>{s.exitReason}</td>
                      <td>{s.trades}</td>
                      <td className={s.avgR >= 0 ? 'up' : 'down'}>{s.avgR.toFixed(2)}R</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
