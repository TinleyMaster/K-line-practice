import { useEffect, useMemo, useState } from 'react';
import type { EntryMode, Setup, SizeMode, StopType, TargetType, TradeSide } from '../types';
import { atr, fmtPrice } from '../engine/bars';

interface Props {
  setups: Setup[];
  entryPrice: number;
  equity: number;
  /** 用于算 ATR 的已揭示 1h K 线（止损可按 ATR 倍数设置） */
  bars1h: Bar[];
  disabled: boolean;
  disabledReason?: string;
  onOpen: (draft: {
    side: TradeSide;
    stopLoss: number;
    takeProfit: number | null;
    riskPct: number;
    setup: string | null;
    checklist: Record<string, boolean>;
    entryMode: EntryMode;
    limitPrice: number | null;
    stopType: StopType;
    tpType: TargetType;
    sizeMode: SizeMode;
    sizeValue: number;
    feeRate: number;
    slippageBps: number;
    timeStopHrs: number | null;
    confidence: number | null;
    notes: string | null;
  }) => Promise<{ ok: boolean; msg?: string }>;
  /** 收起面板（回到折叠态） */
  onClose: () => void;
}

type Bar = import('../types').Bar;

/** 常用止损距离预设（%），点一下就填 */
const STOP_PRESETS = [0.5, 1, 2, 3];
/** 常用目标 R 倍数 */
const TP_RATIOS = [1, 1.5, 2, 3];

/**
 * 开仓面板（v6 补全）。
 *
 * 之前只有「方向 / 设置 / 止损价 / 目标价 / 风险%」五项，
 * 实战里缺的几个关键维度（都会直接影响 R 的计算与执行质量）：
 *
 *   1. **入场方式**（市价 / 限价）—— 限价单没到价不该成交
 *   2. **止损定义方式**（固定价 / 百分比 / ATR 倍数）—— ATR 更贴合波动率
 *   3. **止盈定义方式**（固定价 / R 倍数 / 不设）—— 直接填「2R」比手算价格准
 *   4. **仓位定义方式**（按风险 % / 按名义金额）—— 有人习惯用固定名义额
 *   5. **手续费率** —— 不算进去的话，高频交易的期望会被系统性高估
 *   6. **滑点** —— 同上
 *   7. **时间止损**（小时）—— 计划失效就撤，别等价格止损
 *   8. **信号置信度**（1~5）—— 复盘时能分层看自己的胜率
 *   9. **备注** —— 进场理由，事后复盘的关键输入
 */
export function TradePanel({
  setups,
  entryPrice,
  equity,
  bars1h,
  disabled,
  disabledReason,
  onOpen,
  onClose,
}: Props) {
  const enabledSetups = useMemo(() => setups.filter((s) => s.enabled), [setups]);
  const [side, setSide] = useState<TradeSide>('long');
  const [setupName, setSetupName] = useState<string>('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);

  /* ---- v6：开仓设置扩展 ---- */
  const [entryMode, setEntryMode] = useState<EntryMode>('market');
  const [limitPrice, setLimitPrice] = useState<string>('');
  const [stopType, setStopType] = useState<StopType>('price');
  const [stopPct, setStopPct] = useState<string>('1');
  const [atrMult, setAtrMult] = useState<string>('2');
  const [stopPrice, setStopPrice] = useState<string>('');
  const [tpType, setTpType] = useState<TargetType>('price');
  const [tpPrice, setTpPrice] = useState<string>('');
  const [tpRatio, setTpRatio] = useState<string>('2');
  const [sizeMode, setSizeMode] = useState<SizeMode>('risk');
  const [sizeValue, setSizeValue] = useState<string>('1');
  const [feeRate, setFeeRate] = useState<string>('0.04');
  const [slippageBps, setSlippageBps] = useState<string>('2');
  const [timeStopHrs, setTimeStopHrs] = useState<string>('');
  const [confidence, setConfidence] = useState<number>(3);
  const [notes, setNotes] = useState<string>('');

  const setup = enabledSetups.find((s) => s.name === setupName) ?? null;

  // ATR（用于「按 ATR 设止损」）
  const atrValue = useMemo(() => atr(bars1h, 14), [bars1h]);

  // 切换设置时重置勾选
  useEffect(() => {
    setChecked({});
  }, [setupName]);

  /**
   * 止损价推导。
   *   - price：用户直接填
   *   - pct  ：入场价 ± N%
   *   - atr  ：入场价 ± N × ATR
   */
  const stop = useMemo(() => {
    if (stopType === 'price') return Number(stopPrice);
    if (stopType === 'pct') {
      const p = Number(stopPct);
      if (!Number.isFinite(p) || p <= 0) return NaN;
      const d = (entryPrice * p) / 100;
      return side === 'long' ? entryPrice - d : entryPrice + d;
    }
    // atr
    const m = Number(atrMult);
    if (!Number.isFinite(m) || m <= 0 || atrValue <= 0) return NaN;
    const d = atrValue * m;
    return side === 'long' ? entryPrice - d : entryPrice + d;
  }, [stopType, stopPrice, stopPct, atrMult, atrValue, entryPrice, side]);

  /** 止损距离（正数） */
  const dist = Number.isFinite(stop) ? Math.abs(entryPrice - stop) : 0;

  /** 目标价推导：固定价 / R 倍数 / 不设 */
  const tp = useMemo(() => {
    if (tpType === 'none') return null;
    if (tpType === 'price') {
      const v = Number(tpPrice);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    const r = Number(tpRatio);
    if (!Number.isFinite(r) || r <= 0 || dist <= 0) return null;
    return side === 'long' ? entryPrice + r * dist : entryPrice - r * dist;
  }, [tpType, tpPrice, tpRatio, dist, entryPrice, side]);

  /** 风险金额与数量 */
  const riskAmount = useMemo(() => {
    if (sizeMode === 'risk') {
      const pct = Number(sizeValue);
      if (!Number.isFinite(pct) || pct <= 0) return 0;
      return equity * (pct / 100);
    }
    // 名义金额模式：风险金额按名义额反推（止损距离百分比）
    const notional = Number(sizeValue);
    if (!Number.isFinite(notional) || notional <= 0 || entryPrice <= 0) return 0;
    const stopPctOfPrice = dist / entryPrice;
    if (stopPctOfPrice <= 0) return 0;
    return notional * stopPctOfPrice;
  }, [sizeMode, sizeValue, equity, entryPrice, dist]);

  const qty = dist > 0 && riskAmount > 0 ? riskAmount / dist : 0;
  const notionalValue = qty * entryPrice;
  const targetR = tp !== null && dist > 0 ? Math.abs(tp - entryPrice) / dist : null;

  /** 手续费 + 滑点对期望的影响（每笔往返） */
  const costRate = (Number(feeRate) || 0) * 2 + ((Number(slippageBps) || 0) * 2) / 10000;
  const costAmount = notionalValue * costRate;

  const rules = setup?.entryRules ?? [];
  const allChecked = rules.length === 0 || rules.every((_, i) => checked[`r${i}`]);

  const limitValid =
    entryMode === 'market' ||
    (Number.isFinite(Number(limitPrice)) &&
      Number(limitPrice) > 0 &&
      (side === 'long' ? Number(limitPrice) < entryPrice : Number(limitPrice) > entryPrice));

  const valid =
    !disabled &&
    !!setupName &&
    allChecked &&
    limitValid &&
    Number.isFinite(stop) &&
    stop > 0 &&
    (side === 'long' ? stop < entryPrice : stop > entryPrice) &&
    (tp === null || (side === 'long' ? tp > entryPrice : tp < entryPrice)) &&
    riskAmount > 0 &&
    qty > 0 &&
    confidence >= 1 &&
    confidence <= 5;

  const submit = async () => {
    setMsg(null);
    const res = await onOpen({
      side,
      stopLoss: stop,
      takeProfit: tp,
      riskPct: sizeMode === 'risk' ? Number(sizeValue) : (riskAmount / equity) * 100,
      setup: setupName,
      checklist: checked,
      entryMode,
      limitPrice: entryMode === 'limit' ? Number(limitPrice) : null,
      stopType,
      tpType,
      sizeMode,
      sizeValue: Number(sizeValue),
      feeRate: (Number(feeRate) || 0) / 100,
      slippageBps: Number(slippageBps) || 0,
      timeStopHrs: timeStopHrs.trim() ? Number(timeStopHrs) : null,
      confidence,
      notes: notes.trim() || null,
    });
    if (!res.ok) setMsg(res.msg ?? '开仓失败');
  };

  return (
    <div className="panel trade-panel">
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

      {/* ---------- 入场方式 ---------- */}
      <div className="field">
        <span>入场方式</span>
        <div className="btn-row">
          <button
            className={`btn ${entryMode === 'market' ? 'active' : ''}`}
            onClick={() => setEntryMode('market')}
          >
            市价（当前价）
          </button>
          <button
            className={`btn ${entryMode === 'limit' ? 'active' : ''}`}
            onClick={() => setEntryMode('limit')}
          >
            限价挂单
          </button>
        </div>
      </div>

      {entryMode === 'limit' && (
        <label className="field">
          <span>限价{side === 'long' ? '（低于现价才成交）' : '（高于现价才成交）'}</span>
          <input
            className="input"
            type="number"
            step="any"
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            placeholder="挂单价"
          />
        </label>
      )}

      {/* ---------- 止损 ---------- */}
      <div className="field">
        <span>止损方式</span>
        <div className="btn-row seg">
          <button
            className={`btn ${stopType === 'price' ? 'active' : ''}`}
            onClick={() => setStopType('price')}
          >
            固定价
          </button>
          <button
            className={`btn ${stopType === 'pct' ? 'active' : ''}`}
            onClick={() => setStopType('pct')}
          >
            百分比
          </button>
          <button
            className={`btn ${stopType === 'atr' ? 'active' : ''}`}
            onClick={() => setStopType('atr')}
            title={atrValue > 0 ? `当前 ATR(14) = ${atrValue.toFixed(2)}` : 'ATR 数据不足'}
          >
            ATR 倍数
          </button>
        </div>
      </div>

      {stopType === 'price' && (
        <label className="field">
          <span>止损价</span>
          <input
            className="input"
            type="number"
            step="any"
            value={stopPrice}
            onChange={(e) => setStopPrice(e.target.value)}
          />
        </label>
      )}

      {stopType === 'pct' && (
        <>
          <label className="field">
            <span>止损距离 %</span>
            <input
              className="input"
              type="number"
              step="0.1"
              min="0"
              value={stopPct}
              onChange={(e) => setStopPct(e.target.value)}
            />
          </label>
          <div className="preset-row">
            {STOP_PRESETS.map((p) => (
              <button key={p} className="btn tiny ghost" onClick={() => setStopPct(String(p))}>
                {p}%
              </button>
            ))}
          </div>
        </>
      )}

      {stopType === 'atr' && (
        <>
          <label className="field">
            <span>ATR 倍数{atrValue > 0 ? `（ATR=${atrValue.toFixed(2)}）` : ''}</span>
            <input
              className="input"
              type="number"
              step="0.1"
              min="0"
              value={atrMult}
              onChange={(e) => setAtrMult(e.target.value)}
            />
          </label>
          <div className="preset-row">
            {[1, 1.5, 2, 3].map((m) => (
              <button key={m} className="btn tiny ghost" onClick={() => setAtrMult(String(m))}>
                {m}×
              </button>
            ))}
          </div>
        </>
      )}

      {/* ---------- 止盈 ---------- */}
      <div className="field">
        <span>止盈方式</span>
        <div className="btn-row seg">
          <button
            className={`btn ${tpType === 'price' ? 'active' : ''}`}
            onClick={() => setTpType('price')}
          >
            固定价
          </button>
          <button
            className={`btn ${tpType === 'ratio' ? 'active' : ''}`}
            onClick={() => setTpType('ratio')}
          >
            R 倍数
          </button>
          <button
            className={`btn ${tpType === 'none' ? 'active' : ''}`}
            onClick={() => setTpType('none')}
          >
            不设
          </button>
        </div>
      </div>

      {tpType === 'price' && (
        <label className="field">
          <span>目标价</span>
          <input
            className="input"
            type="number"
            step="any"
            value={tpPrice}
            onChange={(e) => setTpPrice(e.target.value)}
          />
        </label>
      )}

      {tpType === 'ratio' && (
        <>
          <label className="field">
            <span>目标 R 倍数</span>
            <input
              className="input"
              type="number"
              step="0.1"
              min="0"
              value={tpRatio}
              onChange={(e) => setTpRatio(e.target.value)}
            />
          </label>
          <div className="preset-row">
            {TP_RATIOS.map((r) => (
              <button key={r} className="btn tiny ghost" onClick={() => setTpRatio(String(r))}>
                {r}R
              </button>
            ))}
          </div>
        </>
      )}

      {/* ---------- 仓位 ---------- */}
      <div className="field">
        <span>仓位方式</span>
        <div className="btn-row seg">
          <button
            className={`btn ${sizeMode === 'risk' ? 'active' : ''}`}
            onClick={() => setSizeMode('risk')}
          >
            按风险 %
          </button>
          <button
            className={`btn ${sizeMode === 'notional' ? 'active' : ''}`}
            onClick={() => setSizeMode('notional')}
          >
            按名义额
          </button>
        </div>
      </div>

      <label className="field">
        <span>{sizeMode === 'risk' ? '单笔风险 %' : '名义金额 (USDT)'}</span>
        <input
          className="input"
          type="number"
          step="0.1"
          min="0"
          value={sizeValue}
          onChange={(e) => setSizeValue(e.target.value)}
        />
      </label>

      {/* ---------- 成本 ---------- */}
      <div className="field-row">
        <label className="field">
          <span>手续费率 %（单边）</span>
          <input
            className="input"
            type="number"
            step="0.001"
            min="0"
            value={feeRate}
            onChange={(e) => setFeeRate(e.target.value)}
          />
        </label>
        <label className="field">
          <span>滑点 bp</span>
          <input
            className="input"
            type="number"
            step="0.1"
            min="0"
            value={slippageBps}
            onChange={(e) => setSlippageBps(e.target.value)}
          />
        </label>
      </div>

      {/* ---------- 时间止损 ---------- */}
      <label className="field">
        <span>时间止损（小时，可空）</span>
        <input
          className="input"
          type="number"
          step="1"
          min="0"
          value={timeStopHrs}
          onChange={(e) => setTimeStopHrs(e.target.value)}
          placeholder="例：24"
        />
      </label>

      {/* ---------- 置信度 ---------- */}
      <div className="field">
        <span>信号置信度</span>
        <div className="btn-row seg">
          {[1, 2, 3, 4, 5].map((c) => (
            <button
              key={c}
              className={`btn ${confidence === c ? 'active' : ''}`}
              onClick={() => setConfidence(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* ---------- 备注 ---------- */}
      <label className="field">
        <span>进场理由 / 备注</span>
        <textarea
          className="input textarea"
          maxLength={200}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="例：4h 上升趋势中回踩 MA20，1h 出现锤子线，止损放在前低。"
        />
      </label>

      <div className="calc-grid">
        <div>
          <span className="muted">止损价</span>
          <strong>{Number.isFinite(stop) ? fmtPrice(stop) : '—'}</strong>
        </div>
        <div>
          <span className="muted">止损距离</span>
          <strong>{dist ? `${((dist / entryPrice) * 100).toFixed(2)}%` : '—'}</strong>
        </div>
        <div>
          <span className="muted">风险金额</span>
          <strong>${riskAmount.toFixed(2)}</strong>
        </div>
        <div>
          <span className="muted">目标 R</span>
          <strong>{targetR === null ? '—' : `${targetR.toFixed(2)}R`}</strong>
        </div>
        <div>
          <span className="muted">数量</span>
          <strong>{qty ? qty.toFixed(4) : '—'}</strong>
        </div>
        <div>
          <span className="muted">名义额</span>
          <strong>{notionalValue ? `$${notionalValue.toFixed(0)}` : '—'}</strong>
        </div>
        <div>
          <span className="muted">往返成本</span>
          <strong>{costAmount ? `$${costAmount.toFixed(2)}` : '—'}</strong>
        </div>
        <div>
          <span className="muted">成本占风险</span>
          <strong>
            {riskAmount > 0 && costAmount > 0 ? `${((costAmount / riskAmount) * 100).toFixed(1)}%` : '—'}
          </strong>
        </div>
      </div>

      {costAmount > 0 && riskAmount > 0 && costAmount / riskAmount > 0.1 && (
        <div className="hint warn-hint">
          往返成本已占单笔风险的 {((costAmount / riskAmount) * 100).toFixed(0)}% —— 期望会被显著侵蚀
        </div>
      )}

      {msg && <div className="notice error">{msg}</div>}

      <button className="btn primary wide" disabled={!valid} onClick={submit}>
        开仓（按当前 1h 收盘价）
      </button>
      {!setupName && <div className="hint">先选一个设置 —— 没有设置就不该开仓</div>}
      {setupName && !allChecked && <div className="hint">检查表未全部勾选，不能开仓</div>}
      {entryMode === 'limit' && !limitValid && (
        <div className="hint">
          限价{side === 'long' ? '必须低于现价' : '必须高于现价'}
        </div>
      )}
    </div>
  );
}
