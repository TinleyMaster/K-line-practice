import { useEffect, useMemo, useState } from 'react';
import { usePracticeStore } from './store/usePracticeStore';
import { DualChart } from './components/DualChart';
import { ReplayControls } from './components/ReplayControls';
import { SymbolPicker } from './components/SymbolPicker';
import { TradePanel } from './components/TradePanel';
import { PositionPanel } from './components/PositionPanel';
import { JournalModal } from './components/JournalModal';
import { StatsView } from './components/StatsView';
import { SetupLibrary } from './components/SetupLibrary';
import { IndicatorPicker } from './components/IndicatorPicker';
import { StartTimePicker } from './components/StartTimePicker';
import { fmtPrice, fmtTime } from './engine/bars';

type View = 'practice' | 'stats' | 'setups';
/** 当前打开的弹出面板（互斥 —— 两个 fixed 弹窗同时存在会互相盖住） */
type Popup = 'start' | 'indicators' | null;

export default function App() {
  const store = usePracticeStore();
  const [view, setView] = useState<View>('practice');
  const [statsKey, setStatsKey] = useState(0);
  const [popup, setPopup] = useState<Popup>(null);

  useEffect(() => {
    void store.bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentBar = store.cursor >= 0 ? store.bars1h[store.cursor] : null;
  const currentPrice = currentBar?.close ?? 0;
  const totalR = store.closedTrades.reduce((s, t) => s + t.rMultiple, 0);

  const canTrade = useMemo(() => {
    if (store.pendingJournal) return false;
    if (store.openTrade) return false;
    if (!currentBar) return false;
    return true;
  }, [store.pendingJournal, store.openTrade, currentBar]);

  // 链上美股低流动性时段无成交，这些小时是前向填充出来的哑线（成交量 0），
  // 提示用户别把哑线当真实成交来读。
  const ffillCount = useMemo(
    () => store.bars1h.filter((b) => b.source === 'geckoterminal_ffill').length,
    [store.bars1h],
  );

  const tradeDisabledReason = store.pendingJournal
    ? '上一笔交易还没复盘'
    : store.openTrade
      ? '持仓中，先平仓'
      : !currentBar
        ? '数据未就绪'
        : undefined;

  const jumpToBar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    const idx = Math.max(0, Math.min(store.bars1h.length - 1, v));
    usePracticeStore.setState({ cursor: idx });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">K</span>
          <div>
            <div className="brand-title">K线刻意练习台</div>
            <div className="brand-sub">4h 看趋势 · 1h 入场 · 看不见未来</div>
          </div>
        </div>

        <div className="topbar-mid">
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

        <div className="topbar-right">
          <div className="stat-chip">
            <span className="muted">权益</span>
            <strong>${store.equity.toFixed(2)}</strong>
          </div>
          <div className="stat-chip">
            <span className="muted">累计R</span>
            <strong className={totalR >= 0 ? 'up' : 'down'}>
              {totalR >= 0 ? '+' : ''}
              {totalR.toFixed(2)}
            </strong>
          </div>
          <div className="stat-chip stat-chip-time">
            <span className="muted">当前时间</span>
            <strong>{currentBar ? fmtTime(currentBar.time) : '—'}</strong>
          </div>
        </div>
      </header>

      <nav className="tabs">
        <button className={`tab ${view === 'practice' ? 'active' : ''}`} onClick={() => setView('practice')}>
          练习台
        </button>
        <button className={`tab ${view === 'stats' ? 'active' : ''}`} onClick={() => { setView('stats'); setStatsKey((k) => k + 1); }}>
          统计看板
        </button>
        <button className={`tab ${view === 'setups' ? 'active' : ''}`} onClick={() => setView('setups')}>
          设置库
        </button>
      </nav>

      {store.error && <div className="notice error banner">{store.error}</div>}

      {store.market === 'stock' && ffillCount > 0 && (
        <div className="notice info banner">
          链上美股流动性低：本序列有 {ffillCount} 根是低流动性时段的填充哑线（成交量 0），读形态时请留意。
        </div>
      )}

      {view === 'practice' && (
        <main className="practice-layout">
          <section className="chart-area">
            {store.loading ? (
              <div className="view-loading">加载 K 线数据…</div>
            ) : store.bars1h.length === 0 ? (
              <div className="view-loading">选择一个标的开练</div>
            ) : (
              <>
                <DualChart
                  symbol={store.symbol}
                  bars1h={store.bars1h}
                  cursor={store.cursor}
                  openTrade={store.openTrade}
                  indicators4h={store.indicators4h}
                  indicators1h={store.indicators1h}
                />
                <ReplayControls
                  playing={store.playing}
                  speed={store.speed}
                  cursor={store.cursor}
                  total={store.bars1h.length}
                  onPlay={store.play}
                  onPause={store.pause}
                  onNext={store.next}
                  onJump4h={store.jump4h}
                  onSpeed={store.setSpeed}
                  onReset={store.resetReplay}
                />
                <div className="jump-row">
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
                    open={popup === 'indicators'}
                    onOpenChange={(o) => setPopup(o ? 'indicators' : null)}
                  />
                  <span className="jump-sep" />
                  <span className="muted">跳到第</span>
                  <input
                    className="input tiny-input"
                    type="number"
                    value={store.cursor + 1}
                    onChange={jumpToBar}
                    min={1}
                    max={store.bars1h.length}
                  />
                  <span className="muted">根（1h）</span>
                  <span className="muted">· 现价 {fmtPrice(currentPrice)}</span>
                </div>
              </>
            )}
          </section>

          <aside className="side-area">
            {store.openTrade ? (
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
            ) : store.tradePanelOpen ? (
              <TradePanel
                setups={store.setups}
                entryPrice={currentPrice}
                equity={store.equity}
                disabled={!canTrade}
                disabledReason={tradeDisabledReason}
                onOpen={store.openPosition}
                onClose={() => store.setTradePanelOpen(false)}
              />
            ) : (
              <button
                className="btn primary wide trade-open-trigger"
                onClick={() => store.setTradePanelOpen(true)}
                disabled={!canTrade}
                title={tradeDisabledReason ?? '打开开仓面板'}
              >
                🛒 开仓
                {tradeDisabledReason && <span className="trade-trigger-note">{tradeDisabledReason}</span>}
              </button>
            )}

            {store.closedTrades.length > 0 && !store.openTrade && (
              <PositionPanel
                openTrade={null}
                closedTrades={store.closedTrades}
                equity={store.equity}
                equityStart={store.equityStart}
                maxDrawdown={store.maxDrawdown}
                currentPrice={currentPrice}
                equityCurve={store.equityCurve}
                onClose={() => {}}
              />
            )}
          </aside>
        </main>
      )}

      {view === 'stats' && (
        <main className="full-view">
          <StatsView refreshKey={statsKey} />
        </main>
      )}

      {view === 'setups' && (
        <main className="full-view">
          <SetupLibrary setups={store.setups} onChanged={() => void store.bootstrap()} />
        </main>
      )}

      {store.pendingJournal && (
        <JournalModal trade={store.pendingJournal} onSave={(p) => void store.saveJournal(p)} />
      )}
    </div>
  );
}
