import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Header } from './components/Header';
import { ChartWithOrderbook } from './components/ChartWithOrderbook';
import { OrderFlowHUD } from './components/OrderFlowHUD';
import { FavoritesView } from './components/FavoritesView';
import { SettingsView } from './components/SettingsView';
import { BottomNav, ActiveTab } from './components/BottomNav';
import { Candle, AppSettings, LiquidityTier, MultiCVDState, MultiOBIState, OpportunityCard, OpportunityStats } from './types/market';
import { OrderbookEngine } from './services/orderbookEngine';
import { BinanceWsManager } from './services/binanceWs';
import {
  fetchExchangeInfo,
  fetchKlines,
  fetch24hrTicker,
  fetchOpenInterest,
  fetchFundingRate,
  SymbolMeta,
} from './services/binanceRest';
import { audioAlerts } from './services/audioAlerts';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth, loginWithGoogle, logoutUser } from './services/firebase';
import { fetchUserData, saveUserData } from './services/userSync';

const DEFAULT_SETTINGS: AppSettings = {
  showLadder: false,
  showHeatmap: false,
  showWallRays: true,
  wallPct: 90,
  wallMinAgeSec: 25,
  whaleMinUsdt: 100000,
  autoScaleThresholds: true,
  showMa: true,
  showSar: true,
  showVol: true,
  showBB: false,
  showVwap: true,
  showRsi: false,
  showMacd: false,
  ma1: 9,
  ma2: 21,
  ma3: 50,
  sarStep: 0.02,
  sarMax: 0.2,
  alertSound: true,
  alertSoundVol: 0.5,
  alertVibrate: true,
  alertOnHighFlow: true,
  alertOnOpportunity: true,
  dark: true,
};

export default function App() {
  const [symbol, setSymbol] = useState<string>('ALLOUSDT');
  const [interval, setInterval] = useState<string>('5m');
  const [symbols, setSymbols] = useState<string[]>([
    'ALLOUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'RLCUSDT'
  ]);
  const [metaMap, setMetaMap] = useState<Record<string, SymbolMeta>>({});

  const [candles, setCandles] = useState<Candle[]>([]);
  const [lastPrice, setLastPrice] = useState<number>(0.24499);
  const [priceChangePercent, setPriceChangePercent] = useState<number>(-3.42);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isDepthSynced, setIsDepthSynced] = useState<boolean>(false);
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('orderbook_favs');
      return saved ? JSON.parse(saved) : ['ALLOUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    } catch {
      return ['ALLOUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    }
  });

  const [openInterest, setOpenInterest] = useState<number | null>(null);
  const [fundingRate, setFundingRate] = useState<number | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('chart');
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const saved = localStorage.getItem('orderbook_settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          showLadder: parsed.showLadder ?? false,
          showHeatmap: parsed.showHeatmap ?? false,
        };
      }
      return DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  // Microstructure telemetry states
  const [cvdState, setCvdState] = useState<MultiCVDState>({
    s10: 0, s30: 0, s60: 0, s180: 0, direction: 'FLAT', accelerating: false, allAligned: false,
  });
  const [obiState, setObiState] = useState<MultiOBIState>({
    s5: 0, s15: 0, s30: 0, s60: 0, aligned: 'MIXED', trend: 'FLAT', strength: 0,
  });
  const [marketStatus, setMarketStatus] = useState<
    'NOTR' | 'AL' | 'SAT' | 'SAVUNULDU' | 'SWEEP' | 'ICEBERG' | 'SPOOF' | 'DIVERGENCE'
  >('NOTR');
  const [activeOpportunity, setActiveOpportunity] = useState<OpportunityCard | null>(null);
  const [opportunityStats, setOpportunityStats] = useState<OpportunityStats>({
    total: 0,
    activeCount: 0,
    hitCount: 0,
    stopCount: 0,
    expiredCount: 0,
    cancelledCount: 0,
    resolvedCount: 0,
    winCount: 0,
    lossCount: 0,
    winRate: 0,
    targetHitRate: 0,
    initialEquity: 1000,
    currentEquity: 1000,
    netProfitUsdt: 0,
    equityReturnPct: 0,
    compoundedPnLPct: 0,
    totalR: 0,
    expectancyR: 0,
    maxDrawdownPct: 0,
    equityCurve: [],
    totalPnL: 0,
  });
  const statusTimerRef = useRef<number | null>(null);
  const pillTimerRef = useRef<number | null>(null);
  const lastPriceRef = useRef<number>(0);
  const dismissedOppIdsRef = useRef<Set<string>>(new Set());
  const pinnedOppRef = useRef<{ id: string; until: number } | null>(null);

  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  const handleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    try {
      await loginWithGoogle();
    } catch {
      // Ignored
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Persistent Engine Reference initialized directly with active user settings
  const currentMeta = metaMap[symbol] || { symbol, tickSize: 0.00001, precision: 5 };
  const engine = useMemo(
    () =>
      new OrderbookEngine(symbol, currentMeta.tickSize, currentMeta.precision, {
        wallPct: settings.wallPct,
        wallMinAgeSec: settings.wallMinAgeSec,
        whaleMinUsdt: settings.whaleMinUsdt,
        autoScaleThresholds: settings.autoScaleThresholds,
      }),
    [symbol]
  );
  const wsManagerRef = useRef<BinanceWsManager | null>(null);

  const [tierInfo, setTierInfo] = useState<{
    tier: LiquidityTier;
    whale: number;
    cvd: number;
    burst: number;
    vol24h: number;
  }>(() => ({
    tier: engine.liquidityTier,
    whale: engine.effectiveWhaleMinUsdt,
    cvd: engine.effectiveCvdThreshold,
    burst: engine.effectiveDeltaBurstThreshold,
    vol24h: engine.quoteVolume24h,
  }));

  const syncEngineSettings = (nextSettings: AppSettings) => {
    engine.updateSettings({
      wallPct: nextSettings.wallPct,
      wallMinAgeSec: nextSettings.wallMinAgeSec,
      whaleMinUsdt: nextSettings.whaleMinUsdt,
      autoScaleThresholds: nextSettings.autoScaleThresholds,
    });
    setTierInfo({
      tier: engine.liquidityTier,
      whale: engine.effectiveWhaleMinUsdt,
      cvd: engine.effectiveCvdThreshold,
      burst: engine.effectiveDeltaBurstThreshold,
      vol24h: engine.quoteVolume24h,
    });
  };

  const handleSettingsChange = (nextSettings: AppSettings) => {
    syncEngineSettings(nextSettings);
    setSettings(nextSettings);
  };

  // Keep engine thresholds & wall detection continuously synced with settings
  useEffect(() => {
    syncEngineSettings(settings);
  }, [engine, settings.wallPct, settings.wallMinAgeSec, settings.whaleMinUsdt, settings.autoScaleThresholds]);

  // Monitor Auth state & Load Firestore data on login
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (user) {
        try {
          const cloudData = await fetchUserData(user.uid);
          if (cloudData) {
            if (cloudData.favorites && Array.isArray(cloudData.favorites) && cloudData.favorites.length) {
              setFavorites(cloudData.favorites);
            }
            if (cloudData.settings) {
              setSettings((prev) => ({ ...prev, ...cloudData.settings }));
            }
          } else {
            await saveUserData(user.uid, {
              email: user.email || '',
              displayName: user.displayName || '',
              favorites,
              settings,
            });
          }
        } catch (err) {
          console.warn('Initial cloud sync notice:', err);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Save Settings & Favorites locally and to Firestore
  useEffect(() => {
    try {
      localStorage.setItem('orderbook_settings', JSON.stringify(settings));
    } catch {}
    if (currentUser) {
      saveUserData(currentUser.uid, { settings }).catch(() => {});
    }
  }, [settings, currentUser]);

  useEffect(() => {
    try {
      localStorage.setItem('orderbook_favs', JSON.stringify(favorites));
    } catch {}
    if (currentUser) {
      saveUserData(currentUser.uid, { favorites }).catch(() => {});
    }
  }, [favorites, currentUser]);

  // Load Exchange Info
  useEffect(() => {
    fetchExchangeInfo().then(({ symbols: loadedSymbols, meta }) => {
      setSymbols(loadedSymbols);
      setMetaMap(meta);
      if (meta[symbol]) {
        engine.setSymbolMeta(meta[symbol].tickSize, meta[symbol].precision);
      }
    });
  }, []);

  // Hook Orderbook Engine Events
  useEffect(() => {
    engine.onEventCreated = (ev) => {
      if (ev.type === 'DOM SWEEP') {
        setMarketStatus('SWEEP');
        if (settings.alertSound && settings.alertOnHighFlow) {
          audioAlerts.playSweepAlert(settings.alertSoundVol);
        }
      } else if (ev.type === 'ICEBERG') {
        setMarketStatus('ICEBERG');
        if (settings.alertSound && settings.alertOnHighFlow) {
          audioAlerts.playAbsorptionAlert(settings.alertSoundVol);
        }
      } else if (ev.type === 'DELTA DIVERGENCE') {
        setMarketStatus('DIVERGENCE');
        if (settings.alertSound && settings.alertOnHighFlow) {
          audioAlerts.playBullishChime(settings.alertSoundVol);
        }
      } else if (ev.type === 'SPOOF PULL') {
        setMarketStatus('SPOOF');
      }

      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = window.setTimeout(() => {
        setMarketStatus('NOTR');
      }, 4000);
    };

    engine.onOpportunityCreated = (opp) => {
      if (pillTimerRef.current) clearTimeout(pillTimerRef.current);
      dismissedOppIdsRef.current.delete(opp.id);
      pinnedOppRef.current = null;
      setActiveOpportunity({ ...opp });
      setOpportunityStats(engine.getOpportunityStats());
      if (opp.type === 'VACUUM_SWEEP') {
        setMarketStatus('SWEEP');
      } else if (opp.type === 'ICEBERG_ABSORPTION') {
        setMarketStatus('ICEBERG');
      } else if (opp.type === 'DELTA_DIVERGENCE') {
        setMarketStatus('DIVERGENCE');
      } else {
        setMarketStatus('SAVUNULDU');
      }
      if (settings.alertSound && settings.alertOnOpportunity) {
        opp.bias === 'LONG'
          ? audioAlerts.playBullishChime(settings.alertSoundVol)
          : audioAlerts.playBearishChime(settings.alertSoundVol);
      }
      if (settings.alertVibrate && settings.alertOnOpportunity) {
        audioAlerts.vibrate([80, 50, 80]);
      }

      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = window.setTimeout(() => {
        setMarketStatus('NOTR');
      }, 8000);
    };

    engine.onOpportunityUpdated = (opp) => {
      setOpportunityStats(engine.getOpportunityStats());
      setActiveOpportunity((prev) => {
        if (!prev || prev.id === opp.id) {
          return { ...opp };
        }
        return prev;
      });

      if (settings.alertSound && settings.alertOnOpportunity) {
        if (opp.status === 'HIT_TARGET') {
          audioAlerts.playTargetHit(settings.alertSoundVol);
        } else if (opp.status === 'STOPPED') {
          audioAlerts.playStopLoss(settings.alertSoundVol);
        }
      }
      if (
        settings.alertVibrate &&
        settings.alertOnOpportunity &&
        (opp.status === 'HIT_TARGET' || opp.status === 'STOPPED')
      ) {
        audioAlerts.vibrate([120, 80, 120]);
      }
    };
  }, [engine, settings]);

  // Fetch Klines & switch Kline WS stream when timeframe (interval) or symbol changes
  // (Does NOT reset OrderbookEngine or Depth WebSocket when only interval changes!)
  useEffect(() => {
    let isCancelled = false;
    fetchKlines(symbol, interval, 400).then((data) => {
      if (!isCancelled && data.length) {
        setCandles(data);
        const last = data[data.length - 1];
        lastPriceRef.current = last.close;
        setLastPrice(last.close);
      }
    });
    if (wsManagerRef.current) {
      wsManagerRef.current.setIntervalOnly(interval);
    }
    return () => {
      isCancelled = true;
    };
  }, [symbol, interval]);

  // Load Symbol Data & establish Orderbook + Market WebSocket per symbol
  useEffect(() => {
    let isCancelled = false;

    // Reset Engine & immediately apply active user settings
    lastPriceRef.current = 0;
    pinnedOppRef.current = null;
    engine.reset(symbol);
    setIsDepthSynced(false);
    if (metaMap[symbol]) {
      engine.setSymbolMeta(metaMap[symbol].tickSize, metaMap[symbol].precision);
    }
    syncEngineSettings(settings);
    setActiveOpportunity(null);
    setOpportunityStats(engine.getOpportunityStats());

    // 1. Fetch 24hr stats
    fetch24hrTicker(symbol).then((stats) => {
      if (!isCancelled && stats) {
        if (stats.lastPrice) {
          lastPriceRef.current = stats.lastPrice;
          setLastPrice(stats.lastPrice);
        }
        setPriceChangePercent(stats.priceChangePercent);
        if (stats.quoteVolume > 0) {
          engine.set24hQuoteVolume(stats.quoteVolume);
          setTierInfo({
            tier: engine.liquidityTier,
            whale: engine.effectiveWhaleMinUsdt,
            cvd: engine.effectiveCvdThreshold,
            burst: engine.effectiveDeltaBurstThreshold,
            vol24h: engine.quoteVolume24h,
          });
        }
      }
    });

    // 2. Connect WebSocket first so live depth stream begins buffering incoming updates
    const ws = new BinanceWsManager(symbol, interval, engine);
    wsManagerRef.current = ws;

    ws.onConnectionChange = (conn) => {
      if (!isCancelled) {
        setIsConnected(conn);
        setIsDepthSynced(ws.isDepthConnected && engine.isOrderbookSynced());
      }
    };

    ws.onKlineUpdate = (updatedCandle) => {
      if (isCancelled) return;
      lastPriceRef.current = updatedCandle.close;
      setLastPrice(updatedCandle.close);
      if (engine.isOrderbookSynced()) {
        engine.checkActiveOpportunitiesLifecycle(updatedCandle.close, Date.now(), {
          openTimeMs: updatedCandle.time * 1000,
          high: updatedCandle.high,
          low: updatedCandle.low,
        });
      }
      setCandles((prev) => {
        if (!prev.length) return [updatedCandle];
        const last = prev[prev.length - 1];
        if (last.time === updatedCandle.time) {
          const next = [...prev];
          next[next.length - 1] = updatedCandle;
          return next;
        } else {
          return [...prev.slice(-450), updatedCandle];
        }
      });
    };

    ws.connect();

    // 3. Fetch OI and Funding
    fetchOpenInterest(symbol).then((oi) => {
      if (!isCancelled) setOpenInterest(oi);
    });
    fetchFundingRate(symbol).then((fr) => {
      if (!isCancelled && fr) setFundingRate(fr.rate);
    });

    // Fast telemetry poll loop (every 250ms)
    const telemetryTimer = window.setInterval(() => {
      if (isCancelled) return;
      const now = Date.now();
      const bookSynced = ws.isDepthConnected && engine.isOrderbookSynced();
      setIsDepthSynced(bookSynced);
      if (bookSynced && engine.midPrice > 0) {
        engine.checkActiveOpportunitiesLifecycle(engine.midPrice, now);
      }

      // Synchronize live Active Opportunity Pill state deterministically:
      // 1. If user manually pinned an opportunity from history modal, display it until pin expires
      // 2. Else if an opportunity for this symbol resolved within the last 6.5s, show its resolved outcome badge
      // 3. Else show the latest ACTIVE opportunity for this symbol (with live updated price, PnL%, progress, duration)
      // 4. Else auto-clear the pill to null so resolved/expired pills never hang on screen
      const pinned = pinnedOppRef.current;
      if (pinned && now < pinned.until) {
        const pinnedCard = engine.opportunities.find((o) => o.id === pinned.id);
        if (pinnedCard) {
          setActiveOpportunity({ ...pinnedCard });
        } else {
          pinnedOppRef.current = null;
          setActiveOpportunity(null);
        }
      } else {
        if (pinned) pinnedOppRef.current = null;
        const recentlyResolved = engine.opportunities.find(
          (o) =>
            o.symbol === symbol &&
            o.status !== 'ACTIVE' &&
            o.status !== 'CANCELLED' &&
            !dismissedOppIdsRef.current.has(o.id) &&
            o.resolvedAt !== undefined &&
            now - o.resolvedAt < 6500
        );
        const currentActive = engine.opportunities.find(
          (o) =>
            o.symbol === symbol &&
            o.status === 'ACTIVE' &&
            !dismissedOppIdsRef.current.has(o.id)
        );
        const nextPill = recentlyResolved || currentActive || null;
        setActiveOpportunity(nextPill ? { ...nextPill } : null);
      }

      const cvd = engine.getMultiCVD();
      const obi = engine.getMultiOBI();
      setCvdState(cvd);
      setObiState(obi);
      setOpportunityStats(engine.getOpportunityStats());
      setTierInfo({
        tier: engine.liquidityTier,
        whale: engine.effectiveWhaleMinUsdt,
        cvd: engine.effectiveCvdThreshold,
        burst: engine.effectiveDeltaBurstThreshold,
        vol24h: engine.quoteVolume24h,
      });

      // If no high-priority event is flashing, compute directional pressure
      setMarketStatus((prev) => {
        if (
          prev === 'SAVUNULDU' ||
          prev === 'SWEEP' ||
          prev === 'ICEBERG' ||
          prev === 'SPOOF' ||
          prev === 'DIVERGENCE'
        ) {
          return prev;
        }
        if (obi.aligned === 'BULL' && cvd.direction === 'BULL') return 'AL';
        if (obi.aligned === 'BEAR' && cvd.direction === 'BEAR') return 'SAT';
        return 'NOTR';
      });
    }, 250);

    return () => {
      isCancelled = true;
      clearInterval(telemetryTimer);
      ws.disconnect();
      if (wsManagerRef.current === ws) {
        wsManagerRef.current = null;
      }
    };
  }, [symbol, engine]);

  const handleToggleFavorite = () => {
    setFavorites((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]
    );
  };

  const handleSelectSymbol = (newSym: string) => {
    setSymbol(newSym);
    setActiveTab('chart');
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0d1117] text-[#e6e8ea]">
      {/* Header Bar */}
      <Header
        symbol={symbol}
        symbols={symbols}
        lastPrice={lastPrice}
        priceChangePercent={priceChangePercent}
        isConnected={isConnected}
        isDepthSynced={isDepthSynced}
        isFavorite={favorites.includes(symbol)}
        onSelectSymbol={handleSelectSymbol}
        onToggleFavorite={handleToggleFavorite}
        onOpenSettings={() => setActiveTab('settings')}
        precision={currentMeta.precision}
        user={currentUser}
        onLogin={handleLogin}
        isLoggingIn={isLoggingIn}
      />

      {/* Main View Area */}
      <main className="flex-1 relative pt-13 pb-14 overflow-hidden flex flex-col">
        {/* 1. CHART TAB (Core Focus) */}
        {activeTab === 'chart' && (
          <div className="flex-1 relative flex flex-col overflow-hidden">
            {/* Subheader Market Context Banner with Adaptive Liquidity Tier Badge */}
            <div className="bg-[#161b22] border-b border-[#2a3038] px-3 py-1 text-[11px] text-[#8b949e] flex items-center justify-between font-mono gap-2 overflow-x-auto">
              <div className="flex items-center gap-1.5 truncate">
                <span
                  className={`px-1.5 py-0.2 rounded text-[10px] font-black tracking-wider uppercase border flex-none ${
                    tierInfo.tier === 'MEGA_CAP'
                      ? 'bg-[#e0b64c]/20 text-[#e0b64c] border-[#e0b64c]/50'
                      : tierInfo.tier === 'LARGE_CAP'
                      ? 'bg-[#4c8ce0]/20 text-[#4c8ce0] border-[#4c8ce0]/50'
                      : tierInfo.tier === 'MID_CAP'
                      ? 'bg-[#26a69a]/20 text-[#26a69a] border-[#26a69a]/50'
                      : 'bg-[#b06ce0]/20 text-[#b06ce0] border-[#b06ce0]/50'
                  }`}
                >
                  {tierInfo.tier.replace('_', ' ')}
                </span>
                <span className="truncate">
                  {settings.autoScaleThresholds ? '⚡ Dinamik' : '🛠️ Manuel'}: Balina ${engine.formatCompact(tierInfo.whale)} · CVD ±${engine.formatCompact(tierInfo.cvd)} · Patlama ${engine.formatCompact(tierInfo.burst)}
                </span>
              </div>
              <span className="text-[10px] text-[#8b949e] flex-none hidden sm:inline">
                24s Hacim: ${engine.formatCompact(tierInfo.vol24h || 0)}
              </span>
            </div>

            {/* Timeframe Bar */}
            <div className="bg-[#161b22]/90 border-b border-[#2a3038] px-3 py-1 flex items-center gap-1.5 z-20">
              {['1m', '5m', '15m'].map((tf) => (
                <button
                  key={tf}
                  onClick={() => setInterval(tf)}
                  className={`flex-1 py-1 rounded text-xs font-bold transition-all ${
                    interval === tf
                      ? 'bg-[#4c8ce0] text-white shadow-sm'
                      : 'bg-[#0d1117] text-[#8b949e] hover:text-[#e6e8ea] border border-[#2a3038]'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>

            {/* Candlestick Chart + In-Situ Orderbook / Rays / DOM Ladder / Heatmap */}
            <div className="flex-1 relative overflow-hidden">
              <OrderFlowHUD
                marketStatus={marketStatus}
                isDepthSynced={isDepthSynced}
                activeOpportunity={activeOpportunity}
                opportunityStats={opportunityStats}
                allOpportunities={engine.opportunities}
                onDismissOpportunity={() => {
                  if (activeOpportunity) {
                    dismissedOppIdsRef.current.add(activeOpportunity.id);
                  }
                  pinnedOppRef.current = null;
                  setActiveOpportunity(null);
                }}
                onSelectOpportunity={(opp) => {
                  dismissedOppIdsRef.current.delete(opp.id);
                  pinnedOppRef.current = { id: opp.id, until: Date.now() + 15000 };
                  setActiveOpportunity({ ...opp });
                }}
                onClearHistory={() => {
                  engine.clearOpportunitiesHistory();
                  setOpportunityStats(engine.getOpportunityStats());
                }}
              />

              <ChartWithOrderbook
                candles={candles}
                symbol={symbol}
                engine={engine}
                settings={settings}
                precision={currentMeta.precision}
                tickSize={currentMeta.tickSize}
                activeOpportunity={activeOpportunity}
              />
            </div>
          </div>
        )}

        {/* 2. FAVORITES TAB */}
        {activeTab === 'favorites' && (
          <div className="flex-1 overflow-y-auto">
            <FavoritesView
              favorites={favorites}
              currentSymbol={symbol}
              allSymbols={symbols}
              lastPrice={lastPrice}
              priceChangePercent={priceChangePercent}
              onSelectSymbol={handleSelectSymbol}
              onRemoveFavorite={(s) => setFavorites((prev) => prev.filter((x) => x !== s))}
              onAddFavorite={(s) => setFavorites((prev) => [...prev, s])}
            />
          </div>
        )}

        {/* 3. SETTINGS TAB */}
        {activeTab === 'settings' && (
          <div className="flex-1 overflow-y-auto">
            <SettingsView
              settings={settings}
              onChange={handleSettingsChange}
              onReset={() => handleSettingsChange(DEFAULT_SETTINGS)}
              user={currentUser}
              onLogin={handleLogin}
              onLogout={logoutUser}
              isLoggingIn={isLoggingIn}
              engine={engine}
            />
          </div>
        )}
      </main>

      {/* 3-Tab Bottom Navigation (Grafik, Favoriler, Ayarlar) */}
      <BottomNav
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        favoritesCount={favorites.length}
      />
    </div>
  );
}
