import { useMemo, useState } from 'react';
import { usePracticeStore, priceBarAt } from '../store/usePracticeStore';
import { ChartPanel } from './ChartPanel';
import { ReplayControls } from './ReplayControls';
import { SymbolPicker } from './SymbolPicker';
import { TradePanel } from './TradePanel';
import { PositionPanel } from './PositionPanel';
import { AccountPanel } from './AccountPanel';
import { JournalModal } from './JournalModal';
import { StartTimePicker } from './StartTimePicker';
import { IndicatorPicker } from './IndicatorPicker';
import { PendingJournal } from './PendingJournal';
import { BottomSheet } from './BottomSheet';
import { fmtPrice } from '../engine/bars';
import { fmtCompact } from '../engine/format';

type View = 'practice' | 'stats' | 'setups' | 'pk';

interface Props {
  /** 24h 窗口的涨跌（来自 App，与顶栏一致） */
  stats: { chg: number; chgPct: number; high: number; low: number; volume: number } | null;
  view: View;
  onNavigate: (v: View) => void;
  drawerOpen: boolean;
  setDrawerOpen: (o: boolean) => void;
  popup: 'start' | 'indicators' | null;
  setPopup: (p: 'start' | 'indicators' | null) => void;
  setAuthOpen: (o: boolean) => void;
}

/**
 * 移动端「练习台」布局（币安式）：
 *   - 图表占满顶栏与底栏之间的空间（首屏即见 K 线）
 *   - 底部吸底操作条：左=回放（看不见未来的核心），右=开仓/平仓
 *   - 起点 / 指标 / 跳第N根 / 账户 / 视图切换 全部收进 ☰ 抽屉
 * 桌面端仍走 App 里的 <main className="practice-layout">，本组件只在 .app-mobile 下渲染。
 */
export function MobilePractice({
  stats,
  view,
  onNavigate,
  drawerOpen,
  setDrawerOpen,
  popup,
  setPopup,
  setAuthOpen,
}: Props) {
  const store = usePracticeStore();
  const [positionSheet, setPositionSheet] = useState(false);

  const currentBar = useMemo(
    () => priceBarAt(store.bars1h, store.bars15m, store.cursor, store.cursorMs),
    [store.bars1h, store.bars15m, store.cursor, store.cursorMs],
  );
  const currentPrice = currentBar?.close ?? 0;

  const lookback = store.cursor >= 0 && store.cursor < store.maxCursor;

  const canTrade = useMemo(() => {
    if (store.pendingJournal) return false;
    if (store.openTrade) return false;
    if (lookback) return false;
    if (!currentBar) return false;
    return true;
  }, [store.pendingJournal, store.openTrade, currentBar, lookback]);

  const tradeDisabledReason = store.pendingJournal
    ? '上一笔交易还没复盘'
    : store.openTrade
      ? '持仓中，先平仓'
      : lookback
        ? '回看模式，不能开仓'
        : !currentBar
          ? '数据未就绪'
          : undefined;

  const jumpToBar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    const idx = Math.max(0, Math.min(store.bars1h.length - 1, v));
    usePracticeStore.setState({ cursor: idx, cursorMs: store.bars1h[idx]?.time ?? -1 });
  };

  const openDrawerTo = (v: View) => {
    setDrawerOpen(false);
    onNavigate(v);
  };

  return (
    <div className="m-practice">
      {/* ===== 图表主体（首屏满屏） ===== */}
      <div className="m-chart-area">
        {store.loading ? (
          <div className="view-loading">加载 K 线数据…</div>
        ) : store.bars1h.length === 0 ? (
          <div className="view-loading">选择一个标的开练</div>
        ) : (
          <>
            <ChartPanel
              symbol={store.symbol}
              market={store.market}
              bars1h={store.bars1h}
              bars15m={store.bars15m}
              cursor={store.cursor}
              cursorMs={store.cursorMs}
              startCursor={store.startCursor}
              openTrade={store.openTrade}
              indicators4h={store.indicators4h}
              indicators1h={store.indicators1h}
              period={store.chartPeriod}
              onPeriodChange={store.setChartPeriod}
            />

            {stats && (
              <div className="m-24h">
                <span>
                  <em>24h高</em>
                  {fmtPrice(stats.high)}
                </span>
                <span>
                  <em>24h低</em>
                  {fmtPrice(stats.low)}
                </span>
                <span>
                  <em>24h量</em>
                  {fmtCompact(stats.volume)}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {/* ===== 底部吸底操作条 ===== */}
      <div className="m-actionbar">
        <div className="m-replay">
          <ReplayControls
            playing={store.playing}
            speed={store.speed}
            cursor={store.cursor}
            total={store.bars1h.length}
            period={store.chartPeriod}
            lookback={lookback}
            onPlay={store.play}
            onPause={store.pause}
            onNext={store.next}
            onPrev={store.prev}
            onJump4h={store.jump4h}
            onBack4h={store.back4h}
            onSpeed={store.setSpeed}
            onReset={store.resetReplay}
          />
        </div>

        <div className="m-trade">
          {!canTrade && tradeDisabledReason && (
            <div className="m-trade-hint">{tradeDisabledReason}</div>
          )}
          {store.openTrade ? (
            <button className="btn danger wide" onClick={() => setPositionSheet(true)}>
              平仓
            </button>
          ) : (
            <button
              className="btn primary wide"
              disabled={!canTrade}
              onClick={() => store.setTradePanelOpen(true)}
            >
              开仓
            </button>
          )}
        </div>
      </div>

      {/* ===== 开仓面板（底部抽屉） ===== */}
      {store.tradePanelOpen && (
        <BottomSheet
          open={store.tradePanelOpen}
          onClose={() => store.setTradePanelOpen(false)}
          title="开仓"
        >
          <TradePanel
            setups={store.setups}
            entryPrice={currentPrice}
            priceLabel={store.chartPeriod === '15m' ? '当前 15m 价' : '当前 1h 价'}
            equity={store.equity}
            bars1h={store.bars1h}
            disabled={!canTrade}
            disabledReason={tradeDisabledReason}
            onOpen={store.openPosition}
            onClose={() => store.setTradePanelOpen(false)}
          />
        </BottomSheet>
      )}

      {/* ===== 持仓面板（底部抽屉） ===== */}
      {store.openTrade && (
        <BottomSheet open={positionSheet} onClose={() => setPositionSheet(false)} title="持仓">
          <PositionPanel
            openTrade={store.openTrade}
            closedTrades={store.closedTrades}
            equity={store.equity}
            equityStart={store.equityStart}
            maxDrawdown={store.maxDrawdown}
            currentPrice={currentPrice}
            equityCurve={store.equityCurve}
            onClose={() => void store.closePosition('manual')}
          />
        </BottomSheet>
      )}

      {/* ===== ☰ 抽屉（高级控制 + 视图切换） ===== */}
      <BottomSheet open={drawerOpen} onClose={() => setDrawerOpen(false)} title="菜单">
        <div className="m-section">
          <div className="m-section-title">市场</div>
          <div className="m-market">
            {store.markets.map((m) => (
              <button
                key={m.market}
                data-market={m.market}
                className={`m-market-btn ${m.market === store.market ? 'active' : ''}`}
                onClick={() => {
                  void store.selectMarket(m.market);
                  setDrawerOpen(false);
                }}
                disabled={store.loading}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="m-nav">
          <button
            className={`m-nav-btn ${view === 'practice' ? 'active' : ''}`}
            onClick={() => openDrawerTo('practice')}
          >
            练习台
          </button>
          <button
            className={`m-nav-btn ${view === 'stats' ? 'active' : ''}`}
            onClick={() => openDrawerTo('stats')}
          >
            统计看板
          </button>
          <button
            className={`m-nav-btn ${view === 'pk' ? 'active' : ''}`}
            onClick={() => openDrawerTo('pk')}
          >
            胜率 PK
          </button>
          <button
            className={`m-nav-btn ${view === 'setups' ? 'active' : ''}`}
            onClick={() => openDrawerTo('setups')}
          >
            设置库
          </button>
        </div>

        <div className="m-section">
          <div className="m-section-title">标的</div>
          <SymbolPicker
            symbols={store.symbols}
            markets={store.markets}
            current={store.symbol}
            market={store.market}
            onSelect={(s, m) => void store.selectSymbol(s, m)}
            onMarketChange={(m) => void store.selectMarket(m)}
            loading={store.loading}
          />
        </div>

        <div className="m-section">
          <div className="m-section-title">练习设置</div>
          <StartTimePicker
            bars1h={store.bars1h}
            cursor={store.cursor}
            isManual={store.startMode === 'manual'}
            onSet={(t) => store.setStartTime(t)}
            open={popup === 'start'}
            onOpenChange={(o) => setPopup(o ? 'start' : null)}
          />
          <IndicatorPicker
            value4h={store.indicators4h}
            value1h={store.indicators1h}
            onChange={(p, names) => store.setIndicators(p, names)}
            currentPeriod={store.chartPeriod}
            open={popup === 'indicators'}
            onOpenChange={(o) => setPopup(o ? 'indicators' : null)}
          />
          <div className="m-jump">
            <span className="muted">跳到第</span>
            <input
              className="input tiny-input"
              type="number"
              value={store.cursor + 1}
              onChange={jumpToBar}
              min={1}
              max={store.bars1h.length}
            />
            <span className="muted">根（1h）· 现价 {fmtPrice(currentPrice)}</span>
          </div>
        </div>

        <div className="m-section">
          <div className="m-section-title">账户</div>
          <AccountPanel
            equity={store.equity}
            equityStart={store.equityStart}
            openTrade={store.openTrade}
            closedTrades={store.closedTrades}
            maxDrawdown={store.maxDrawdown}
            currentPrice={currentPrice}
          />
          <PendingJournal />
        </div>

        <div className="m-section">
          {store.user ? (
            <button className="btn wide" onClick={() => void store.logout()}>
              退出登录（{store.user.displayName}）
            </button>
          ) : (
            <button className="btn wide" onClick={() => setAuthOpen(true)}>
              登录 / 注册
            </button>
          )}
        </div>
      </BottomSheet>

      {/* 复盘弹窗（与桌面共用，由 App 统一渲染） */}
      {store.pendingJournal && (
        <JournalModal
          trade={store.pendingJournal}
          onSave={(p) => void store.saveJournal(p)}
          onSkip={() => void store.skipJournal()}
        />
      )}
    </div>
  );
}
