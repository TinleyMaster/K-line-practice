import { useEffect, useMemo, useState } from 'react';
import type { Setup, TradeSide } from '../types';
import { fmtPrice } from '../engine/bars';

interface Props {
  setups: Setup[];
  entryPrice: number;
  equity: number;
  disabled: boolean;
  disabledReason?: string;
  onOpen: (draft: {
    side: TradeSide;
    stopLoss: number;
    takeProfit: number | null;
    riskPct: number;
    setup: string | null;
    checklist: Record<string, boolean>;
  }) => Promise<{ ok: boolean; msg?: string }>;
  /** 收起面板（回到折叠态） */
  onClose: () => void;
}

export function TradePanel({
  setups,
  entryPrice,
  equity,
  disabled,
  disabledReason,
  onOpen,
  onClose,
}: Props) {
  const enabledSetups = useMemo(() => setups.filter((s) => s.enabled), [setups]);
  const [side, setSide] = useState<TradeSide>('long');
  const [setupName, setSetupName] = useState<string>('');
  const [stopLoss, setStopLoss] = useState<string>('');
  const [takeProfit, setTakeProfit] = useState<string>('');
  const [riskPct, setRiskPct] = useState('1');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const setup = enabledSetups.find((s) => s.name === setupName) ?? null;

  // 切换设置时重置勾选
  useEffect(() => {
    setChecked({});
  }, [setupName]);

  // 换标的/价格变化时，若止损还停留在旧价格附近则自动跟随（首次给一个默认距离）
  useEffect(() => {
    if (!entryPrice) return;
    setStopLoss((prev) => {
      if (prev && Math.abs(Number(prev) - entryPrice) / entryPrice < 0.03) return prev;
      const dist = entryPrice * 0.01;
      return (entryPrice - dist).toFixed(2);
    });
  }, [entryPrice]);

  const stop = Number(stopLoss);
  const tp = takeProfit.trim() ? Number(takeProfit) : null;
  const pct = Number(riskPct);
  const riskAmount = equity * (pct / 100);
  const dist = Number.isFinite(stop) ? Math.abs(entryPrice - stop) : 0;
  const qty = dist > 0 && riskAmount > 0 ? riskAmount / dist : 0;
  const targetR = dist > 0 && tp !== null ? Math.abs(tp - entryPrice) / dist : null;

  const rules = setup?.entryRules ?? [];
  const allChecked = rules.length === 0 || rules.every((_, i) => checked[`r${i}`]);

  const valid =
    !disabled &&
    !!setupName &&
    allChecked &&
    Number.isFinite(stop) &&
    stop > 0 &&
    (side === 'long' ? stop < entryPrice : stop > entryPrice) &&
    (tp === null || (side === 'long' ? tp > entryPrice : tp < entryPrice)) &&
    pct > 0;

  const submit = async () => {
    setMsg(null);
    const res = await onOpen({
      side,
      stopLoss: stop,
      takeProfit: tp,
      riskPct: pct,
      setup: setupName,
      checklist: checked,
    });
    if (!res.ok) setMsg(res.msg ?? '开仓失败');
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>开仓</h3>
        <div className="panel-head-right">
          <span className="muted">现价 {fmtPrice(entryPrice)}</span>
          <button className="btn tiny ghost panel-collapse" onClick={onClose} title="收起开仓面板">
            ✕
          </button>
        </div>
      </div>

      {disabled && disabledReason && <div className="notice warn">{disabledReason}</div>}

      <div className="side-toggle">
        <button
          className={`btn side long ${side === 'long' ? 'active' : ''}`}
          onClick={() => setSide('long')}
        >
          做多
        </button>
        <button
          className={`btn side short ${side === 'short' ? 'active' : ''}`}
          onClick={() => setSide('short')}
        >
          做空
        </button>
      </div>

      <label className="field">
        <span>设置（必选）</span>
        <select className="input select" value={setupName} onChange={(e) => setSetupName(e.target.value)}>
          <option value="">— 选择开仓设置 —</option>
          {enabledSetups.map((s) => (
            <option key={s.id} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      {setup && (
        <div className="checklist">
          <div className="checklist-title">
            开仓前置检查表
            {setup.marketCondition && <span className="muted"> · {setup.marketCondition}</span>}
          </div>
          {rules.map((r, i) => (
            <label key={i} className="check-item">
              <input
                type="checkbox"
                checked={!!checked[`r${i}`]}
                onChange={(e) => setChecked((c) => ({ ...c, [`r${i}`]: e.target.checked }))}
              />
              <span>{r}</span>
            </label>
          ))}
          {setup.exitRules.length > 0 && (
            <>
              <div className="checklist-title">出场规则</div>
              {setup.exitRules.map((r, i) => (
                <div key={i} className="check-item static">
                  <span className="dot" />
                  <span>{r}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div className="field-row">
        <label className="field">
          <span>止损价</span>
          <input
            className="input"
            type="number"
            step="any"
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
          />
        </label>
        <label className="field">
          <span>目标价（可空）</span>
          <input
            className="input"
            type="number"
            step="any"
            value={takeProfit}
            onChange={(e) => setTakeProfit(e.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span>单笔风险 %</span>
        <input
          className="input"
          type="number"
          step="0.1"
          min="0"
          value={riskPct}
          onChange={(e) => setRiskPct(e.target.value)}
        />
      </label>

      <div className="calc-grid">
        <div>
          <span className="muted">风险金额</span>
          <strong>${riskAmount.toFixed(2)}</strong>
        </div>
        <div>
          <span className="muted">止损距离</span>
          <strong>{dist ? `${((dist / entryPrice) * 100).toFixed(2)}%` : '—'}</strong>
        </div>
        <div>
          <span className="muted">目标 R</span>
          <strong>{targetR === null ? '—' : `${targetR.toFixed(2)}R`}</strong>
        </div>
        <div>
          <span className="muted">数量</span>
          <strong>{qty ? qty.toFixed(4) : '—'}</strong>
        </div>
      </div>

      {msg && <div className="notice error">{msg}</div>}

      <button className="btn primary wide" disabled={!valid} onClick={submit}>
        开仓（按当前 1h 收盘价）
      </button>
      {!setupName && <div className="hint">先选一个设置 —— 没有设置就不该开仓</div>}
      {setupName && !allChecked && <div className="hint">检查表未全部勾选，不能开仓</div>}
    </div>
  );
}
