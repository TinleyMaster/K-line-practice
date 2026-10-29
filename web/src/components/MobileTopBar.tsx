import { fmtPrice } from '../engine/bars';
import { dir, fmtPct, fmtSigned } from '../engine/format';

interface Props {
  symbol: string;
  market: 'perp' | 'spot' | 'stock';
  marketLabel: string;
  currentPrice: number;
  /** 24h 窗口的涨跌（与行情头一致） */
  stats: { chg: number; chgPct: number } | null;
  equity: number;
  userDisplayName?: string;
  onMenu: () => void;
  onEquity: () => void;
}

/**
 * 移动端精简顶栏（币安风格）：
 *   [☰] [币种 + 实时价 + 涨跌%] [权益]
 * 点 ☰ 或点币种/权益都打开 ☰ 抽屉（切标的、看账户、进其它视图都在抽屉里）。
 */
export function MobileTopBar({
  symbol,
  market,
  marketLabel,
  currentPrice,
  stats,
  equity,
  userDisplayName,
  onMenu,
  onEquity,
}: Props) {
  const tone = stats ? dir(stats.chg) : 0;
  const toneCls = tone === 1 ? 'up' : tone === -1 ? 'down' : '';
  const marketTag = market === 'perp' ? '合约' : market === 'spot' ? '现货' : '美股';

  return (
    <div className="m-topbar" title={marketLabel}>
      <button className="m-menu-btn" onClick={onMenu} aria-label="打开菜单">
        ☰
      </button>

      <button className="m-ticker" onClick={onMenu}>
        <span className="m-ticker-symbol">{symbol}</span>
        <span className={`m-ticker-badge ${market}`}>{marketTag}</span>
        <span className={`m-ticker-price ${toneCls}`}>{fmtPrice(currentPrice)}</span>
        {stats && (
          <span className={`m-ticker-chg ${toneCls}`}>
            {fmtSigned(stats.chg)} ({fmtPct(stats.chgPct)})
          </span>
        )}
      </button>

      <button className="m-equity" onClick={onEquity}>
        <span className="m-equity-label">{userDisplayName ? userDisplayName : '权益'}</span>
        <span className="m-equity-val">${equity.toFixed(2)}</span>
      </button>
    </div>
  );
}
