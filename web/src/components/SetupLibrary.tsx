import { useState } from 'react';
import { api } from '../api';
import type { Setup } from '../types';

interface Props {
  setups: Setup[];
  onChanged: () => void;
}

export function SetupLibrary({ setups, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [marketCondition, setMarketCondition] = useState('');
  const [entryRules, setEntryRules] = useState('');
  const [exitRules, setExitRules] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    setMsg(null);
    try {
      await api.createSetup({
        name: name.trim(),
        description: description.trim(),
        marketCondition: marketCondition.trim(),
        entryRules: entryRules
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        exitRules: exitRules
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setName('');
      setDescription('');
      setMarketCondition('');
      setEntryRules('');
      setExitRules('');
      setAdding(false);
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const toggleEnabled = async (s: Setup) => {
    try {
      await api.updateSetup(s.id, { enabled: !s.enabled });
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="setup-library">
      <div className="panel-head">
        <h3>开仓设置库</h3>
        <button className="btn primary" onClick={() => setAdding((v) => !v)}>
          {adding ? '取消' : '+ 新建设置'}
        </button>
      </div>

      {msg && <div className="notice error">{msg}</div>}

      {adding && (
        <div className="panel setup-form">
          <label className="field">
            <span>设置名称</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>一句话描述</span>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="field">
            <span>适用市场环境</span>
            <input
              className="input"
              value={marketCondition}
              onChange={(e) => setMarketCondition(e.target.value)}
              placeholder="例：4h 上升趋势，回调不破前低"
            />
          </label>
          <label className="field">
            <span>入场规则（每行一条，开仓前必须逐条勾选）</span>
            <textarea
              className="input textarea"
              value={entryRules}
              onChange={(e) => setEntryRules(e.target.value)}
            />
          </label>
          <label className="field">
            <span>出场规则（每行一条）</span>
            <textarea
              className="input textarea"
              value={exitRules}
              onChange={(e) => setExitRules(e.target.value)}
            />
          </label>
          <button className="btn primary" onClick={submit} disabled={!name.trim()}>
            保存设置
          </button>
        </div>
      )}

      <div className="setup-grid">
        {setups.map((s) => (
          <div key={s.id} className={`setup-card ${s.enabled ? '' : 'disabled'}`}>
            <div className="setup-card-head">
              <span className="setup-dot" style={{ background: s.color }} />
              <strong>{s.name}</strong>
              <button className="btn tiny ghost" onClick={() => toggleEnabled(s)}>
                {s.enabled ? '停用' : '启用'}
              </button>
            </div>
            {s.marketCondition && <div className="muted small">环境：{s.marketCondition}</div>}
            {s.description && <div className="setup-desc">{s.description}</div>}
            {s.entryRules.length > 0 && (
              <div className="setup-rules">
                <div className="muted small">入场</div>
                <ul>
                  {s.entryRules.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
            {s.exitRules.length > 0 && (
              <div className="setup-rules">
                <div className="muted small">出场</div>
                <ul>
                  {s.exitRules.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
