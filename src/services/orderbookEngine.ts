import { AggTrade, FlowEvent, ForceOrder, LiquidityTier, MultiCVDState, MultiOBIState, OpportunityCard, WallRecord } from '../types/market';

export interface HeatmapBin {
  side: 'B' | 'A';
  price: number;
  notional: number;
}

export interface HeatmapFrame {
  t: number; // seconds
  bins: HeatmapBin[];
  maxNotional: number;
}

interface WallTrackingRecord {
  born: number;
  peak: number;
  touches: number;
  traded: number;
  bouncePrice?: number;
  lastSeenTs: number;
  initialQty: number;
  status?: 'active' | 'defended' | 'consumed' | 'pulled';
  statusExpireTs?: number;
  defendedAtTs?: number;
  touchHistory?: { ts: number; price: number; notional: number; side: 'buy' | 'sell' }[];
}

export class OrderbookEngine {
  public symbol: string;
  public tickSize: number = 0.0001;
  public precision: number = 4;

  // Real-time genuine L2 order book (strictly 100% real exchange data, no fake levels)
  public bidsBook = new Map<number, number>();
  public asksBook = new Map<number, number>();
  public bestBid = 0;
  public bestAsk = 0;
  public spread = 0;
  public midPrice = 0;
  public depthReady = false;
  public depthSynced = false;
  public lastUpdateId = 0;

  // Wall tracking
  public walls: WallRecord[] = [];
  public wallAges = new Map<string, WallTrackingRecord>();
  public wallPct = 90;
  public wallMinAgeMs = 25000;
  public whaleMinUsdt = 100000;

  // Adaptive Liquidity Scaling State (BTC vs Altcoins)
  public quoteVolume24h = 0;
  public autoScaleThresholds = true;
  public userWhaleMinUsdt = 100000;
  public effectiveWhaleMinUsdt = 100000;
  public effectiveCvdThreshold = 5000;
  public effectiveDeltaBurstThreshold = 200000;
  public effectiveWallFloor = 15000;
  public effectiveWallMinTraded = 10000;
  public effectiveIcebergMinReplenish = 20000;
  public effectiveIcebergMinTraded = 40000;
  public effectiveIcebergDisplayedFloor = 10000;
  public liquidityTier: LiquidityTier = 'MID_CAP';

  // Swept wall levels buffer (persisted for 6s for visual chart rays and indicators)
  public sweptWallLevels: { price: number; side: 'B' | 'A'; notional: number; ts: number; expireTs: number }[] = [];

  // Multi-tick rapid taker flow sweep detector buffer (trades in last 2s)
  private rollingTrades1s: { ts: number; price: number; notional: number; side: 'buy' | 'sell' }[] = [];
  private lastFlowSweepTs = 0;

  // Rolling 60s price tick history for Order Flow / Delta Divergence
  private priceHistory60s: { ts: number; price: number }[] = [];

  // Liquidity depth profile frames
  public heatmapFrames: HeatmapFrame[] = [];
  private lastHeatSampleTs = 0;

  // Trades & Liquidations
  public trades: AggTrade[] = [];
  public liqs: ForceOrder[] = [];
  public events: FlowEvent[] = [];
  public opportunities: OpportunityCard[] = [];

  // Multi-window CVD (10s, 30s, 60s, 180s)
  private cvdWindows = {
    s10: { ms: 10000, trades: [] as { ts: number; delta: number }[], sum: 0 },
    s30: { ms: 30000, trades: [] as { ts: number; delta: number }[], sum: 0 },
    s60: { ms: 60000, trades: [] as { ts: number; delta: number }[], sum: 0 },
    s180: { ms: 180000, trades: [] as { ts: number; delta: number }[], sum: 0 },
  };

  // Distance-Weighted Multi-window OBI snapshots (5s, 15s, 30s, 60s)
  private obiSnapshots: { ts: number; obi: number }[] = [];

  // Asynchronous depth-vs-aggTrade reconciliation buffer (last 3s executed trades by price)
  private recentTradeVolumeByPrice = new Map<
    string,
    { buyNotional: number; sellNotional: number; lastTs: number }
  >();

  // True Iceberg & Absorption tracking:
  // Tracks actual orderbook replenish additions (delta q > 0) after trades and sliding window absorbed volume
  private icebergTracker = new Map<
    string,
    {
      side: 'B' | 'A';
      price: number;
      lastDisplayedQty: number;
      refillCount: number;
      replenishedQty: number;
      replenishedNotional: number;
      trades: { ts: number; notional: number }[];
      firstTs: number;
      lastTs: number;
      peakDisplayedNotional: number;
    }
  >();

  // Event callbacks
  public onEventCreated?: (event: FlowEvent) => void;
  public onOpportunityCreated?: (opp: OpportunityCard) => void;
  public onOpportunityUpdated?: (opp: OpportunityCard) => void;

  // Standard Binance USDT-M Futures VIP0 Taker fee: 0.05% (5 bps) per leg -> 0.10% (10 bps) round-trip
  private static readonly ROUND_TRIP_TAKER_FEE_PCT = 0.10; // 0.10% (10 bps)
  private static readonly ROUND_TRIP_TAKER_FEE_BPS = 10;
  // Minimum multiple of total execution cost (round-trip commission + half-spread) required for stop distance
  private static readonly MIN_STOP_COST_MULTIPLE = 3.0;

  constructor(
    symbol: string,
    tickSize = 0.0001,
    precision = 4,
    initialSettings?: {
      wallPct?: number;
      wallMinAgeSec?: number;
      whaleMinUsdt?: number;
      autoScaleThresholds?: boolean;
    }
  ) {
    this.symbol = symbol;
    this.tickSize = tickSize;
    this.precision = precision;
    this.loadSavedOpportunities();
    if (initialSettings) {
      this.updateSettings(initialSettings);
    } else {
      this.recalibrateThresholds();
    }
  }

  private loadSavedOpportunities() {
    try {
      const raw = localStorage.getItem('orderbook_opportunities_v2');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const now = Date.now();
        this.opportunities = parsed.slice(0, 60).map((card: OpportunityCard) => {
          const maxDur = card.maxDurationSec || 240;
          const elapsedSec = Math.max(1, Math.round((now - card.timestamp) / 1000));
          if (card.status === 'ACTIVE' && (elapsedSec >= maxDur || card.symbol !== this.symbol)) {
            return {
              ...card,
              status: 'EXPIRED',
              exitPrice: card.currentPrice || card.entryPrice,
              resolvedAt: card.timestamp + maxDur * 1000,
              durationSec: Math.min(elapsedSec, maxDur),
              pnlPct: card.pnlPct ?? -(card.feePct ?? OrderbookEngine.ROUND_TRIP_TAKER_FEE_PCT),
              progressPct: card.progressPct ?? 0,
            };
          }
          return card;
        });
      }
    } catch {
      // Ignore storage errors
    }
  }

  public saveOpportunities() {
    try {
      localStorage.setItem('orderbook_opportunities_v2', JSON.stringify(this.opportunities.slice(0, 60)));
    } catch {
      // Ignore storage errors
    }
  }

  public clearOpportunitiesHistory() {
    this.opportunities = this.opportunities.filter((o) => o.status === 'ACTIVE' && o.symbol === this.symbol);
    this.saveOpportunities();
  }

  public setSymbolMeta(tickSize: number, precision: number) {
    const changed = this.tickSize !== tickSize || this.precision !== precision;
    this.tickSize = tickSize;
    this.precision = precision;
    if (changed && this.depthReady) {
      this.detectWalls();
    }
  }

  public updateSettings(config: {
    wallPct?: number;
    wallMinAgeSec?: number;
    whaleMinUsdt?: number;
    autoScaleThresholds?: boolean;
  }) {
    if (typeof config.wallPct === 'number') {
      this.wallPct = Math.min(99, Math.max(50, config.wallPct));
    }
    if (typeof config.wallMinAgeSec === 'number') {
      this.wallMinAgeMs = Math.max(1000, config.wallMinAgeSec * 1000);
    }
    if (typeof config.autoScaleThresholds === 'boolean') {
      this.autoScaleThresholds = config.autoScaleThresholds;
    }
    if (typeof config.whaleMinUsdt === 'number' && config.whaleMinUsdt > 0) {
      this.userWhaleMinUsdt = config.whaleMinUsdt;
    }
    this.recalibrateThresholds();
    if (this.depthReady) {
      this.detectWalls();
    }
  }

  public set24hQuoteVolume(quoteVolume: number) {
    if (Number.isFinite(quoteVolume) && quoteVolume > 0) {
      this.quoteVolume24h = quoteVolume;
      this.recalibrateThresholds();
      if (this.depthReady) {
        this.detectWalls();
      }
    }
  }

  public recalibrateThresholds() {
    if (!this.autoScaleThresholds) {
      // Manual mode: anchor everything proportionally to user-specified whaleMinUsdt
      const base = this.userWhaleMinUsdt || 100000;
      this.effectiveWhaleMinUsdt = base;
      this.whaleMinUsdt = base;
      this.effectiveCvdThreshold = Math.max(1000, Math.round(base * 0.18));
      this.effectiveDeltaBurstThreshold = Math.round(base * 2.2);
      this.effectiveWallFloor = Math.max(2000, Math.round(base * 0.18));
      this.effectiveWallMinTraded = Math.max(1000, Math.round(base * 0.10));
      this.effectiveIcebergMinReplenish = Math.max(2000, Math.round(base * 0.22));
      this.effectiveIcebergMinTraded = Math.max(4000, Math.round(base * 0.42));
      this.effectiveIcebergDisplayedFloor = Math.max(800, Math.round(base * 0.08));
      return;
    }

    // Auto-Adaptive Mode based on actual 24h quote volume and L2 orderbook depth:
    let depth1Pct = 0;
    const mid = this.midPrice;
    if (mid > 0) {
      for (const [p, q] of this.bidsBook) {
        if ((mid - p) / mid <= 0.01) depth1Pct += p * q;
      }
      for (const [p, q] of this.asksBook) {
        if ((p - mid) / mid <= 0.01) depth1Pct += p * q;
      }
    }

    const vol24h = this.quoteVolume24h;

    // Institutional Liquidity Tier Classification:
    let tier: LiquidityTier = 'MID_CAP';
    let baseWhale = 60000;

    if (vol24h >= 3_000_000_000) {
      // MEGA_CAP: BTC, ETH (> $3 Billion 24h turnover)
      tier = 'MEGA_CAP';
      baseWhale = Math.min(1_500_000, Math.max(400_000, Math.round(vol24h * 0.000025)));
    } else if (vol24h >= 500_000_000) {
      // LARGE_CAP: SOL, DOGE, XRP, BNB ($500M - $3B turnover)
      tier = 'LARGE_CAP';
      baseWhale = Math.min(350_000, Math.max(100_000, Math.round(vol24h * 0.00005)));
    } else if (vol24h >= 80_000_000) {
      // MID_CAP: SUI, NEAR, AVAX, LINK ($80M - $500M turnover)
      tier = 'MID_CAP';
      baseWhale = Math.min(95_000, Math.max(35_000, Math.round(vol24h * 0.00018)));
    } else if (vol24h >= 5_000_000) {
      // SMALL_CAP: ALLO, RLC, HIGH ($5M - $80M turnover)
      tier = 'SMALL_CAP';
      baseWhale = Math.min(32_000, Math.max(12_000, Math.round(vol24h * 0.00045)));
    } else if (vol24h > 0) {
      // MICRO_CAP: Low-liquidity altcoins (< $5M turnover)
      tier = 'MICRO_CAP';
      baseWhale = Math.min(12_000, Math.max(4_000, Math.round(vol24h * 0.0008)));
    } else {
      // Fallback if 24h volume not yet loaded: estimate from L2 book depth
      if (depth1Pct >= 5_000_000) {
        tier = 'MEGA_CAP';
        baseWhale = 500_000;
      } else if (depth1Pct >= 1_000_000) {
        tier = 'LARGE_CAP';
        baseWhale = 150_000;
      } else if (depth1Pct >= 150_000) {
        tier = 'MID_CAP';
        baseWhale = 50_000;
      } else if (depth1Pct >= 25_000) {
        tier = 'SMALL_CAP';
        baseWhale = 16_000;
      } else {
        tier = 'MICRO_CAP';
        baseWhale = 6_000;
      }
    }

    // Book density alignment: Ensure whale threshold is at least 2.5% of visible top 1% book
    if (depth1Pct > 0) {
      const depthWhaleFloor = Math.round(depth1Pct * 0.025);
      baseWhale = Math.max(baseWhale, Math.min(1_500_000, depthWhaleFloor));
    }

    this.liquidityTier = tier;
    this.effectiveWhaleMinUsdt = Math.round(baseWhale);
    this.whaleMinUsdt = this.effectiveWhaleMinUsdt;

    // 1. CVD 30s directional push threshold:
    // Scale proportionally to baseWhale (e.g. BTC whale $600K -> CVD $108K; ALLO whale $15K -> CVD $2.7K)
    this.effectiveCvdThreshold = Math.max(800, Math.min(250_000, Math.round(baseWhale * 0.18)));

    // 2. Delta Burst 60s momentum surge threshold:
    // Scale proportionally (e.g. BTC whale $600K -> $1.32M; ALLO whale $15K -> $33K)
    this.effectiveDeltaBurstThreshold = Math.round(baseWhale * 2.2);

    // 3. Resting Wall Absolute Floor:
    this.effectiveWallFloor = Math.max(1500, Math.round(baseWhale * 0.18));

    // 4. Wall Defense Minimum Traded Volume Absorbed:
    this.effectiveWallMinTraded = Math.max(1000, Math.round(baseWhale * 0.10));

    // 5. True Iceberg Minimum Replenished Depth & Absorbed Window:
    this.effectiveIcebergMinReplenish = Math.max(2000, Math.round(baseWhale * 0.22));
    this.effectiveIcebergMinTraded = Math.max(3500, Math.round(baseWhale * 0.42));
    this.effectiveIcebergDisplayedFloor = Math.max(800, Math.round(baseWhale * 0.07));
  }

  public reset(newSymbol?: string) {
    if (newSymbol) this.symbol = newSymbol;
    this.bidsBook.clear();
    this.asksBook.clear();
    this.bestBid = 0;
    this.bestAsk = 0;
    this.spread = 0;
    this.midPrice = 0;
    this.depthReady = false;
    this.depthSynced = false;
    this.isSnapshotLoaded = false;
    this.hasBridgedFirstEvent = false;
    this.pendingDepthEvents = [];
    this.lastUpdateId = 0;
    this.walls = [];
    this.wallAges.clear();
    this.heatmapFrames = [];
    this.trades = [];
    this.liqs = [];
    this.events = [];
    // Preserve resolved opportunities for win-rate analytics; expire any active cards from a previous symbol
    this.loadSavedOpportunities();
    const now = Date.now();
    for (const card of this.opportunities) {
      if (card.status === 'ACTIVE' && card.symbol !== this.symbol) {
        card.status = 'EXPIRED';
        card.exitPrice = card.currentPrice || card.entryPrice;
        card.resolvedAt = now;
        card.durationSec = Math.max(1, Math.round((now - card.timestamp) / 1000));
        card.pnlPct = card.pnlPct ?? 0;
      }
    }
    this.saveOpportunities();
    this.obiSnapshots = [];
    this.icebergTracker.clear();
    this.recentTradeVolumeByPrice.clear();
    this.sweptWallLevels = [];
    this.rollingTrades1s = [];
    this.lastFlowSweepTs = 0;
    this.quoteVolume24h = 0;
    this.recalibrateThresholds();
    for (const w of Object.values(this.cvdWindows)) {
      w.trades = [];
      w.sum = 0;
    }
  }

  // Binance Depth Syncing Buffer & Sequence State
  private pendingDepthEvents: Array<{
    b: [string | number, string | number][];
    a: [string | number, string | number][];
    U: number;
    u: number;
    pu: number;
  }> = [];
  public isSnapshotLoaded = false;
  public hasBridgedFirstEvent = false;
  public lastSyncTs = 0;

  // Prepare engine to buffer incoming WS depth updates before/during snapshot fetch
  public beginDepthSync(clearBuffer = false) {
    this.isSnapshotLoaded = false;
    this.depthSynced = false;
    this.hasBridgedFirstEvent = false;
    if (clearBuffer) {
      this.pendingDepthEvents = [];
    }
  }

  public hasBufferedDepthEvents(): boolean {
    return this.pendingDepthEvents.length > 0;
  }

  // Load genuine depth snapshot from Binance REST (up to 1000 levels) and reconcile with buffered WS stream
  public applySnapshot(bids: [number, number][], asks: [number, number][], lastUpdateId: number): boolean {
    if (!lastUpdateId || (!bids.length && !asks.length)) {
      return false;
    }

    // Sort buffered events chronologically by final update ID (u)
    if (this.pendingDepthEvents.length > 1) {
      this.pendingDepthEvents.sort((a, b) => a.u - b.u);
    }

    // Drop buffered events that are already included in or older than the snapshot (u <= lastUpdateId)
    const postSnapEvents = this.pendingDepthEvents.filter((ev) => ev.u > lastUpdateId);

    // Check if the snapshot is OLDER than our earliest buffered WS event (unbridgeable gap)
    if (postSnapEvents.length > 0) {
      const firstEv = postSnapEvents[0];
      const snapshotTooOld = firstEv.U > lastUpdateId + 1 && firstEv.pu > lastUpdateId;
      if (snapshotTooOld) {
        console.warn(
          `[OrderbookEngine] Snapshot (${lastUpdateId}) is older than earliest buffered WS event (U=${firstEv.U}, pu=${firstEv.pu}). Retrying snapshot...`
        );
        // Keep buffering and signal caller to fetch a fresher snapshot
        this.pendingDepthEvents = postSnapEvents;
        this.isSnapshotLoaded = false;
        this.depthSynced = false;
        this.hasBridgedFirstEvent = false;
        return false;
      }
    }

    const now = Date.now();
    this.bidsBook.clear();
    this.asksBook.clear();
    const activeKeys = new Set<string>();

    for (const [p, q] of bids) {
      if (q > 0 && Number.isFinite(p) && p > 0) {
        this.bidsBook.set(p, q);
        const key = `B|${p}`;
        activeKeys.add(key);
        const existing = this.wallAges.get(key);
        if (existing) {
          existing.peak = Math.max(existing.peak, p * q);
          existing.lastSeenTs = now;
        } else {
          this.wallAges.set(key, {
            born: now,
            peak: p * q,
            touches: 0,
            traded: 0,
            lastSeenTs: now,
            initialQty: q,
          });
        }
      }
    }
    for (const [p, q] of asks) {
      if (q > 0 && Number.isFinite(p) && p > 0) {
        this.asksBook.set(p, q);
        const key = `A|${p}`;
        activeKeys.add(key);
        const existing = this.wallAges.get(key);
        if (existing) {
          existing.peak = Math.max(existing.peak, p * q);
          existing.lastSeenTs = now;
        } else {
          this.wallAges.set(key, {
            born: now,
            peak: p * q,
            touches: 0,
            traded: 0,
            lastSeenTs: now,
            initialQty: q,
          });
        }
      }
    }

    // Prune wallAges entries that no longer exist in the fresh snapshot
    for (const key of this.wallAges.keys()) {
      if (!activeKeys.has(key)) {
        this.wallAges.delete(key);
      }
    }

    this.lastUpdateId = lastUpdateId;
    this.isSnapshotLoaded = true;
    this.hasBridgedFirstEvent = false;

    // Replay all post-snapshot buffered events in exact sequence
    for (let i = 0; i < postSnapEvents.length; i++) {
      const ev = postSnapEvents[i];
      if (ev.u <= this.lastUpdateId) continue;

      if (!this.hasBridgedFirstEvent) {
        // First event after snapshot: must overlap [U, u] with lastUpdateId or have pu <= lastUpdateId
        if (ev.U <= this.lastUpdateId + 1 || ev.pu <= this.lastUpdateId) {
          this.executeRawDepthUpdate(ev.b, ev.a, ev.u, false);
          this.hasBridgedFirstEvent = true;
        } else {
          console.warn(
            `[OrderbookEngine] Bridge mismatch in buffer: ev.U=${ev.U}, ev.pu=${ev.pu}, lastUpdateId=${this.lastUpdateId}`
          );
          this.pendingDepthEvents = postSnapEvents.slice(i);
          this.isSnapshotLoaded = false;
          this.depthSynced = false;
          return false;
        }
      } else {
        // Subsequent buffered events: verify sequence continuity
        if (ev.pu === this.lastUpdateId || ev.U <= this.lastUpdateId + 1) {
          this.executeRawDepthUpdate(ev.b, ev.a, ev.u, false);
        } else {
          console.warn(
            `[OrderbookEngine] Sequence gap inside buffered events: ev.pu=${ev.pu} != lastUpdateId=${this.lastUpdateId}`
          );
          this.pendingDepthEvents = postSnapEvents.slice(i);
          this.isSnapshotLoaded = false;
          this.depthSynced = false;
          this.hasBridgedFirstEvent = false;
          return false;
        }
      }
    }

    this.pendingDepthEvents = [];
    this.depthSynced = true;
    this.depthReady = true;
    this.lastSyncTs = now;
    this.recomputeBest();
    this.recalibrateThresholds();
    this.recordDistanceWeightedObi();
    this.detectWalls();
    this.sampleHeatmap(true);
    return true;
  }

  // Receive live depth update from WebSocket
  public applyDepthUpdate(
    bids: [string | number, string | number][],
    asks: [string | number, string | number][],
    u?: number,
    U?: number,
    pu?: number
  ) {
    if (!u) return;

    // If snapshot is not loaded or currently resyncing, buffer all incoming WS depth updates
    if (!this.isSnapshotLoaded) {
      this.pendingDepthEvents.push({
        b: bids,
        a: asks,
        U: U ?? u,
        u,
        pu: pu ?? u - 1,
      });
      if (this.pendingDepthEvents.length > 1000) {
        this.pendingDepthEvents.shift();
      }
      return;
    }

    // Official Binance rule: Ignore any event where u <= lastUpdateId
    if (u <= this.lastUpdateId) {
      return;
    }

    const firstU = U ?? u;
    const prevU = pu ?? u - 1;

    // If snapshot was loaded at the tip of the stream and we are waiting for the first live bridging event:
    if (!this.hasBridgedFirstEvent) {
      if (firstU <= this.lastUpdateId + 1 || prevU <= this.lastUpdateId) {
        this.hasBridgedFirstEvent = true;
        this.depthSynced = true;
        this.executeRawDepthUpdate(bids, asks, u, true);
      } else {
        // Snapshot was stale relative to the first arriving live event -> buffer and re-sync immediately
        this.triggerSequenceResync(bids, asks, u, firstU, prevU);
      }
      return;
    }

    // Continuous sequence verification: in Binance Futures stream, pu must equal previous u (or U <= lastUpdateId + 1)
    if (pu !== undefined && pu !== this.lastUpdateId && firstU > this.lastUpdateId + 1) {
      if (pu > this.lastUpdateId) {
        this.triggerSequenceResync(bids, asks, u, firstU, prevU);
        return;
      }
    }

    this.executeRawDepthUpdate(bids, asks, u, true);
  }

  private triggerSequenceResync(
    bids: [string | number, string | number][],
    asks: [string | number, string | number][],
    u: number,
    U: number,
    pu: number
  ) {
    console.warn(
      `[OrderbookEngine] Packet loss / gap detected: pu (${pu}) > lastUpdateId (${this.lastUpdateId}). Buffering & resyncing snapshot...`
    );
    this.isSnapshotLoaded = false;
    this.depthSynced = false;
    this.hasBridgedFirstEvent = false;
    this.pendingDepthEvents = [
      {
        b: bids,
        a: asks,
        U,
        u,
        pu,
      },
    ];
    if (this.onRequestSnapshot) {
      this.onRequestSnapshot();
    }
  }

  // Callback to trigger re-fetch of snapshot when sequence breaks
  public onRequestSnapshot?: () => void;

  private executeRawDepthUpdate(
    bids: [string | number, string | number][],
    asks: [string | number, string | number][],
    u: number,
    recompute = true
  ) {
    const now = Date.now();

    const processSide = (
      book: Map<number, number>,
      items: [string | number, string | number][],
      side: 'B' | 'A'
    ) => {
      for (const [priceRaw, qtyRaw] of items) {
        const p = typeof priceRaw === 'number' ? priceRaw : parseFloat(priceRaw);
        const q = typeof qtyRaw === 'number' ? qtyRaw : parseFloat(qtyRaw);
        if (!Number.isFinite(p) || p <= 0) continue;

        const oldQ = book.get(p) || 0;
        const oldNotional = p * oldQ;
        const key = `${side}|${p}`;

        if (q <= 0) {
          if (oldQ > 0) {
            book.delete(p);
            // Check for Wall Sweep vs Spoof Pull
            const ageRec = this.wallAges.get(key);
            const peakNotional = Math.max(oldNotional, ageRec?.peak || 0);

            if (ageRec && peakNotional >= this.effectiveWallFloor) {
              const tradedOnRec = ageRec.traded || 0;
              // Check trade volume matching this price level within tick tolerance
              let recentMatchingTrade = 0;
              const tol = Math.max(this.tickSize * 1.5, p * 0.0002);
              for (const [pk, rt] of this.recentTradeVolumeByPrice) {
                const tradeP = parseFloat(pk);
                if (Math.abs(tradeP - p) <= tol) {
                  recentMatchingTrade += side === 'B' ? rt.sellNotional : rt.buyNotional;
                }
              }
              const totalExecutedAtLevel = tradedOnRec + recentMatchingTrade;

              // Level was swept if traded volume at the level is significant
              const isSweptByTrades =
                totalExecutedAtLevel >= Math.min(peakNotional * 0.15, this.effectiveWallMinTraded);

              if (isSweptByTrades) {
                const sweepTakerSide = side === 'B' ? 'sell' : 'buy';
                this.sweptWallLevels.push({
                  price: p,
                  side,
                  notional: peakNotional,
                  ts: now,
                  expireTs: now + 8000,
                });
                if (this.sweptWallLevels.length > 20) this.sweptWallLevels.shift();

                this.addEvent({
                  id: `sweep-wall-${now}-${p}`,
                  type: 'DOM SWEEP',
                  severity: peakNotional >= this.effectiveWhaleMinUsdt ? 'high' : 'medium',
                  text: `⚡ DOM SWEEP: ${side === 'B' ? 'BİD (Destek)' : 'ASK (Direnç)'} Duvarı Süpürüldü @ ${p} ($${this.formatCompact(peakNotional)} temizlendi, $${this.formatCompact(totalExecutedAtLevel)} emildi)`,
                  side: sweepTakerSide,
                  price: p,
                  ts: now,
                });

                this.generateVacuumSweepOpportunity(side, p, peakNotional, totalExecutedAtLevel);
              } else {
                // Check for Spoof Pull: Large order cancelled when price was in close proximity without executions
                const mid = this.midPrice || p;
                const distancePct = Math.abs(p - mid) / mid;
                const ageSec = (now - ageRec.born) / 1000;

                if (
                  peakNotional >= this.effectiveWhaleMinUsdt * 0.35 &&
                  distancePct <= 0.0035 &&
                  ageSec >= 2.0 &&
                  totalExecutedAtLevel < peakNotional * 0.15
                ) {
                  this.addEvent({
                    id: `spoof-${now}-${p}`,
                    type: 'SPOOF PULL',
                    severity: peakNotional >= this.effectiveWhaleMinUsdt ? 'high' : 'medium',
                    text: `Çekilen Duvar (Spoof İptal): ${side === 'B' ? 'BİD' : 'ASK'} $${this.formatCompact(
                      peakNotional
                    )} @ ${p} (Mesafe: ${(distancePct * 100).toFixed(2)}%, ${ageSec.toFixed(1)}s tahtada kaldı)`,
                    price: p,
                    ts: now,
                  });
                }
              }
            }
            this.wallAges.delete(key);
          }
        } else {
          const deltaQty = q - oldQ;
          book.set(p, q);
          const notional = p * q;

          // True Iceberg Replenishment Tracking:
          // If limit quantity at this active level increased (deltaQty > 0), record genuine order replenishment!
          const activeIceberg = this.icebergTracker.get(key);
          if (activeIceberg) {
            if (deltaQty > 0) {
              const deltaNotional = p * deltaQty;
              // Minimum replenishment threshold proportional to coin tier
              if (deltaNotional >= Math.max(1000, this.effectiveIcebergMinReplenish * 0.15)) {
                activeIceberg.refillCount++;
                activeIceberg.replenishedQty += deltaQty;
                activeIceberg.replenishedNotional += deltaNotional;
              }
            }
            activeIceberg.lastDisplayedQty = q;
            activeIceberg.peakDisplayedNotional = Math.max(activeIceberg.peakDisplayedNotional, notional);
          }

          if (!this.wallAges.has(key)) {
            this.wallAges.set(key, {
              born: now,
              peak: notional,
              touches: 0,
              traded: 0,
              lastSeenTs: now,
              initialQty: q,
            });
          } else {
            const rec = this.wallAges.get(key)!;
            // If this price level previously held only minor dust (< 35% of wall floor) and suddenly jumped to a real wall,
            // reset its born timestamp & peak so a newly placed spoof wall on an old dust level doesn't inherit a fake old age.
            if (oldNotional < this.effectiveWallFloor * 0.35 && notional >= this.effectiveWallFloor) {
              rec.born = now;
              rec.peak = notional;
              rec.initialQty = q;
              rec.status = 'active';
              rec.statusExpireTs = undefined;
            } else if (notional >= this.effectiveWallFloor * 0.5) {
              rec.peak = Math.max(rec.peak, notional);
            }
            rec.lastSeenTs = now;
          }
        }
      }
    };

    processSide(this.bidsBook, bids, 'B');
    processSide(this.asksBook, asks, 'A');

    if (u) this.lastUpdateId = u;
    if (recompute) {
      this.recomputeBest();
      this.recordDistanceWeightedObi();
      this.detectWalls();
      this.sampleHeatmap();
    }
  }

  // Handle incoming aggTrade
  public onAggTrade(trade: AggTrade) {
    this.trades.push(trade);
    const now = trade.ts;

    // Prune old trades (> 10 min)
    const cutoff = now - 600000;
    while (this.trades.length && this.trades[0].ts < cutoff) {
      this.trades.shift();
    }

    // Update CVD multi-windows
    const delta = trade.side === 'buy' ? trade.notional : -trade.notional;
    for (const w of Object.values(this.cvdWindows)) {
      w.trades.push({ ts: now, delta });
      w.sum += delta;
      while (w.trades.length && w.trades[0].ts < now - w.ms) {
        w.sum -= w.trades.shift()!.delta;
      }
    }

    // Record into short-lived trade buffer for async depth vs trade reconciliation
    const priceKey = trade.price.toFixed(this.precision);
    let recTrade = this.recentTradeVolumeByPrice.get(priceKey);
    if (!recTrade) {
      recTrade = { buyNotional: 0, sellNotional: 0, lastTs: now };
      this.recentTradeVolumeByPrice.set(priceKey, recTrade);
    }
    if (trade.side === 'buy') recTrade.buyNotional += trade.notional;
    else recTrade.sellNotional += trade.notional;
    recTrade.lastTs = now;

    // Prune trade buffer older than 3500ms
    const tradeWindowCutoff = now - 3500;
    for (const [pk, rt] of this.recentTradeVolumeByPrice) {
      if (rt.lastTs < tradeWindowCutoff) {
        this.recentTradeVolumeByPrice.delete(pk);
      }
    }

    // Quantitative execution tracking against ALL resting depth levels in book (single source of truth, no double-counting)
    // Taker sell matches against resting Bids; taker buy matches against resting Asks
    const matchSide = trade.side === 'sell' ? 'B' : 'A';
    const exactWallKey = `${matchSide}|${trade.price}`;
    let matchRec = this.wallAges.get(exactWallKey);
    const tol = this.tickSize * 1.5;
    if (!matchRec) {
      let bestDist = Infinity;
      for (const [wKey, wRec] of this.wallAges) {
        if (wKey.startsWith(matchSide + '|')) {
          const wPrice = parseFloat(wKey.slice(2));
          const dist = Math.abs(wPrice - trade.price);
          if (dist <= tol && dist < bestDist) {
            bestDist = dist;
            matchRec = wRec;
          }
        }
      }
    }
    if (matchRec) {
      matchRec.lastSeenTs = now;
      if (!matchRec.touchHistory) matchRec.touchHistory = [];
      matchRec.touchHistory.push({
        ts: now,
        price: trade.price,
        notional: trade.notional,
        side: trade.side,
      });
      matchRec.touchHistory = matchRec.touchHistory.filter((t) => now - t.ts <= 30000);
      matchRec.touches = matchRec.touchHistory.length;
      matchRec.traded = matchRec.touchHistory.reduce((acc, t) => acc + t.notional, 0);
    }

    // Quantitative execution verification & defense/sweep check for prominent walls
    this.verifyWallExecution(trade);

    // True Iceberg & Absorption tracking
    this.checkIcebergAbsorption(trade);

    // Institutional Whale Alert Check (Calibrated to coin liquidity tier)
    if (trade.notional >= this.effectiveWhaleMinUsdt) {
      this.addEvent({
        id: `whale-${now}-${trade.price}`,
        type: 'WHALE',
        severity: trade.notional >= this.effectiveWhaleMinUsdt * 2.5 ? 'high' : 'medium',
        text: `Kurumsal Emir (Whale): ${trade.side.toUpperCase()} $${this.formatCompact(
          trade.notional
        )} @ ${trade.price}`,
        side: trade.side,
        price: trade.price,
        ts: now,
      });
    }

    // Multi-Tick Aggressive DOM Sweep Detection
    this.rollingTrades1s.push({ ts: now, price: trade.price, notional: trade.notional, side: trade.side });
    const cutoff2s = now - 2000;
    while (this.rollingTrades1s.length && this.rollingTrades1s[0].ts < cutoff2s) {
      this.rollingTrades1s.shift();
    }
    this.checkFlowSweep(now, trade);

    // Delta Burst & Delta Divergence Detection
    this.recordPriceTick(trade.price, now);
    this.checkDeltaBurst(now);
    this.checkDeltaDivergence(now);

    // Continuous real-time Opportunity Card Lifecycle & PnL evaluation
    this.checkActiveOpportunitiesLifecycle(trade.price, now);
  }

  // Multi-Tick Aggressive DOM Sweep Detector:
  // Detects when market taker orders aggressively sweep through price levels or burst liquidity in < 2000ms
  private checkFlowSweep(now: number, currentTrade: AggTrade) {
    if (now - this.lastFlowSweepTs < 3500) return; // 3.5s throttle between rapid flow alerts

    const sameSideTrades = this.rollingTrades1s.filter((t) => t.side === currentTrade.side);
    if (sameSideTrades.length < 2) return;

    const prices = Array.from(new Set(sameSideTrades.map((t) => t.price))).sort((a, b) => a - b);
    const priceSpan = prices.length >= 2 ? Math.abs(prices[prices.length - 1] - prices[0]) : 0;
    const totalSweptNotional = sameSideTrades.reduce((sum, t) => sum + t.notional, 0);

    const minSweepNotional = Math.max(2000, Math.round(this.effectiveWhaleMinUsdt * 0.25));
    const multiTickSweep = prices.length >= 2 && priceSpan >= this.tickSize * 1.2 && totalSweptNotional >= minSweepNotional;
    const volumeBurstSweep = totalSweptNotional >= this.effectiveWhaleMinUsdt * 0.6;

    if (multiTickSweep || volumeBurstSweep) {
      this.lastFlowSweepTs = now;
      this.addEvent({
        id: `sweep-flow-${now}-${currentTrade.price}`,
        type: 'DOM SWEEP',
        severity: totalSweptNotional >= this.effectiveWhaleMinUsdt ? 'high' : 'medium',
        text: `⚡ DOM SWEEP: ${currentTrade.side === 'buy' ? 'ALIŞ' : 'SATIŞ'} Süpürmesi! ${prices.length > 1 ? `${prices.length} kademe delindi` : 'agresif süpürme'} ($${this.formatCompact(totalSweptNotional)} @ ${currentTrade.price})`,
        side: currentTrade.side,
        price: currentTrade.price,
        ts: now,
      });

      this.generateVacuumSweepOpportunity(
        currentTrade.side === 'buy' ? 'A' : 'B',
        currentTrade.price,
        totalSweptNotional,
        totalSweptNotional
      );
    }
  }


  // Handle liquidation
  public onForceOrder(liq: ForceOrder) {
    this.liqs.push(liq);
    if (this.liqs.length > 500) this.liqs.shift();

    const minLiqNotional = Math.max(2000, Math.round(this.effectiveWhaleMinUsdt * 0.35));
    const highLiqNotional = Math.round(this.effectiveWhaleMinUsdt * 1.5);

    if (liq.notional >= minLiqNotional) {
      this.addEvent({
        id: `liq-${liq.ts}-${liq.price}`,
        type: 'DELTA BURST',
        severity: liq.notional >= highLiqNotional ? 'high' : 'medium',
        text: `Likidasyon Patlaması: ${liq.side === 'SELL' ? 'Long' : 'Short'} Liq $${this.formatCompact(
          liq.notional
        )} @ ${liq.price}`,
        price: liq.price,
        ts: liq.ts,
      });
    }
  }

  // Fast computation of best bid, best ask, spread, and midPrice
  private recomputeBest() {
    let bb = 0;
    let ba = Infinity;

    for (const p of this.bidsBook.keys()) {
      if (p > bb) bb = p;
    }
    for (const p of this.asksBook.keys()) {
      if (p < ba) ba = p;
    }

    this.bestBid = bb;
    this.bestAsk = isFinite(ba) ? ba : 0;

    if (this.bestBid > 0 && this.bestAsk > 0) {
      if (this.bestAsk > this.bestBid) {
        this.spread = this.bestAsk - this.bestBid;
        this.midPrice = (this.bestBid + this.bestAsk) / 2;
      } else {
        // Crossed book anomaly (bestBid >= bestAsk): immediately trigger clean snapshot resync
        console.warn(
          `[OrderbookEngine] Crossed book detected (bestBid=${this.bestBid} >= bestAsk=${this.bestAsk}). Requesting snapshot resync...`
        );
        this.spread = 0;
        this.midPrice = (this.bestBid + this.bestAsk) / 2;
        if (this.isSnapshotLoaded && this.onRequestSnapshot) {
          this.beginDepthSync(true);
          this.onRequestSnapshot();
          return;
        }
      }
    } else {
      this.spread = 0;
      this.midPrice = this.bestBid || this.bestAsk || 0;
    }

    if (this.midPrice > 0) {
      this.checkActiveOpportunitiesLifecycle(this.midPrice);
    }
  }


  // Adaptive Quantitative Wall Detection (Percentile + Absolute Institutional Floor + Age Tracking)
  public detectWalls() {
    if (!this.bestBid || !this.bestAsk || !this.midPrice) {
      this.walls = [];
      return;
    }

    const now = Date.now();
    const mid = this.midPrice;
    const bandRange = mid * 0.05; // 5.0% scalping band around price
    const notionalList: number[] = [];
    const candidates: { price: number; side: 'B' | 'A'; notional: number }[] = [];

    // Filter within visible scalping band
    for (const [p, q] of this.bidsBook) {
      if (Math.abs(p - mid) <= bandRange) {
        const notional = p * q;
        notionalList.push(notional);
        candidates.push({ price: p, side: 'B', notional });
      }
    }
    for (const [p, q] of this.asksBook) {
      if (Math.abs(p - mid) <= bandRange) {
        const notional = p * q;
        notionalList.push(notional);
        candidates.push({ price: p, side: 'A', notional });
      }
    }

    if (!notionalList.length) {
      this.walls = [];
      return;
    }

    // Quantitative percentile threshold with dynamic absolute institutional floor
    notionalList.sort((a, b) => a - b);
    const pIndex = Math.floor(notionalList.length * (this.wallPct / 100));
    const percentileThreshold = notionalList[Math.min(notionalList.length - 1, pIndex)] || 10000;
    
    // Adaptive absolute floor: calibrated to coin liquidity tier
    const absoluteFloor = this.effectiveWallFloor;
    const threshold = Math.max(percentileThreshold, absoluteFloor);

    const detected: WallRecord[] = [];
    for (const c of candidates) {
      const key = `${c.side}|${c.price}`;
      const existingRec = this.wallAges.get(key);

      // Keep defended or actively-tested walls visible even if absorbing trades slightly lowered their percentile rank
      const isPersistedDefended =
        existingRec?.status === 'defended' &&
        existingRec.statusExpireTs !== undefined &&
        now < existingRec.statusExpireTs &&
        c.notional >= this.effectiveWallFloor * 0.65;

      const isActivelyTestedWall =
        existingRec !== undefined &&
        (existingRec.touches || 0) >= 2 &&
        (existingRec.traded || 0) >= this.effectiveWallMinTraded &&
        c.notional >= this.effectiveWallFloor &&
        c.notional >= (existingRec.peak || c.notional) * 0.55;

      if (c.notional >= threshold || isPersistedDefended || isActivelyTestedWall) {
        let ageRec = existingRec;
        if (!ageRec) {
          ageRec = {
            born: now,
            peak: c.notional,
            touches: 0,
            traded: 0,
            lastSeenTs: now,
            initialQty: c.notional / c.price,
            touchHistory: [],
          };
          this.wallAges.set(key, ageRec);
        } else {
          ageRec.peak = Math.max(ageRec.peak, c.notional);
          ageRec.lastSeenTs = now;
        }

        // Rolling 30s window touch pruning
        if (ageRec.touchHistory && ageRec.touchHistory.length) {
          ageRec.touchHistory = ageRec.touchHistory.filter((t) => now - t.ts <= 30000);
          ageRec.touches = ageRec.touchHistory.length;
          ageRec.traded = ageRec.touchHistory.reduce((acc, t) => acc + t.notional, 0);
        } else {
          ageRec.touches = 0;
          ageRec.traded = 0;
        }

        // Preserve existing status within TTL instead of resetting to 'active' on every 100ms depth update
        let status: 'active' | 'defended' | 'consumed' | 'pulled' = 'active';
        if (ageRec.status === 'defended') {
          if (ageRec.statusExpireTs && now < ageRec.statusExpireTs) {
            status = 'defended';
          } else {
            ageRec.status = 'active';
            ageRec.statusExpireTs = undefined;
          }
        } else if (ageRec.status === 'consumed' || ageRec.status === 'pulled') {
          if (ageRec.statusExpireTs && now < ageRec.statusExpireTs) {
            status = ageRec.status;
          } else {
            ageRec.status = 'active';
            ageRec.statusExpireTs = undefined;
          }
        }

        const lastTouch = ageRec.touchHistory?.length
          ? ageRec.touchHistory[ageRec.touchHistory.length - 1].ts
          : 0;

        const wallRecord: WallRecord = {
          price: c.price,
          side: c.side,
          notional: c.notional,
          peakNotional: ageRec.peak,
          bornTs: ageRec.born,
          lastTouchTs: lastTouch,
          touchCount: ageRec.touches,
          tradedNotional: ageRec.traded,
          status,
          label: '',
        };

        // Evaluate whether this wall just completed a defense bounce or was breached on this depth update
        this.evaluateWallState(wallRecord, ageRec, now);

        const ageMs = now - ageRec.born;
        const isEstablished = ageMs >= this.wallMinAgeMs;
        if (wallRecord.status === 'defended') {
          wallRecord.label = `🛡️ SAVUNULDU $${this.formatCompact(c.notional)}`;
        } else if (wallRecord.status === 'consumed') {
          wallRecord.label = `⚡ SWEEP $${this.formatCompact(c.notional)}`;
        } else {
          const touchBadge = wallRecord.touchCount > 0 ? ` [${wallRecord.touchCount}×]` : '';
          wallRecord.label = `$${this.formatCompact(c.notional)}${isEstablished ? ' ⏱' : ''}${touchBadge}`;
        }

        detected.push(wallRecord);
      }
    }

    // Sort so defended walls stay pinned at top priority, then by largest notional
    detected.sort((a, b) => {
      if (a.status === 'defended' && b.status !== 'defended') return -1;
      if (b.status === 'defended' && a.status !== 'defended') return 1;
      return b.notional - a.notional;
    });
    this.walls = detected.slice(0, 24);
  }

  // Unified evaluation of wall breach (consumed) vs absorption bounce (defended)
  // Called both during 100ms depth updates and on incoming aggTrades so status is never missed or reset
  private evaluateWallState(wall: WallRecord, rec: WallTrackingRecord, now: number, trade?: AggTrade) {
    const isBid = wall.side === 'B';
    const tolerance = this.tickSize * 1.5;

    // 1. SWEEP / LEVEL BREACH CHECK:
    // Did price or best quote break through the wall level?
    const breachedByBook = isBid
      ? this.bestBid > 0 && this.bestBid < wall.price - tolerance
      : this.bestAsk > 0 && this.bestAsk > wall.price + tolerance;
    const breachedByTrade = trade
      ? isBid
        ? trade.side === 'sell' && trade.price < wall.price - tolerance
        : trade.side === 'buy' && trade.price > wall.price + tolerance
      : false;

    if (breachedByBook || breachedByTrade) {
      const priorTraded = rec.traded || 0;
      rec.status = 'consumed';
      rec.statusExpireTs = now + 8000;
      wall.status = 'consumed';
      rec.touchHistory = [];
      rec.touches = 0;
      rec.traded = 0;
      wall.touchCount = 0;
      wall.tradedNotional = 0;

      if (trade) {
        const minSweepNotional = Math.max(2000, Math.round(this.effectiveWhaleMinUsdt * 0.25));
        const sweptNotional = Math.max(priorTraded, trade.notional);
        if (sweptNotional >= minSweepNotional) {
          const lastSweep = this.events.find((e) => e.type === 'DOM SWEEP' && now - e.ts < 10000);
          if (!lastSweep) {
            this.addEvent({
              id: `sweep-${now}-${trade.price}`,
              type: 'DOM SWEEP',
              severity: sweptNotional >= this.effectiveWhaleMinUsdt ? 'high' : 'medium',
              text: `⚡ DOM SWEEP: ${isBid ? 'BİD' : 'ASK'} Duvarı Süpürüldü @ ${wall.price} ($${this.formatCompact(sweptNotional)})`,
              side: trade.side,
              price: trade.price,
              ts: now,
            });
          }
          this.generateVacuumSweepOpportunity(isBid ? 'B' : 'A', wall.price, sweptNotional, trade.notional);
        }
      }
      return;
    }

    // 2. DEFENSE / ABSORPTION BOUNCE CHECK:
    // Prune rolling 30s touches
    if (rec.touchHistory && rec.touchHistory.length) {
      rec.touchHistory = rec.touchHistory.filter((t) => now - t.ts <= 30000);
      rec.touches = rec.touchHistory.length;
      rec.traded = rec.touchHistory.reduce((acc, t) => acc + t.notional, 0);
    }
    const recentTouchCount = rec.touches || 0;
    const recentTraded = rec.traded || 0;
    wall.touchCount = recentTouchCount;
    wall.tradedNotional = recentTraded;

    const book = isBid ? this.bidsBook : this.asksBook;
    const currentQty = book.get(wall.price) || 0;
    const currentNotional = wall.price * currentQty;
    const peakNotional = Math.max(wall.notional, rec.peak || 0);
    const retentionPct = peakNotional > 0 ? (currentNotional / peakNotional) * 100 : 0;

    // If already defended, check if wall is still holding >= 45% retention; if eaten away, downgrade to active
    if (rec.status === 'defended' && rec.statusExpireTs && now < rec.statusExpireTs) {
      if (currentNotional < this.effectiveWallFloor * 0.6 || retentionPct < 45) {
        rec.status = 'active';
        rec.statusExpireTs = undefined;
        wall.status = 'active';
      } else {
        wall.status = 'defended';
        wall.notional = currentNotional;
        wall.label = `🛡️ SAVUNULDU $${this.formatCompact(currentNotional)}`;
      }
      return;
    }

    if (recentTouchCount < 2 || recentTraded < this.effectiveWallMinTraded) return;
    if (currentNotional < this.effectiveWallFloor || retentionPct < 55) return;

    const refPrice = this.midPrice || trade?.price || 0;
    if (!refPrice) return;

    const bounceBps = isBid
      ? ((refPrice - wall.price) / wall.price) * 10000
      : ((wall.price - refPrice) / wall.price) * 10000;

    // Rejection bounce away from the tested wall (between 2.5 bps and 16.0 bps)
    if (bounceBps < 2.5 || bounceBps > 16.0) return;

    const bestOk = isBid
      ? this.bestBid >= wall.price - this.tickSize * 0.5
      : this.bestAsk <= wall.price + this.tickSize * 0.5;

    if (!bestOk) return;

    // Lock in DEFENDED status for 25 seconds across all subsequent depth updates
    rec.status = 'defended';
    rec.defendedAtTs = now;
    rec.statusExpireTs = now + 25000;

    wall.status = 'defended';
    wall.notional = currentNotional;
    wall.label = `🛡️ SAVUNULDU $${this.formatCompact(currentNotional)}`;

    this.generateDefendedOpportunity(
      wall,
      currentNotional,
      retentionPct,
      recentTouchCount,
      recentTraded,
      bounceBps
    );
  }

  // Execution verification when trades hit or bounce off resting limit walls
  private verifyWallExecution(trade: AggTrade) {
    const now = trade.ts;
    for (const wall of this.walls) {
      const key = `${wall.side}|${wall.price}`;
      const rec = this.wallAges.get(key);
      if (!rec) continue;
      this.evaluateWallState(wall, rec, now, trade);
    }
  }

  // True Iceberg & Passive Absorption Detector:
  // Detects when aggressive market orders hit a limit price repeatedly, AND the orderbook depth
  // receives genuine replenished limit quantity (delta Q > 0), confirming a hidden algorithmic iceberg order.
  private checkIcebergAbsorption(trade: AggTrade) {
    const now = trade.ts;
    const side = trade.side === 'buy' ? 'A' : 'B'; // Taker buy executes against Ask book (seller iceberg), sell against Bid book
    const key = `${side}|${trade.price}`;

    const book = side === 'A' ? this.asksBook : this.bidsBook;
    const displayedQty = book.get(trade.price) || 0;
    const displayedNotional = trade.price * displayedQty;

    // Routine prune: Clean up stale iceberg trackers (idle > 15s or total tracking age > 30s)
    for (const [tKey, tRec] of this.icebergTracker.entries()) {
      if (now - tRec.lastTs > 15000 || now - tRec.firstTs > 30000) {
        this.icebergTracker.delete(tKey);
      }
    }

    let tracker = this.icebergTracker.get(key);
    if (!tracker) {
      // Only initiate iceberg tracking if trade executed at a price level with non-trivial resting depth
      if (displayedNotional >= this.effectiveIcebergDisplayedFloor && trade.notional >= this.effectiveIcebergDisplayedFloor * 0.7) {
        this.icebergTracker.set(key, {
          side,
          price: trade.price,
          lastDisplayedQty: displayedQty,
          refillCount: 0,
          replenishedQty: 0,
          replenishedNotional: 0,
          trades: [{ ts: now, notional: trade.notional }],
          firstTs: now,
          lastTs: now,
          peakDisplayedNotional: displayedNotional,
        });
      }
      return;
    }

    // 1. Check tracker lifespan: If total age exceeds 30 seconds or idle > 15s, retire it to prevent indefinite growth
    if (now - tracker.firstTs > 30000 || now - tracker.lastTs > 15000) {
      this.icebergTracker.delete(key);
      return;
    }

    // 2. Add trade to sliding window (strictly 30 seconds)
    tracker.trades.push({ ts: now, notional: trade.notional });
    tracker.lastTs = now;
    tracker.peakDisplayedNotional = Math.max(tracker.peakDisplayedNotional, displayedNotional);

    // 3. Sliding 30s window prune
    tracker.trades = tracker.trades.filter((t) => now - t.ts <= 30000);
    const windowTradedNotional = tracker.trades.reduce((sum, t) => sum + t.notional, 0);

    // 4. MICROSTRUCTURE VERIFICATION OF REAL ICEBERG REPLENISHMENT:
    // A true iceberg requires:
    // a) At least 2 actual orderbook limit additions (refillCount >= 2) where new limit depth was injected into the book
    // b) Cumulative replenished notional injected >= effectiveIcebergMinReplenish USDT
    // c) Aggressive trades in 30s window >= effectiveIcebergMinTraded USDT AND >= 1.5x the peak displayed orderbook depth
    // d) Orderbook level is STILL actively defended and has resting limit orders (displayedNotional >= effectiveIcebergDisplayedFloor)
    const minReplenishUsdt = this.effectiveIcebergMinReplenish;
    const minTradedUsdt = this.effectiveIcebergMinTraded;

    if (
      tracker.refillCount >= 2 &&
      tracker.replenishedNotional >= minReplenishUsdt &&
      windowTradedNotional >= minTradedUsdt &&
      windowTradedNotional >= tracker.peakDisplayedNotional * 1.5 &&
      displayedNotional >= this.effectiveIcebergDisplayedFloor
    ) {
      this.addEvent({
        id: `iceberg-${now}-${trade.price}`,
        type: 'ICEBERG',
        severity: 'high',
        text: `🧊 GERÇEK ICEBERG: ${side === 'B' ? 'BİD (Destek)' : 'ASK (Direnç)'} @ ${trade.price} ($${this.formatCompact(
          windowTradedNotional
        )} emildi, tahtaya +$${this.formatCompact(tracker.replenishedNotional)} gizli likidite eklendi, ${tracker.refillCount}× yenilendi)`,
        price: trade.price,
        ts: now,
      });

      // Trigger absorption opportunity with authentic verified replenishment metrics
      this.generateAbsorptionOpportunity(side, trade.price, {
        tradedNotional: windowTradedNotional,
        peakNotional: tracker.peakDisplayedNotional,
        refillCount: tracker.refillCount,
        replenishedNotional: tracker.replenishedNotional,
      });

      // Reset tracker immediately after firing to prevent repeated duplicate firings
      this.icebergTracker.delete(key);
    }
  }

  // Delta Burst & Acceleration
  private checkDeltaBurst(now: number) {
    const s10 = this.cvdWindows.s10.sum;
    const s60 = this.cvdWindows.s60.sum;

    if (Math.abs(s60) >= this.effectiveDeltaBurstThreshold) {
      const dir = s60 > 0 ? 'BULL' : 'BEAR';
      // Throttle alerts
      const lastEv = this.events.find(
        (e) => e.type === 'DELTA BURST' && now - e.ts < 20000
      );
      if (!lastEv) {
        this.addEvent({
          id: `delta-burst-${now}`,
          type: 'DELTA BURST',
          severity: 'high',
          text: `Hızlı Delta Patlaması (${dir}): 60s net akış $${this.formatCompact(
            Math.abs(s60)
          )} (10s: $${this.formatCompact(Math.abs(s10))})`,
          ts: now,
        });
      }
    }
  }

  // Record 60s rolling price tick history
  private recordPriceTick(price: number, now = Date.now()) {
    if (price > 0) {
      this.priceHistory60s.push({ ts: now, price });
      const cutoff = now - 60000;
      while (this.priceHistory60s.length && this.priceHistory60s[0].ts < cutoff) {
        this.priceHistory60s.shift();
      }
    }
  }

  // Detect Order Flow / Delta Divergence (Price vs Cumulative Volume Delta Mismatch)
  private checkDeltaDivergence(now: number) {
    if (!this.priceHistory60s.length || this.priceHistory60s.length < 4) return;
    const mid = this.midPrice;
    if (!mid) return;

    const startPrice = this.priceHistory60s[0].price;
    if (!startPrice) return;

    const priceDeltaPct = ((mid - startPrice) / startPrice) * 100;
    const cvd60 = this.cvdWindows.s60.sum;
    const threshold = this.effectiveCvdThreshold;

    let divergenceDir: 'BULL' | 'BEAR' | null = null;

    // Bullish Divergence: Price falling or flat (<= -0.03%) but CVD strongly positive (+CVD >= threshold * 1.1)
    if (priceDeltaPct <= -0.03 && cvd60 >= threshold * 1.1) {
      divergenceDir = 'BULL';
    } else if (Math.abs(priceDeltaPct) <= 0.02 && cvd60 >= threshold * 1.5) {
      divergenceDir = 'BULL';
    }
    // Bearish Divergence: Price rising or flat (>= +0.03%) but CVD strongly negative (-CVD >= threshold * 1.1)
    else if (priceDeltaPct >= 0.03 && cvd60 <= -threshold * 1.1) {
      divergenceDir = 'BEAR';
    } else if (Math.abs(priceDeltaPct) <= 0.02 && cvd60 <= -threshold * 1.5) {
      divergenceDir = 'BEAR';
    }

    if (divergenceDir) {
      const lastEv = this.events.find(
        (e) => e.type === 'DELTA DIVERGENCE' && now - e.ts < 25000
      );
      if (!lastEv) {
        this.addEvent({
          id: `delta-div-${now}`,
          type: 'DELTA DIVERGENCE',
          severity: 'high',
          text: `📊 DELTA UYUMSUZLUĞU (${divergenceDir === 'BULL' ? 'Boğa' : 'Ayı'}): Fiyat %${priceDeltaPct.toFixed(2)} iken 60s CVD $${this.formatCompact(cvd60)}`,
          side: divergenceDir === 'BULL' ? 'buy' : 'sell',
          price: mid,
          ts: now,
        });

        this.generateDeltaDivergenceOpportunity(
          divergenceDir === 'BULL' ? 'LONG' : 'SHORT',
          mid,
          priceDeltaPct,
          cvd60
        );
      }
    }
  }

  // Distance-Weighted Order Book Imbalance (OBI) Snapshot Calculation:
  // Weights decay hyperbolically with percentage distance from the mid price: w_i = 1 / (1 + dist_ratio)
  private recordDistanceWeightedObi() {
    const now = Date.now();
    const mid = this.midPrice;
    if (!mid) return;

    let weightedBids = 0;
    let weightedAsks = 0;
    const bandPct = 0.008; // 0.8% band
    const scale = 0.002; // weight halves at 0.2% distance

    for (const [p, q] of this.bidsBook) {
      const dist = (mid - p) / mid;
      if (dist >= 0 && dist <= bandPct) {
        const notional = p * q;
        const weight = 1 / (1 + dist / scale);
        weightedBids += notional * weight;
      }
    }

    for (const [p, q] of this.asksBook) {
      const dist = (p - mid) / mid;
      if (dist >= 0 && dist <= bandPct) {
        const notional = p * q;
        const weight = 1 / (1 + dist / scale);
        weightedAsks += notional * weight;
      }
    }

    const totalWeight = weightedBids + weightedAsks;
    const obi = totalWeight > 0 ? (weightedBids - weightedAsks) / totalWeight : 0;
    this.obiSnapshots.push({ ts: now, obi });

    // Prune snapshots older than 3 minutes
    const cutoff = now - 180000;
    while (this.obiSnapshots.length && this.obiSnapshots[0].ts < cutoff) {
      this.obiSnapshots.shift();
    }
  }

  // Multi-window CVD metrics
  public getMultiCVD(): MultiCVDState {
    const s10 = this.cvdWindows.s10.sum;
    const s30 = this.cvdWindows.s30.sum;
    const s60 = this.cvdWindows.s60.sum;
    const s180 = this.cvdWindows.s180.sum;

    const threshold = this.effectiveCvdThreshold;
    const direction: 'BULL' | 'BEAR' | 'FLAT' =
      s30 > threshold ? 'BULL' : s30 < -threshold ? 'BEAR' : 'FLAT';
    const accelerating =
      Math.sign(s10) === Math.sign(s30) && Math.abs(s10) > Math.abs(s30) / 2.5;
    const allAligned =
      Math.sign(s10) === Math.sign(s30) &&
      Math.sign(s30) === Math.sign(s60) &&
      Math.abs(s10) > Math.max(500, Math.round(threshold * 0.25));

    return { s10, s30, s60, s180, direction, accelerating, allAligned };
  }

  // Distance-Weighted Multi-window OBI metrics
  public getMultiOBI(): MultiOBIState {
    const now = Date.now();
    const avgWindow = (ms: number) => {
      const slice = this.obiSnapshots.filter((s) => now - s.ts <= ms);
      if (!slice.length) return 0;
      return slice.reduce((acc, s) => acc + s.obi, 0) / slice.length;
    };

    const s5 = avgWindow(5000);
    const s15 = avgWindow(15000);
    const s30 = avgWindow(30000);
    const s60 = avgWindow(60000);

    const bullAligned = s5 > 0.05 && s15 > 0.03 && s30 > 0.01;
    const bearAligned = s5 < -0.05 && s15 < -0.03 && s30 < -0.01;
    const aligned: 'BULL' | 'BEAR' | 'MIXED' = bullAligned
      ? 'BULL'
      : bearAligned
      ? 'BEAR'
      : 'MIXED';

    const delta = s15 - s60;
    const trend: 'RISING' | 'FALLING' | 'FLAT' =
      delta > 0.04 ? 'RISING' : delta < -0.04 ? 'FALLING' : 'FLAT';
    const strength = Math.abs(s5 + s15 + s30) / 3;

    return { s5, s15, s30, s60, aligned, trend, strength };
  }

  // Execution Cost & Bid/Ask Microstructure Helper:
  // Computes real Binance USDT-M Futures VIP0 round-trip Taker commission (10 bps = 0.10%)
  // plus real L2 half-spread cost (since entry is mid and LONG exits at Bid, SHORT exits at Ask).
  private getExecutionCostProfile(refPrice?: number) {
    const mid = this.midPrice || refPrice || 0;
    const bookValid = this.depthReady && this.bestBid > 0 && this.bestAsk > this.bestBid;
    const spreadPrice = bookValid
      ? this.bestAsk - this.bestBid
      : Math.max(this.tickSize, mid * 0.0002);
    const halfSpreadPrice = spreadPrice / 2;
    const spreadBps = mid > 0 ? +((spreadPrice / mid) * 10000).toFixed(2) : 2.0;
    const halfSpreadBps = +(spreadBps / 2).toFixed(2);
    const halfSpreadPct = +(halfSpreadBps / 100).toFixed(4);

    const feeBps = OrderbookEngine.ROUND_TRIP_TAKER_FEE_BPS; // 10 bps
    const feePct = OrderbookEngine.ROUND_TRIP_TAKER_FEE_PCT; // 0.10%
    const totalCostBps = +(feeBps + halfSpreadBps).toFixed(2);
    const totalCostPct = +(feePct + halfSpreadPct).toFixed(4);
    const totalCostPrice = mid * (totalCostPct / 100);

    return {
      mid,
      bookValid,
      spreadPrice,
      halfSpreadPrice,
      spreadBps,
      halfSpreadBps,
      halfSpreadPct,
      feeBps,
      feePct,
      totalCostBps,
      totalCostPct,
      totalCostPrice,
    };
  }

  // Generate opportunity card for Defended Walls (Dynamic Wall-Anchored Entry & Structural Target)
  private generateDefendedOpportunity(
    wall: WallRecord,
    currentNotional: number,
    retentionPct: number,
    recentTouchCount: number,
    recentTraded: number,
    bounceBps: number
  ) {
    const now = Date.now();
    const existing = this.opportunities.find(
      (o) =>
        o.symbol === this.symbol &&
        (o.status === 'ACTIVE' || now - o.timestamp < 25000) &&
        o.type === 'DEFENDED_WALL' &&
        o.bias === (wall.side === 'B' ? 'LONG' : 'SHORT')
    );
    if (existing) return;

    const bias = wall.side === 'B' ? 'LONG' : 'SHORT';
    const mid = this.midPrice;
    if (!mid) return;

    const costProfile = this.getExecutionCostProfile(mid);
    // Reject scalp signal if orderbook spread is abnormally wide (> 25 bps)
    if (costProfile.spreadBps > 25) return;

    // 1. Live Execution Entry Price
    const entryPrice = +mid.toFixed(this.precision);
    const initialExecExit = costProfile.bookValid
      ? +(bias === 'LONG' ? this.bestBid : this.bestAsk).toFixed(this.precision)
      : entryPrice;

    // 2. Stop Loss: Placed behind the defended wall, strictly >= 3.0x total round-trip cost (commission + half-spread) and >= 28 bps
    const wallStopBuffer = Math.max(this.tickSize * 3, wall.price * 0.0012);
    const rawStructuralStop = bias === 'LONG' ? wall.price - wallStopBuffer : wall.price + wallStopBuffer;
    const rawRiskDist =
      bias === 'LONG' ? Math.max(0, entryPrice - rawStructuralStop) : Math.max(0, rawStructuralStop - entryPrice);

    const minRisk = Math.max(
      this.tickSize * 4,
      entryPrice * 0.0028, // 28 bps floor
      costProfile.totalCostPrice * OrderbookEngine.MIN_STOP_COST_MULTIPLE // >= 3.0x total cost
    );
    const maxRisk = Math.max(minRisk * 1.8, entryPrice * 0.0065); // up to 65 bps max scalp stop
    const risk = Math.min(maxRisk, Math.max(minRisk, rawRiskDist || minRisk * 1.15));

    const stopPrice =
      bias === 'LONG'
        ? +(entryPrice - risk).toFixed(this.precision)
        : +(entryPrice + risk).toFixed(this.precision);

    const actualRisk = Math.abs(entryPrice - stopPrice);
    if (actualRisk <= 0) return;
    const actualRiskBps = (actualRisk / entryPrice) * 10000;
    if (actualRiskBps < costProfile.totalCostBps * 2.5) return;

    // 3. Structural Target Price: Identify opposing prominent liquidity wall within fee-adjusted scalp range (1.8R - 3.2R)
    let structuralTarget: number | null = null;
    const oppSide = wall.side === 'B' ? 'A' : 'B';
    const opposingWalls = this.walls
      .filter((w) => w.side === oppSide && (bias === 'LONG' ? w.price > entryPrice : w.price < entryPrice))
      .sort((a, b) => (bias === 'LONG' ? a.price - b.price : b.price - a.price));

    if (opposingWalls.length > 0) {
      const oppWall = opposingWalls[0];
      const targetBuffer = Math.max(this.tickSize, oppWall.price * 0.0003);
      const candidateTarget =
        bias === 'LONG'
          ? +(oppWall.price - targetBuffer).toFixed(this.precision)
          : +(oppWall.price + targetBuffer).toFixed(this.precision);
      const dist = Math.abs(candidateTarget - entryPrice);
      if (dist >= actualRisk * 1.8 && dist <= actualRisk * 3.2) {
        structuralTarget = candidateTarget;
      }
    }

    // 4. Multi-timeframe Order Flow Alignment (CVD & OBI)
    const cvd = this.getMultiCVD();
    const obi = this.getMultiOBI();

    let flowBonus = 0;
    if (bias === 'LONG') {
      if (cvd.direction === 'BULL') flowBonus += cvd.accelerating ? 0.45 : 0.25;
      else if (cvd.direction === 'BEAR') flowBonus -= 0.25;
      if (obi.aligned === 'BULL') flowBonus += 0.35;
      else if (obi.aligned === 'BEAR') flowBonus -= 0.25;
    } else {
      if (cvd.direction === 'BEAR') flowBonus += cvd.accelerating ? 0.45 : 0.25;
      else if (cvd.direction === 'BULL') flowBonus -= 0.25;
      if (obi.aligned === 'BEAR') flowBonus += 0.35;
      else if (obi.aligned === 'BULL') flowBonus -= 0.25;
    }

    let targetPrice = entryPrice;
    if (structuralTarget) {
      targetPrice = structuralTarget;
    } else {
      const dynamicMultiplier = Math.max(1.9, Math.min(2.8, 2.15 + flowBonus));
      targetPrice =
        bias === 'LONG'
          ? +(entryPrice + actualRisk * dynamicMultiplier).toFixed(this.precision)
          : +(entryPrice - actualRisk * dynamicMultiplier).toFixed(this.precision);
    }

    const reward = Math.abs(targetPrice - entryPrice);
    const rrRatio = +(reward / actualRisk).toFixed(2);
    const grossRewardPct = (reward / entryPrice) * 100;
    const grossRiskPct = (actualRisk / entryPrice) * 100;
    const netRewardPct = +(grossRewardPct - costProfile.totalCostPct).toFixed(2);
    const netRiskPct = +(grossRiskPct + costProfile.totalCostPct).toFixed(2);
    const netRrRatio = netRiskPct > 0 ? +(netRewardPct / netRiskPct).toFixed(2) : 0;

    // Require positive expectancy after deducting round-trip taker fee + half-spread
    if (rrRatio < 1.75 || netRrRatio < 1.1 || netRewardPct <= costProfile.totalCostPct) return;

    // 5. Scientific Multi-Variable Dynamic Confidence Calculation (0 - 100)
    const retentionScore = Math.round(Math.min(1.0, retentionPct / 100) * 16);
    const sizeBonus = Math.min(14, (currentNotional / Math.max(1, this.whaleMinUsdt)) * 12);
    const depthFactor = retentionScore + Math.round(sizeBonus);

    const touchScore =
      recentTouchCount === 2 ? 8 : recentTouchCount === 3 ? 13 : Math.min(18, 13 + (recentTouchCount - 3) * 2.5);
    const bounceScore = Math.min(12, Math.max(2, Math.round((bounceBps / 3) * 3)));
    const testFactor = Math.round(touchScore + bounceScore);

    let flowScore = 0;
    if (bias === 'LONG') {
      if (cvd.direction === 'BULL') flowScore += cvd.accelerating ? 15 : 10;
      else if (cvd.direction === 'BEAR') flowScore -= 14;
      if (obi.aligned === 'BULL') flowScore += 10;
      else if (obi.aligned === 'MIXED') flowScore += 2;
      else if (obi.aligned === 'BEAR') flowScore -= 10;
    } else {
      if (cvd.direction === 'BEAR') flowScore += cvd.accelerating ? 15 : 10;
      else if (cvd.direction === 'BULL') flowScore -= 14;
      if (obi.aligned === 'BEAR') flowScore += 10;
      else if (obi.aligned === 'MIXED') flowScore += 2;
      else if (obi.aligned === 'BULL') flowScore -= 10;
    }

    const rrScore = Math.min(15, Math.max(0, Math.round((netRrRatio - 1.0) * 12)));
    const rawScore = depthFactor + testFactor + flowScore + rrScore;
    const confidenceScore = Math.min(96, Math.max(42, Math.round(rawScore)));
    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
      confidenceScore >= 78 ? 'HIGH' : confidenceScore >= 58 ? 'MEDIUM' : 'LOW';

    const riskPct = +grossRiskPct.toFixed(2);

    const card: OpportunityCard = {
      id: `opp-def-${now}-${wall.price}`,
      symbol: this.symbol,
      type: 'DEFENDED_WALL',
      title: `${bias === 'LONG' ? '🛡️ Alış Duvarı Savunuldu' : '🛡️ Satış Duvarı Savunuldu'} ($${this.formatCompact(
        currentNotional
      )})`,
      bias,
      entryPrice,
      stopPrice,
      targetPrice,
      riskPct,
      rrRatio,
      netRrRatio,
      feePct: costProfile.feePct,
      spreadBps: costProfile.spreadBps,
      grossPnlPct: 0,
      confidence,
      confidenceScore,
      reasons: [
        `Anlık Giriş: ${entryPrice} (Duvar: ${wall.price}) · Stop: ${stopPrice} (${actualRiskBps.toFixed(0)} bps) · Hedef: ${targetPrice}.`,
        `Net Kârlılık Modeli: Komisyon %${costProfile.feePct.toFixed(2)} (10 bps) + ½Spread ${costProfile.halfSpreadBps.toFixed(1)} bps · Net Hedef +${netRewardPct}% / Net Stop -${netRiskPct}% (Net R:R 1:${netRrRatio}).`,
        `Duvar Doluluk & Emilim: %${retentionPct.toFixed(0)} korundu ($${this.formatCompact(currentNotional)}), 30s'de ${recentTouchCount}× temas ($${this.formatCompact(recentTraded)} emildi).`,
        `Piyasa Akışı: CVD ${cvd.direction} | OBI ${obi.aligned} | Brüt R:R 1:${rrRatio} | Güven: %${confidenceScore} (${confidence})`,
      ],
      timestamp: now,
      status: 'ACTIVE',
      currentPrice: initialExecExit,
      postEntryHigh: initialExecExit,
      postEntryLow: initialExecExit,
      progressPct: 0,
      pnlPct: -+costProfile.totalCostPct.toFixed(2),
      durationSec: 0,
      maxDurationSec: 240,
    };

    this.opportunities.unshift(card);
    if (this.opportunities.length > 60) this.opportunities.pop();
    this.saveOpportunities();
    if (this.onOpportunityCreated) this.onOpportunityCreated(card);
  }

  // Generate opportunity card for Vacuum Sweeps (Breakout & Momentum continuation past cleared liquidity walls)
  private generateVacuumSweepOpportunity(
    side: 'B' | 'A',
    price: number,
    sweptNotional: number,
    executedNotional: number
  ) {
    const now = Date.now();
    const bias: 'LONG' | 'SHORT' = side === 'B' ? 'SHORT' : 'LONG';
    const existing = this.opportunities.find(
      (o) =>
        o.symbol === this.symbol &&
        (o.status === 'ACTIVE' || now - o.timestamp < 25000) &&
        o.type === 'VACUUM_SWEEP' &&
        o.bias === bias
    );
    if (existing) return;

    const mid = this.midPrice || price;
    const costProfile = this.getExecutionCostProfile(mid);
    if (costProfile.spreadBps > 25) return;

    const entryPrice = +mid.toFixed(this.precision);
    const initialExecExit = costProfile.bookValid
      ? +(bias === 'LONG' ? this.bestBid : this.bestAsk).toFixed(this.precision)
      : entryPrice;

    // Stop Loss: Placed behind the swept wall, strictly >= 3.0x total round-trip cost (commission + half-spread) and >= 28 bps
    const rawStopBuffer = Math.max(this.tickSize * 3, price * 0.0012);
    const rawStructuralStop = bias === 'SHORT' ? price + rawStopBuffer : price - rawStopBuffer;
    const rawRiskDist =
      bias === 'LONG' ? Math.max(0, entryPrice - rawStructuralStop) : Math.max(0, rawStructuralStop - entryPrice);

    const minRisk = Math.max(
      this.tickSize * 4,
      entryPrice * 0.0028,
      costProfile.totalCostPrice * OrderbookEngine.MIN_STOP_COST_MULTIPLE
    );
    const maxRisk = Math.max(minRisk * 1.8, entryPrice * 0.0065);
    const risk = Math.min(maxRisk, Math.max(minRisk, rawRiskDist || minRisk * 1.15));

    const stopPrice =
      bias === 'SHORT'
        ? +(entryPrice + risk).toFixed(this.precision)
        : +(entryPrice - risk).toFixed(this.precision);

    const actualRisk = Math.abs(entryPrice - stopPrice);
    if (actualRisk <= 0) return;
    const actualRiskBps = (actualRisk / entryPrice) * 10000;
    if (actualRiskBps < costProfile.totalCostBps * 2.5) return;

    // Structural Target: Next opposing wall in the orderbook within fee-adjusted scalp range (1.8R - 3.2R)
    let structuralTarget: number | null = null;
    const oppSide = side;
    const nextWalls = this.walls
      .filter((w) => w.side === oppSide && (bias === 'SHORT' ? w.price < entryPrice : w.price > entryPrice))
      .sort((a, b) => (bias === 'SHORT' ? b.price - a.price : a.price - b.price));

    if (nextWalls.length > 0) {
      const targetWall = nextWalls[0];
      const targetBuffer = Math.max(this.tickSize, targetWall.price * 0.0003);
      const candidateTarget =
        bias === 'SHORT'
          ? +(targetWall.price + targetBuffer).toFixed(this.precision)
          : +(targetWall.price - targetBuffer).toFixed(this.precision);
      const dist = Math.abs(candidateTarget - entryPrice);
      if (dist >= actualRisk * 1.8 && dist <= actualRisk * 3.2) {
        structuralTarget = candidateTarget;
      }
    }

    const cvd = this.getMultiCVD();
    const obi = this.getMultiOBI();

    let flowBonus = 0;
    if (bias === 'SHORT') {
      if (cvd.direction === 'BEAR') flowBonus += cvd.accelerating ? 0.45 : 0.25;
      else if (cvd.direction === 'BULL') flowBonus -= 0.25;
      if (obi.aligned === 'BEAR') flowBonus += 0.35;
    } else {
      if (cvd.direction === 'BULL') flowBonus += cvd.accelerating ? 0.45 : 0.25;
      else if (cvd.direction === 'BEAR') flowBonus -= 0.25;
      if (obi.aligned === 'BULL') flowBonus += 0.35;
    }

    let targetPrice = entryPrice;
    if (structuralTarget) {
      targetPrice = structuralTarget;
    } else {
      const dynamicMultiplier = Math.max(1.9, Math.min(2.8, 2.2 + flowBonus));
      targetPrice =
        bias === 'SHORT'
          ? +(entryPrice - actualRisk * dynamicMultiplier).toFixed(this.precision)
          : +(entryPrice + actualRisk * dynamicMultiplier).toFixed(this.precision);
    }

    const reward = Math.abs(targetPrice - entryPrice);
    const rrRatio = +(reward / actualRisk).toFixed(2);
    const grossRewardPct = (reward / entryPrice) * 100;
    const grossRiskPct = (actualRisk / entryPrice) * 100;
    const netRewardPct = +(grossRewardPct - costProfile.totalCostPct).toFixed(2);
    const netRiskPct = +(grossRiskPct + costProfile.totalCostPct).toFixed(2);
    const netRrRatio = netRiskPct > 0 ? +(netRewardPct / netRiskPct).toFixed(2) : 0;

    if (rrRatio < 1.75 || netRrRatio < 1.1 || netRewardPct <= costProfile.totalCostPct) return;

    const sweepVolumeRatio = Math.min(30, Math.round((executedNotional / Math.max(1, sweptNotional)) * 25));
    const sizeScore = Math.min(25, Math.round((sweptNotional / this.effectiveWhaleMinUsdt) * 15));
    let flowScore = 15;
    if (bias === 'SHORT' && cvd.direction === 'BEAR') flowScore += 15;
    else if (bias === 'LONG' && cvd.direction === 'BULL') flowScore += 15;
    const rrScore = Math.min(15, Math.round((netRrRatio - 1.0) * 12));

    const rawScore = sweepVolumeRatio + sizeScore + flowScore + rrScore;
    const confidenceScore = Math.min(95, Math.max(45, rawScore));
    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
      confidenceScore >= 78 ? 'HIGH' : confidenceScore >= 58 ? 'MEDIUM' : 'LOW';

    const riskPct = +grossRiskPct.toFixed(2);

    const card: OpportunityCard = {
      id: `opp-sweep-${now}-${price}`,
      symbol: this.symbol,
      type: 'VACUUM_SWEEP',
      title: `${bias === 'LONG' ? '⚡ Boğa Süpürme Kırılımı' : '⚡ Ayı Süpürme Kırılımı'} ($${this.formatCompact(sweptNotional)})`,
      bias,
      entryPrice,
      stopPrice,
      targetPrice,
      riskPct,
      rrRatio,
      netRrRatio,
      feePct: costProfile.feePct,
      spreadBps: costProfile.spreadBps,
      grossPnlPct: 0,
      confidence,
      confidenceScore,
      reasons: [
        `Likidite Süpürüldü: ${side === 'B' ? 'Destek' : 'Direnç'} duvarı ($${this.formatCompact(sweptNotional)}) piyasa emirleriyle temizlendi ($${this.formatCompact(executedNotional)} hacim emildi).`,
        `Anlık Giriş: ${entryPrice} (Kırılan: ${price}) · Stop: ${stopPrice} (${actualRiskBps.toFixed(0)} bps) · Hedef: ${targetPrice}.`,
        `Net Kârlılık Modeli: Komisyon %${costProfile.feePct.toFixed(2)} (10 bps) + ½Spread ${costProfile.halfSpreadBps.toFixed(1)} bps · Net Hedef +${netRewardPct}% / Net Stop -${netRiskPct}% (Net R:R 1:${netRrRatio}).`,
        `Piyasa Akışı: CVD ${cvd.direction} | OBI ${obi.aligned} | Brüt R:R 1:${rrRatio} | Güven: %${confidenceScore} (${confidence})`,
      ],
      timestamp: now,
      status: 'ACTIVE',
      currentPrice: initialExecExit,
      postEntryHigh: initialExecExit,
      postEntryLow: initialExecExit,
      progressPct: 0,
      pnlPct: -+costProfile.totalCostPct.toFixed(2),
      durationSec: 0,
      maxDurationSec: 240,
    };

    this.opportunities.unshift(card);
    if (this.opportunities.length > 60) this.opportunities.pop();
    this.saveOpportunities();
    if (this.onOpportunityCreated) this.onOpportunityCreated(card);
  }

  // Generate opportunity card for Iceberg Absorption Divergence (Dynamic Entry & Orderbook Target)
  private generateAbsorptionOpportunity(
    side: 'B' | 'A',
    price: number,
    tracker: {
      tradedNotional: number;
      peakNotional: number;
      refillCount: number;
      replenishedNotional: number;
    }
  ) {
    const now = Date.now();
    const bias = side === 'B' ? 'LONG' : 'SHORT';
    const existing = this.opportunities.find(
      (o) =>
        o.symbol === this.symbol &&
        (o.status === 'ACTIVE' || now - o.timestamp < 25000) &&
        o.type === 'ICEBERG_ABSORPTION' &&
        o.bias === bias
    );
    if (existing) return;

    const mid = this.midPrice || price;
    const costProfile = this.getExecutionCostProfile(mid);
    if (costProfile.spreadBps > 25) return;

    const entryPrice = +mid.toFixed(this.precision);
    const initialExecExit = costProfile.bookValid
      ? +(bias === 'LONG' ? this.bestBid : this.bestAsk).toFixed(this.precision)
      : entryPrice;

    // 2. Stop Loss: Invalidation behind the confirmed iceberg level, strictly >= 3.0x total cost and >= 28 bps
    const rawStopBuffer = Math.max(this.tickSize * 3, price * 0.0012);
    const rawStructuralStop = bias === 'LONG' ? price - rawStopBuffer : price + rawStopBuffer;
    const rawRiskDist =
      bias === 'LONG' ? Math.max(0, entryPrice - rawStructuralStop) : Math.max(0, rawStructuralStop - entryPrice);

    const minRisk = Math.max(
      this.tickSize * 4,
      entryPrice * 0.0028,
      costProfile.totalCostPrice * OrderbookEngine.MIN_STOP_COST_MULTIPLE
    );
    const maxRisk = Math.max(minRisk * 1.8, entryPrice * 0.0065);
    const risk = Math.min(maxRisk, Math.max(minRisk, rawRiskDist || minRisk * 1.15));

    const stopPrice =
      bias === 'LONG'
        ? +(entryPrice - risk).toFixed(this.precision)
        : +(entryPrice + risk).toFixed(this.precision);

    const actualRisk = Math.abs(entryPrice - stopPrice);
    if (actualRisk <= 0) return;
    const actualRiskBps = (actualRisk / entryPrice) * 10000;
    if (actualRiskBps < costProfile.totalCostBps * 2.5) return;

    // 3. Structural target based on opposing book liquidity within fee-adjusted scalp range (1.8R - 3.2R)
    const oppSide = side === 'B' ? 'A' : 'B';
    const opposingWalls = this.walls
      .filter((w) => w.side === oppSide && (bias === 'LONG' ? w.price > entryPrice : w.price < entryPrice))
      .sort((a, b) => (bias === 'LONG' ? a.price - b.price : b.price - a.price));

    const cvd = this.getMultiCVD();
    const obi = this.getMultiOBI();

    let flowAlignmentBonus = 0;
    if (bias === 'LONG' && cvd.direction === 'BULL') flowAlignmentBonus += 0.35;
    if (bias === 'SHORT' && cvd.direction === 'BEAR') flowAlignmentBonus += 0.35;
    if (bias === 'LONG' && obi.aligned === 'BULL') flowAlignmentBonus += 0.25;
    if (bias === 'SHORT' && obi.aligned === 'BEAR') flowAlignmentBonus += 0.25;

    let targetPrice = entryPrice;
    let usedStructural = false;
    if (opposingWalls.length > 0) {
      const oppWall = opposingWalls[0];
      const targetBuffer = Math.max(this.tickSize, oppWall.price * 0.0003);
      const candidateTarget =
        bias === 'LONG'
          ? +(oppWall.price - targetBuffer).toFixed(this.precision)
          : +(oppWall.price + targetBuffer).toFixed(this.precision);
      const dist = Math.abs(candidateTarget - entryPrice);
      if (dist >= actualRisk * 1.8 && dist <= actualRisk * 3.2) {
        targetPrice = candidateTarget;
        usedStructural = true;
      }
    }
    if (!usedStructural) {
      const dynamicMultiplier = Math.max(1.9, Math.min(2.8, 2.15 + flowAlignmentBonus));
      targetPrice =
        bias === 'LONG'
          ? +(entryPrice + actualRisk * dynamicMultiplier).toFixed(this.precision)
          : +(entryPrice - actualRisk * dynamicMultiplier).toFixed(this.precision);
    }

    const reward = Math.abs(targetPrice - entryPrice);
    const rrRatio = +(reward / actualRisk).toFixed(2);
    const grossRewardPct = (reward / entryPrice) * 100;
    const grossRiskPct = (actualRisk / entryPrice) * 100;
    const netRewardPct = +(grossRewardPct - costProfile.totalCostPct).toFixed(2);
    const netRiskPct = +(grossRiskPct + costProfile.totalCostPct).toFixed(2);
    const netRrRatio = netRiskPct > 0 ? +(netRewardPct / netRiskPct).toFixed(2) : 0;

    if (rrRatio < 1.75 || netRrRatio < 1.1 || netRewardPct <= costProfile.totalCostPct) return;

    const replenishRatio = tracker.replenishedNotional / Math.max(this.effectiveIcebergDisplayedFloor, tracker.peakNotional);
    const replenishScore = Math.min(25, Math.round(replenishRatio * 14));
    const refillScore = Math.min(20, tracker.refillCount * 6);

    let flowScore = 0;
    if (bias === 'LONG') {
      if (cvd.direction === 'BULL') flowScore += cvd.accelerating ? 15 : 10;
      else if (cvd.direction === 'BEAR') flowScore -= 12;
      if (obi.aligned === 'BULL') flowScore += 10;
      else if (obi.aligned === 'BEAR') flowScore -= 10;
    } else {
      if (cvd.direction === 'BEAR') flowScore += cvd.accelerating ? 15 : 10;
      else if (cvd.direction === 'BULL') flowScore -= 12;
      if (obi.aligned === 'BEAR') flowScore += 10;
      else if (obi.aligned === 'BULL') flowScore -= 10;
    }

    const rrScore = Math.min(15, Math.max(0, Math.round((netRrRatio - 1.0) * 12)));
    const rawScore = replenishScore + refillScore + flowScore + rrScore;
    const confidenceScore = Math.min(96, Math.max(42, Math.round(rawScore)));
    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
      confidenceScore >= 78 ? 'HIGH' : confidenceScore >= 58 ? 'MEDIUM' : 'LOW';

    const riskPct = +grossRiskPct.toFixed(2);

    const card: OpportunityCard = {
      id: `opp-ice-${now}-${price}`,
      symbol: this.symbol,
      type: 'ICEBERG_ABSORPTION',
      title: `${bias === 'LONG' ? '🧊 Boğa Emilim Sinyali' : '🧊 Ayı Emilim Sinyali'} ($${this.formatCompact(
        tracker.tradedNotional
      )})`,
      bias,
      entryPrice,
      stopPrice,
      targetPrice,
      riskPct,
      rrRatio,
      netRrRatio,
      feePct: costProfile.feePct,
      spreadBps: costProfile.spreadBps,
      grossPnlPct: 0,
      confidence,
      confidenceScore,
      reasons: [
        `Anlık Giriş: ${entryPrice} (Emilim: ${price}) · Stop: ${stopPrice} (${actualRiskBps.toFixed(0)} bps) · Hedef: ${targetPrice}.`,
        `Net Kârlılık Modeli: Komisyon %${costProfile.feePct.toFixed(2)} (10 bps) + ½Spread ${costProfile.halfSpreadBps.toFixed(1)} bps · Net Hedef +${netRewardPct}% / Net Stop -${netRiskPct}% (Net R:R 1:${netRrRatio}).`,
        `Gerçek Likidite Yenilemesi: Tahtaya +$${this.formatCompact(tracker.replenishedNotional)} yeni limit emir eklendi (${tracker.refillCount}× yenilenme, $${this.formatCompact(tracker.tradedNotional)} karşılandı).`,
        `Piyasa Akışı: CVD ${cvd.direction} | OBI ${obi.aligned} | Brüt R:R 1:${rrRatio} | Güven: %${confidenceScore} (${confidence})`,
      ],
      timestamp: now,
      status: 'ACTIVE',
      currentPrice: initialExecExit,
      postEntryHigh: initialExecExit,
      postEntryLow: initialExecExit,
      progressPct: 0,
      pnlPct: -+costProfile.totalCostPct.toFixed(2),
      durationSec: 0,
      maxDurationSec: 240,
    };

    this.opportunities.unshift(card);
    if (this.opportunities.length > 60) this.opportunities.pop();
    this.saveOpportunities();
    if (this.onOpportunityCreated) this.onOpportunityCreated(card);
  }

  // Generate opportunity card for Order Flow Delta Divergence
  private generateDeltaDivergenceOpportunity(
    bias: 'LONG' | 'SHORT',
    price: number,
    priceDeltaPct: number,
    cvdNotional: number
  ) {
    const now = Date.now();
    const existing = this.opportunities.find(
      (o) =>
        o.symbol === this.symbol &&
        (o.status === 'ACTIVE' || now - o.timestamp < 30000) &&
        o.type === 'DELTA_DIVERGENCE' &&
        o.bias === bias
    );
    if (existing) return;

    const mid = this.midPrice || price;
    const costProfile = this.getExecutionCostProfile(mid);
    if (costProfile.spreadBps > 25) return;

    const entryPrice = +mid.toFixed(this.precision);
    const initialExecExit = costProfile.bookValid
      ? +(bias === 'LONG' ? this.bestBid : this.bestAsk).toFixed(this.precision)
      : entryPrice;

    // Stop Loss: Strictly >= 3.0x total execution cost (commission + half-spread) and >= 28 bps
    const minRisk = Math.max(
      this.tickSize * 4,
      entryPrice * 0.0028,
      costProfile.totalCostPrice * OrderbookEngine.MIN_STOP_COST_MULTIPLE
    );
    const maxRisk = Math.max(minRisk * 1.8, entryPrice * 0.0065);
    const risk = Math.min(maxRisk, Math.max(minRisk, minRisk * 1.15));

    const stopPrice =
      bias === 'LONG'
        ? +(entryPrice - risk).toFixed(this.precision)
        : +(entryPrice + risk).toFixed(this.precision);

    const actualRisk = Math.abs(entryPrice - stopPrice);
    if (actualRisk <= 0) return;
    const actualRiskBps = (actualRisk / entryPrice) * 10000;
    if (actualRiskBps < costProfile.totalCostBps * 2.5) return;

    const cvd = this.getMultiCVD();
    const obi = this.getMultiOBI();

    // Target: Structural target towards opposing wall within [1.8R, 3.2R] or dynamic 1:2.2 R:R
    let targetPrice = entryPrice;
    let usedStructural = false;
    const oppSide = bias === 'LONG' ? 'A' : 'B';
    const oppWalls = this.walls
      .filter((w) => w.side === oppSide && (bias === 'LONG' ? w.price > entryPrice : w.price < entryPrice))
      .sort((a, b) => (bias === 'LONG' ? a.price - b.price : b.price - a.price));

    if (oppWalls.length > 0) {
      const oppWall = oppWalls[0];
      const targetBuffer = Math.max(this.tickSize, oppWall.price * 0.0003);
      const candidateTarget =
        bias === 'LONG'
          ? +(oppWall.price - targetBuffer).toFixed(this.precision)
          : +(oppWall.price + targetBuffer).toFixed(this.precision);
      const dist = Math.abs(candidateTarget - entryPrice);
      if (dist >= actualRisk * 1.8 && dist <= actualRisk * 3.2) {
        targetPrice = candidateTarget;
        usedStructural = true;
      }
    }
    if (!usedStructural) {
      const dynamicMultiplier = 2.2;
      targetPrice =
        bias === 'LONG'
          ? +(entryPrice + actualRisk * dynamicMultiplier).toFixed(this.precision)
          : +(entryPrice - actualRisk * dynamicMultiplier).toFixed(this.precision);
    }

    const reward = Math.abs(targetPrice - entryPrice);
    const rrRatio = +(reward / actualRisk).toFixed(2);
    const grossRewardPct = (reward / entryPrice) * 100;
    const grossRiskPct = (actualRisk / entryPrice) * 100;
    const netRewardPct = +(grossRewardPct - costProfile.totalCostPct).toFixed(2);
    const netRiskPct = +(grossRiskPct + costProfile.totalCostPct).toFixed(2);
    const netRrRatio = netRiskPct > 0 ? +(netRewardPct / netRiskPct).toFixed(2) : 0;

    if (rrRatio < 1.75 || netRrRatio < 1.1 || netRewardPct <= costProfile.totalCostPct) return;

    const divStrengthScore = Math.min(30, Math.round((Math.abs(cvdNotional) / Math.max(1, this.effectiveCvdThreshold)) * 18));
    const obiScore = bias === 'LONG' && obi.aligned === 'BULL' ? 20 : bias === 'SHORT' && obi.aligned === 'BEAR' ? 20 : 10;
    const rrScore = Math.min(20, Math.round((netRrRatio - 1.0) * 12));

    const confidenceScore = Math.min(96, Math.max(50, divStrengthScore + obiScore + rrScore + 20));
    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
      confidenceScore >= 78 ? 'HIGH' : confidenceScore >= 58 ? 'MEDIUM' : 'LOW';

    const riskPct = +grossRiskPct.toFixed(2);

    const card: OpportunityCard = {
      id: `opp-div-${now}-${price}`,
      symbol: this.symbol,
      type: 'DELTA_DIVERGENCE',
      title: `${bias === 'LONG' ? '📊 Boğa Delta Uyumsuzluğu' : '📊 Ayı Delta Uyumsuzluğu'} ($${this.formatCompact(Math.abs(cvdNotional))})`,
      bias,
      entryPrice,
      stopPrice,
      targetPrice,
      riskPct,
      rrRatio,
      netRrRatio,
      feePct: costProfile.feePct,
      spreadBps: costProfile.spreadBps,
      grossPnlPct: 0,
      confidence,
      confidenceScore,
      reasons: [
        `Net Akış Uyumsuzluğu: Fiyat %${priceDeltaPct.toFixed(2)} hareket ederken 60s CVD $${this.formatCompact(cvdNotional)} baskı üretti.`,
        `Anlık Giriş: ${entryPrice} · Stop: ${stopPrice} (${actualRiskBps.toFixed(0)} bps) · Hedef: ${targetPrice}.`,
        `Net Kârlılık Modeli: Komisyon %${costProfile.feePct.toFixed(2)} (10 bps) + ½Spread ${costProfile.halfSpreadBps.toFixed(1)} bps · Net Hedef +${netRewardPct}% / Net Stop -${netRiskPct}% (Net R:R 1:${netRrRatio}).`,
        `Piyasa Akışı: CVD ${cvd.direction} | OBI ${obi.aligned} | Brüt R:R 1:${rrRatio} | Güven: %${confidenceScore} (${confidence})`,
      ],
      timestamp: now,
      status: 'ACTIVE',
      currentPrice: initialExecExit,
      postEntryHigh: initialExecExit,
      postEntryLow: initialExecExit,
      progressPct: 0,
      pnlPct: -+costProfile.totalCostPct.toFixed(2),
      durationSec: 0,
      maxDurationSec: 240,
    };

    this.opportunities.unshift(card);
    if (this.opportunities.length > 60) this.opportunities.pop();
    this.saveOpportunities();
    if (this.onOpportunityCreated) this.onOpportunityCreated(card);
  }

  // Active Opportunity Card Real-time Lifecycle Tracker:
  // Evaluates every price tick / L2 top-of-book / kline update against active cards:
  // - Uses real executable exit prices: BID for LONG exits, ASK for SHORT exits
  // - Tracks running postEntryHigh / postEntryLow strictly AFTER card.timestamp (ignoring pre-card candle highs/lows)
  // - Computes Net PnL (pnlPct) deducting round-trip Taker commission (10 bps = 0.10%) and half-spread
  // - HIT_TARGET: Post-entry executable price reaches targetPrice
  // - STOPPED: Post-entry executable price breaches stopPrice
  // - EXPIRED: Opportunity has been active for >= maxDurationSec (240s) without hitting TP/SL
  public checkActiveOpportunitiesLifecycle(
    currentPrice: number,
    now = Date.now(),
    klineCandle?: { openTimeMs: number; high: number; low: number }
  ) {
    if (!currentPrice || !this.opportunities.length) return;

    let anyResolved = false;
    const liveCost = this.getExecutionCostProfile(currentPrice);

    for (const card of this.opportunities) {
      if (card.status !== 'ACTIVE') continue;

      // Ignore any stale event timestamped prior to card creation
      if (now < card.timestamp) continue;

      const maxDur = card.maxDurationSec || 240;
      const durationSec = Math.max(0, Math.round((now - card.timestamp) / 1000));
      card.maxDurationSec = maxDur;
      card.durationSec = durationSec;

      const feePct = card.feePct ?? OrderbookEngine.ROUND_TRIP_TAKER_FEE_PCT;
      const spreadBps = card.spreadBps ?? liveCost.spreadBps;
      const halfSpreadPct = (spreadBps / 2) / 100;
      const totalCostPct = feePct + halfSpreadPct;

      // If card belongs to a different symbol than currently active book, expire it if past lifespan
      if (card.symbol !== this.symbol) {
        if (durationSec >= maxDur) {
          card.status = 'EXPIRED';
          card.exitPrice = card.currentPrice || card.entryPrice;
          card.resolvedAt = now;
          card.pnlPct = card.pnlPct ?? -+totalCostPct.toFixed(2);
          anyResolved = true;
          if (this.onOpportunityUpdated) this.onOpportunityUpdated(card);
        }
        continue;
      }

      // Guard against any anomalous cross-symbol tick (> 30% deviation from entryPrice)
      if (Math.abs(currentPrice - card.entryPrice) / Math.max(1e-9, card.entryPrice) > 0.3) {
        continue;
      }

      const bookValid = this.depthReady && this.bestBid > 0 && this.bestAsk > this.bestBid;
      const halfSpreadPrice = bookValid
        ? (this.bestAsk - this.bestBid) / 2
        : card.entryPrice * (halfSpreadPct / 100);

      // CRITICAL: Only use kline high/low if the candle itself opened AT OR AFTER card.timestamp!
      // If the candle opened before the card was created, its high/low includes historical pre-card prices.
      const klineOpenedAfterCard =
        klineCandle !== undefined && klineCandle.openTimeMs >= card.timestamp;

      let resolved = false;

      if (card.bias === 'LONG') {
        // LONG real exit is strictly on the BID side (bestBid)
        const execBid = bookValid
          ? this.bestBid
          : +(currentPrice - halfSpreadPrice).toFixed(this.precision);
        const tickBidHigh = Math.max(
          execBid,
          currentPrice - halfSpreadPrice,
          klineOpenedAfterCard ? klineCandle.high - halfSpreadPrice : execBid
        );
        const tickBidLow = Math.min(
          execBid,
          currentPrice - halfSpreadPrice,
          klineOpenedAfterCard ? klineCandle.low - halfSpreadPrice : execBid
        );

        card.postEntryHigh = Math.max(card.postEntryHigh ?? execBid, tickBidHigh);
        card.postEntryLow = Math.min(card.postEntryLow ?? execBid, tickBidLow);

        const checkHigh = card.postEntryHigh;
        const checkLow = card.postEntryLow;

        card.currentPrice = +execBid.toFixed(this.precision);
        const grossMovePct = ((currentPrice - card.entryPrice) / card.entryPrice) * 100;
        // Since execBid = mid - spread/2, ((execBid - entryPrice) / entryPrice) * 100 already includes -halfSpreadPct!
        const execMovePct = ((execBid - card.entryPrice) / card.entryPrice) * 100;
        card.grossPnlPct = +grossMovePct.toFixed(2);
        card.pnlPct = +(execMovePct - feePct).toFixed(2);

        if (execBid >= card.entryPrice) {
          const targetDist = Math.max(1e-9, card.targetPrice - card.entryPrice);
          card.progressPct = Math.min(100, Math.round(((execBid - card.entryPrice) / targetDist) * 100));
        } else {
          const stopDist = Math.max(1e-9, card.entryPrice - card.stopPrice);
          card.progressPct = Math.max(-100, -Math.round(((card.entryPrice - execBid) / stopDist) * 100));
        }

        // Target reached: Executable Bid price rose to or above targetPrice
        if (checkHigh >= card.targetPrice) {
          const fillPrice = +Math.max(card.targetPrice, execBid).toFixed(this.precision);
          const grossPnl = ((fillPrice - card.entryPrice) / card.entryPrice) * 100;
          card.status = 'HIT_TARGET';
          card.exitPrice = fillPrice;
          card.currentPrice = fillPrice;
          card.resolvedAt = now;
          card.durationSec = Math.max(1, durationSec);
          card.progressPct = 100;
          card.grossPnlPct = +grossPnl.toFixed(2);
          card.pnlPct = +(grossPnl - totalCostPct).toFixed(2);
          resolved = true;
        } else if (checkLow <= card.stopPrice) {
          // Stopped: Executable Bid price fell to or below stopPrice
          const fillPrice = +Math.min(card.stopPrice, execBid).toFixed(this.precision);
          const grossPnl = ((fillPrice - card.entryPrice) / card.entryPrice) * 100;
          card.status = 'STOPPED';
          card.exitPrice = fillPrice;
          card.currentPrice = fillPrice;
          card.resolvedAt = now;
          card.durationSec = Math.max(1, durationSec);
          card.progressPct = -100;
          card.grossPnlPct = +grossPnl.toFixed(2);
          card.pnlPct = +(grossPnl - totalCostPct).toFixed(2);
          resolved = true;
        }
      } else {
        // SHORT real exit is strictly on the ASK side (bestAsk)
        const execAsk = bookValid
          ? this.bestAsk
          : +(currentPrice + halfSpreadPrice).toFixed(this.precision);
        const tickAskHigh = Math.max(
          execAsk,
          currentPrice + halfSpreadPrice,
          klineOpenedAfterCard ? klineCandle.high + halfSpreadPrice : execAsk
        );
        const tickAskLow = Math.min(
          execAsk,
          currentPrice + halfSpreadPrice,
          klineOpenedAfterCard ? klineCandle.low + halfSpreadPrice : execAsk
        );

        card.postEntryHigh = Math.max(card.postEntryHigh ?? execAsk, tickAskHigh);
        card.postEntryLow = Math.min(card.postEntryLow ?? execAsk, tickAskLow);

        const checkHigh = card.postEntryHigh;
        const checkLow = card.postEntryLow;

        card.currentPrice = +execAsk.toFixed(this.precision);
        const grossMovePct = ((card.entryPrice - currentPrice) / card.entryPrice) * 100;
        // Since execAsk = mid + spread/2, ((entryPrice - execAsk) / entryPrice) * 100 already includes -halfSpreadPct!
        const execMovePct = ((card.entryPrice - execAsk) / card.entryPrice) * 100;
        card.grossPnlPct = +grossMovePct.toFixed(2);
        card.pnlPct = +(execMovePct - feePct).toFixed(2);

        if (execAsk <= card.entryPrice) {
          const targetDist = Math.max(1e-9, card.entryPrice - card.targetPrice);
          card.progressPct = Math.min(100, Math.round(((card.entryPrice - execAsk) / targetDist) * 100));
        } else {
          const stopDist = Math.max(1e-9, card.stopPrice - card.entryPrice);
          card.progressPct = Math.max(-100, -Math.round(((execAsk - card.entryPrice) / stopDist) * 100));
        }

        // Target reached: Executable Ask price fell to or below targetPrice
        if (checkLow <= card.targetPrice) {
          const fillPrice = +Math.min(card.targetPrice, execAsk).toFixed(this.precision);
          const grossPnl = ((card.entryPrice - fillPrice) / card.entryPrice) * 100;
          card.status = 'HIT_TARGET';
          card.exitPrice = fillPrice;
          card.currentPrice = fillPrice;
          card.resolvedAt = now;
          card.durationSec = Math.max(1, durationSec);
          card.progressPct = 100;
          card.grossPnlPct = +grossPnl.toFixed(2);
          card.pnlPct = +(grossPnl - totalCostPct).toFixed(2);
          resolved = true;
        } else if (checkHigh >= card.stopPrice) {
          // Stopped: Executable Ask price rose to or above stopPrice
          const fillPrice = +Math.max(card.stopPrice, execAsk).toFixed(this.precision);
          const grossPnl = ((card.entryPrice - fillPrice) / card.entryPrice) * 100;
          card.status = 'STOPPED';
          card.exitPrice = fillPrice;
          card.currentPrice = fillPrice;
          card.resolvedAt = now;
          card.durationSec = Math.max(1, durationSec);
          card.progressPct = -100;
          card.grossPnlPct = +grossPnl.toFixed(2);
          card.pnlPct = +(grossPnl - totalCostPct).toFixed(2);
          resolved = true;
        }
      }

      // Scalp Expiry check: If trade has not hit target or stop within maxDurationSec (240s), retire as EXPIRED at executable Bid/Ask
      if (!resolved && durationSec >= maxDur) {
        const execFill = card.currentPrice ?? +currentPrice.toFixed(this.precision);
        card.status = 'EXPIRED';
        card.exitPrice = execFill;
        card.resolvedAt = now;
        card.durationSec = durationSec;
        // card.pnlPct and card.grossPnlPct are already computed from execBid/execAsk minus feePct above
        resolved = true;
      }

      if (resolved) {
        anyResolved = true;
        const outcomeLabel =
          card.status === 'HIT_TARGET'
            ? `✅ HEDEF ALINDI (${card.bias} +${card.pnlPct}%)`
            : card.status === 'STOPPED'
            ? `🛑 STOP OLDU (${card.bias} ${card.pnlPct}%)`
            : `⏱️ SÜRE DOLDU (${card.bias} ${card.pnlPct && card.pnlPct >= 0 ? '+' : ''}${card.pnlPct}%)`;

        this.addEvent({
          id: `opp-res-${now}-${card.id}`,
          type: 'SAVUNULDU',
          severity: card.status === 'HIT_TARGET' ? 'high' : 'medium',
          text: `${outcomeLabel}: ${card.title} @ ${card.exitPrice} (${card.durationSec}s)`,
          side: card.bias === 'LONG' ? 'buy' : 'sell',
          price: card.exitPrice,
          ts: now,
        });

        if (this.onOpportunityUpdated) {
          this.onOpportunityUpdated(card);
        }
      }
    }

    if (anyResolved) {
      this.saveOpportunities();
    }
  }

  // Statistical Performance Analytics of generated scalping opportunities
  public getOpportunityStats() {
    const total = this.opportunities.length;
    const resolved = this.opportunities.filter((o) => o.status !== 'ACTIVE');
    const hits = this.opportunities.filter((o) => o.status === 'HIT_TARGET');
    const stops = this.opportunities.filter((o) => o.status === 'STOPPED');
    const expired = this.opportunities.filter((o) => o.status === 'EXPIRED');
    const active = this.opportunities.filter((o) => o.status === 'ACTIVE');

    // Decisive win rate (Target Hit vs Stopped); if only expired exist, count positive-PnL expired signals
    const decisiveCount = hits.length + stops.length;
    const expiredWins = expired.filter((o) => (o.pnlPct || 0) > 0).length;
    const winRate =
      decisiveCount > 0
        ? +((hits.length / decisiveCount) * 100).toFixed(1)
        : resolved.length > 0
        ? +(((hits.length + expiredWins) / resolved.length) * 100).toFixed(1)
        : 0;

    const resolvedPnL = resolved.reduce((acc, o) => acc + (o.pnlPct || 0), 0);
    const activePnL = active.reduce((acc, o) => acc + (o.pnlPct || 0), 0);
    const totalPnL = +(resolvedPnL + activePnL).toFixed(2);

    return {
      total,
      activeCount: active.length,
      hitCount: hits.length,
      stopCount: stops.length,
      expiredCount: expired.length,
      resolvedCount: resolved.length,
      winRate,
      totalPnL,
    };
  }

  // Heatmap frame sampler
  public sampleHeatmap(force = false) {
    const now = Date.now();
    if (!force && now - this.lastHeatSampleTs < 1000) return;
    this.lastHeatSampleTs = now;
    if (!this.midPrice) return;

    const mid = this.midPrice;
    const range = mid * 0.05;
    const bins: HeatmapBin[] = [];

    for (const [p, q] of this.bidsBook) {
      if (Math.abs(p - mid) <= range) {
        bins.push({ side: 'B', price: p, notional: p * q });
      }
    }
    for (const [p, q] of this.asksBook) {
      if (Math.abs(p - mid) <= range) {
        bins.push({ side: 'A', price: p, notional: p * q });
      }
    }

    bins.sort((a, b) => b.notional - a.notional);
    const topBins = bins.slice(0, 250);
    const maxNotional = topBins.length ? topBins[0].notional : 10000;

    this.heatmapFrames.push({
      t: Math.floor(now / 1000),
      bins: topBins,
      maxNotional,
    });

    const minSec = Math.floor(now / 1000) - 900;
    while (this.heatmapFrames.length && this.heatmapFrames[0].t < minSec) {
      this.heatmapFrames.shift();
    }
  }

  private addEvent(event: FlowEvent) {
    this.events.unshift(event);
    if (this.events.length > 50) this.events.pop();
    if (this.onEventCreated) this.onEventCreated(event);
  }

  public formatCompact(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }
}
