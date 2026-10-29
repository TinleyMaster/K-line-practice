import { useEffect, useMemo, useState } from 'react';
import { usePracticeStore } from './store/usePracticeStore';
import { ChartPanel } from './components/ChartPanel';
import { MarketHeader } from './components/MarketHeader';
import { ReplayControls } from './components/ReplayControls';
import { SymbolPicker } from './components/SymbolPicker';
import { TradePanel } from './components/TradePanel';
import { PositionPanel } from './components/PositionPanel';
import { AccountPanel } from './components/AccountPanel';
import { JournalModal } from './components/JournalModal';
import { StatsView } from './components/StatsView';
import { SetupLibrary } from './components/SetupLibrary';
import { IndicatorPicker } from './components/IndicatorPicker';
import { StartTimePicker } from './components/StartTimePicker';
import { AuthPanel } from './components/AuthPanel';
import { PkView } from './components/PkView';
import { PendingJournal } from './components/PendingJournal';
import { useIsMobile } from './hooks/useMediaQuery';
import { MobileTopBar } from './components/MobileTopBar';
import { MobilePractice } from './components/MobilePractice';
import { fmtPrice, fmtTime } from './engine/bars';
import { priceBarAt } from './store/usePracticeStore';

type View = 'practice' | 'stats' | 'setups' | 'pk';
/** 当前打开的弹出面板（互斥 —— 两个 fixed 弹窗同时存在会互相盖住） */
type Popup = 'start' | 'indicators' | null;

export default function App() {
  const store = usePracticeStore();
  const [view, setView] = useState<View>('practice');
  const [statsKey, setStatsKey] = useState(0);
  const [popup, setPopup] = useState<Popup>(null);
  /** 是否展开登录面板 */
  const [authOpen, setAuthOpen] = useState(false);

  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    void store.bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 「现价」= 当前时刻对应的那根 K 线的收盘价。
   *
   * v6.3：15m 档下 cursorMs 可能落在某根 1h 内部，此时用 1h 收盘价当现价
   * 会让顶栏价格、开仓价和图上看到的 K 线对不上 —— 统一按 cursorMs 定位。
   */
  const currentBar = useMemo(
    () => priceBarAt(store.bars1h, store.bars15m, store.cursor, store.cursorMs),
    [store.bars1h, store.bars15m, store.cursor, store.cursorMs],
  );
  const currentPrice = currentBar?.close ?? 0;
  const totalR = store.closedTrades.reduce((s, t) => s + t.rMultiple, 0);

  /** 顶栏/底栏用的 24h 窗口涨跌（与行情头 MarketHeader 同口径） */
  const stats = useMemo(() => {
    const rev = store.cursor >= 0 ? store.bars1h.slice(0, store.cursor + 1) : [];
    if (!rev.length) return null;
    const last = rev[rev.length - 1];
    const w = rev.slice(-24);
    const high = Math.max(...w.map((b) => b.high));
    const low = Math.min(...w.map((b) => b.low));
    const volume = w.reduce((s, b) => s + b.volume, 0);
    const open = w[0].open;
    const chg = last.close - open;
    const chgPct = open ? (chg / open) * 100 : 0;
    return { last, high, low, volume, chg, chgPct };
  }, [store.bars1h, store.cursor]);

  /** 移动端 ☰ 抽屉里的视图切换（顺带 bump statsKey，与桌面 Tab 行为一致） */
  const navigate = (v: View) => {
    setView(v);
    if (v === 'stats' || v === 'pk') setStatsKey((k) => k + 1);
    setDrawerOpen(false);
  };

  /** 回看模式：游标落后于已回放到的最远处 —— 这时不能开仓 */
  const lookback = store.cursor >= 0 && store.cursor < store.maxCursor;

  const canTrade = useMemo(() => {
    if (store.pendingJournal) return false;
    if (store.openTrade) return false;
    if (lookback) return false;
    if (!currentBar) return false;
    return true;
  }, [store.pendingJournal, store.openTrade, currentBar, lookback]);

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
      : lookback
        ? '回看模式，不能开仓'
        : !currentBar
          ? '数据未就绪'
          : undefined;

  const jumpToBar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    const idx = Math.max(0, Math.min(store.bars1h.length - 1, v));
    // cursorMs 必须同步 —— 否则跳过去后，15m 档的右端还停在旧位置
    usePracticeStore.setState({ cursor: idx, cursorMs: store.bars1h[idx]?.time ?? -1 });
  };

  const revealed = useMemo(
    () => (store.cursor >= 0 ? store.bars1h.slice(0, store.cursor + 1) : []),
    [store.bars1h, store.cursor],
  );

  const marketLabel =
    store.markets.find((m) => m.market === store.market)?.label ??
    (store.market === 'perp' ? 'U本位合约' : store.market === 'spot' ? '现货' : '链上美股');

  return (
    <div className={isMobile ? 'app app-mobile' : 'app'}>
      {isMobile && (
        <MobileTopBar
          symbol={store.symbol}
          market={store.market}
          marketLabel={marketLabel}
          currentPrice={currentPrice}
          stats={stats}
          equity={store.equity}
          userDisplayName={store.user?.displayName}
          onMenu={() => setDrawerOpen(true)}
          onEquity={() => setDrawerOpen(true)}
        />
      )}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">K</span>
          <div className="brand-text">
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
          {store.skippedJournal.length > 0 && (
            <div className="stat-chip pending-chip" title="有跳过的复盘待补写">
              <span className="muted">待补复盘</span>
              <strong className="down">{store.skippedJournal.length}</strong>
            </div>
          )}
          <button
            className={`btn tiny ${store.user ? 'user-chip' : 'ghost'}`}
            onClick={() => (store.user ? void store.logout() : setAuthOpen(true))}
            title={store.user ? '点击登出' : '登录以隔离数据并参与 PK'}
          >
            {store.user ? `${store.user.displayName} ▾` : '登录'}
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button className={`tab ${view === 'practice' ? 'active' : ''}`} onClick={() => setView('practice')}>
          练习台
        </button>
        <button className={`tab ${view === 'stats' ? 'active' : ''}`} onClick={() => { setView('stats'); setStatsKey((k) => k + 1); }}>
          统计看板
        </button>
        <button className={`tab ${view === 'pk' ? 'active' : ''}`} onClick={() => { setView('pk'); setStatsKey((k) => k + 1); }}>
          胜率 PK
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
        isMobile ? (
          <MobilePractice
            stats={stats}
            view={view}
            onNavigate={navigate}
            drawerOpen={drawerOpen}
            setDrawerOpen={setDrawerOpen}
            popup={popup}
            setPopup={setPopup}
            setAuthOpen={setAuthOpen}
          />
        ) : (
        <main className="practice-layout">
          <section className="chart-area">
            {store.loading ? (
              <div className="view-loading">加载 K 线数据…</div>
            ) : store.bars1h.length === 0 ? (
              <div className="view-loading">选择一个标的开练</div>
            ) : (
              <>
                <MarketHeader
                  symbol={store.symbol}
                  market={store.market}
                  marketLabel={marketLabel}
                  revealed={revealed}
                  period={store.chartPeriod}
                />

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
                    currentPeriod={store.chartPeriod}
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
            {/*
              ⚠️ v6.3 修：把「现在为什么不能开仓」放到**顶部醒目位置**。
              之前只在按钮的 title（要悬停才看得到）和按钮内的一行小字里 ——
              按钮一灰，用户只看到「点不动」，不知道要做什么
              （先平仓？先复盘？先退出回看？）。
            */}
            {!canTrade && tradeDisabledReason && (
              <div className="notice warn trade-block-reason">
                暂时不能开仓：{tradeDisabledReason}
                {tradeDisabledReason === '回看模式，不能开仓' && (
                  <div className="muted">按「单步 ▶」前进回到最远处即可恢复开仓</div>
                )}
                {tradeDisabledReason === '上一笔交易还没复盘' && (
                  <div className="muted">先完成复盘（或点「跳过」留痕）再继续</div>
                )}
                {tradeDisabledReason === '持仓中，先平仓' && (
                  <div className="muted">先平掉当前持仓，再开下一笔</div>
                )}
              </div>
            )}

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
                priceLabel={store.chartPeriod === '15m' ? '当前 15m 价' : '当前 1h 价'}
                equity={store.equity}
                bars1h={store.bars1h}
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

            <AccountPanel
              equity={store.equity}
              equityStart={store.equityStart}
              openTrade={store.openTrade}
              closedTrades={store.closedTrades}
              maxDrawdown={store.maxDrawdown}
              currentPrice={currentPrice}
            />

            <PendingJournal />

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
        )
      )}

      {view === 'stats' && (
        <main className="full-view">
          <StatsView refreshKey={statsKey} />
        </main>
      )}

      {view === 'pk' && (
        <main className="full-view">
          <PkView refreshKey={statsKey} />
        </main>
      )}

      {view === 'setups' && (
        <main className="full-view">
          <SetupLibrary setups={store.setups} onChanged={() => void store.bootstrap()} />
        </main>
      )}

      {store.pendingJournal && (
        <JournalModal
          trade={store.pendingJournal}
          onSave={(p) => void store.saveJournal(p)}
          onSkip={() => void store.skipJournal()}
        />
      )}

      {authOpen && !store.user && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setAuthOpen(false)}>
          <AuthPanel onClose={() => setAuthOpen(false)} />
        </div>
      )}
    </div>
  );
}
