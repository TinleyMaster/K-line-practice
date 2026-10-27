import { useState } from 'react';
import { usePracticeStore } from '../store/usePracticeStore';

/**
 * 登录 / 注册（v6）。
 *
 * 刻意做得极简：用户名 + 密码，两个按钮。
 * 两个人共用一套练习台 —— 数据隔离在服务端按 token 做，
 * 前端不需要任何「权限」概念。
 *
 * 登录是**可选**的：不登录也能用（数据记在「游客」名下，全局可见）。
 * 登录之后各自的数据就分开存，PK 才有意义。
 */
export function AuthPanel({ onClose }: { onClose?: () => void }) {
  const login = usePracticeStore((s) => s.login);
  const register = usePracticeStore((s) => s.register);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    const res =
      mode === 'login'
        ? await login(username.trim(), password)
        : await register(username.trim(), password, displayName.trim() || undefined);
    setBusy(false);
    if (!res.ok) setMsg(res.msg ?? '操作失败');
    else onClose?.();
  };

  return (
    <div className="auth-panel">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-head">
          <span className="brand-mark">K</span>
          <div className="brand-text">
            <div className="brand-title">K线刻意练习台</div>
            <div className="brand-sub">登录后各自的数据分开存 · 可做胜率 PK</div>
          </div>
          {onClose && (
            <button type="button" className="btn tiny ghost modal-close" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          )}
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={`btn ${mode === 'login' ? 'active' : ''}`}
            onClick={() => {
              setMode('login');
              setMsg(null);
            }}
          >
            登录
          </button>
          <button
            type="button"
            className={`btn ${mode === 'register' ? 'active' : ''}`}
            onClick={() => {
              setMode('register');
              setMsg(null);
            }}
          >
            注册
          </button>
        </div>

        <label className="field">
          <span>用户名</span>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="3~32 位字母/数字"
            autoComplete="username"
            autoFocus
          />
        </label>

        {mode === 'register' && (
          <label className="field">
            <span>昵称（可空）</span>
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="显示在 PK 榜上"
            />
          </label>
        )}

        <label className="field">
          <span>密码</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 4 位"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>

        {msg && <div className="notice error">{msg}</div>}

        <button className="btn primary wide" type="submit" disabled={busy || !username || !password}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>

        <div className="hint">不登录也能练习 —— 只是数据不隔离、无法 PK</div>
      </form>
    </div>
  );
}
