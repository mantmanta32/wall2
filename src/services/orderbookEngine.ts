import { AggTrade, ConfidenceBucketStats, ConfidenceCalibration, ConfidenceFactors, EquityPoint, FlowEvent, ForceOrder, LiquidityTier, MultiCVDState, MultiOBIState, OpportunityCard, OpportunityStats, SignalTypeStats, WallRecord } from '../types/market';
import type { WorkerAnalyzeRequest, WorkerAnalyzeResponse, WorkerCandidate } from '../workers/orderbookWorker';

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
  private lastWallDetectTs = 0;
  private lastObiSampleTs = 0;

  // Off-thread Web Worker for O(N log N) percentile sorting, wall candidate filtering, OBI & heatmap binning
  private worker: Worker | null = null;
  private workerBusy = false;
  private workerSeq = 0;

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
  public onSyncStateChange?: (synced: boolean) => void;

  public isOrderbookSynced(): boolean {
    return (
      this.depthReady &&
      this.isSnapshotLoaded &&
      this.depthSynced &&
      this.bestBid > 0 &&
      this.bestAsk > this.bestBid
    );
  }

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
    this.initWorker();
    this.loadSavedOpportunities();
    if (initialSettings) {
      this.updateSettings(initialSettings);
    } else {
      this.recalibrateThresholds();
    }
  }

  private initWorker() {
    try {
      if (typeof Worker !== 'undefined') {
        this.worker = new Worker(new URL('../workers/orderbookWorker.ts', import.meta.url), {
          type: 'module',
        });
        this.worker.onmessage = (event: MessageEvent<WorkerAnalyzeResponse>) => {
          this.workerBusy = false;
          const res = event.data;
          if (!res || res.type !== 'ANALYZE_RESULT' || res.seq < this.workerSeq) return;
          if (!this.depthReady || !this.midPrice) return;

          // 1. Apply off-thread Distance-Weighted OBI snapshot
          this.obiSnapshots.push({ ts: res.now, obi: res.obi });
          const cutoff = res.now - 180000;
          while (this.obiSnapshots.length && this.obiSnapshots[0].ts < cutoff) {
            this.obiSnapshots.shift();
          }

          // 2. Apply off-thread filtered & percentile-thresholded wall candidates
          this.applyWallCandidates(res.threshold, res.candidates, res.now);

          // 3. Apply off-thread sorted heatmap bins if computed
          if (res.heatmap) {
            this.heatmapFrames.push(res.heatmap);
            const minSec = Math.floor(res.now / 1000) - 900;
            while (this.heatmapFrames.length && this.heatmapFrames[0].t < minSec) {
              this.heatmapFrames.shift();
            }
          }
        };
        this.worker.onerror = () => {
          this.workerBusy = false;
        };
      }
    } catch {
      this.worker = null;
    }
  }

  private loadSavedOpportunities() {
    try {
      const raw = localStorage.getItem('orderbook_opportunities_v2');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const now = Date.now();
        this.opportunities = parsed.slice(0, 150).map((card: OpportunityCard) => {
          const maxDur = card.maxDurationSec || 240;
          const elapsedSec = Math.max(1, Math.round((now - card.timestamp) / 1000));
          let nextCard: OpportunityCard = card;
          // If card was left ACTIVE across a symbol change or offline session reload, mark as CANCELLED (not EXPIRED) so it doesn't distort stats
          if (card.status === 'ACTIVE' && (elapsedSec >= maxDur || card.symbol !== this.symbol)) {
            nextCard = {
              ...card,
              status: 'CANCELLED',
              exitPrice: card.currentPrice || card.entryPrice,
              resolvedAt: now,
              durationSec: Math.min(elapsedSec, maxDur),
              pnlPct: card.pnlPct ?? 0,
              progressPct: card.progressPct ?? 0,
            };
          }
          // Backfill standardized factors and calibrate legacy cards that were created with uncalibrated heuristic weights
          if (!nextCard.factors) {
            const inferred = this.inferLegacyCardFactors(nextCard);
            const cal = this.computeCalibratedConfidence(nextCard.type, inferred, nextCard.id);
            nextCard = {
              ...nextCard,
              factors: inferred,
              rawConfidenceScore: nextCard.rawConfidenceScore ?? nextCard.confidenceScore,
              confidenceScore: cal.confidenceScore,
              confidence: cal.confidence,
            };
          }
          return nextCard;
        });
      }
    } catch {
      // Ignore storage errors
    }
  }

  public saveOpportunities() {
    try {
      localStorage.setItem('orderbook_opportunities_v2', JSON.stringify(this.opportunities.slice(0, 150)));
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
      this.detectWalls(true);
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
      this.detectWalls(true);
    }
  }

  public set24hQuoteVolume(quoteVolume: number) {
    if (Number.isFinite(quoteVolume) && quoteVolume > 0) {
      this.quoteVolume24h = quoteVolume;
      this.recalibrateThresholds();
      if (this.depthReady) {
        this.detectWalls(true);
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
    this.lastWallDetectTs = 0;
    this.lastObiSampleTs = 0;
    this.lastHeatSampleTs = 0;
    this.workerSeq++;
    this.workerBusy = false;
    this.trades = [];
    this.liqs = [];
    this.events = [];
    // Preserve resolved opportunities for win-rate analytics; mark any active cards from a previous symbol as CANCELLED (user symbol switch, excluded from stats)
    this.loadSavedOpportunities();
    const now = Date.now();
    for (const card of this.opportunities) {
      if (card.status === 'ACTIVE' && card.symbol !== this.symbol) {
        card.status = 'CANCELLED';
        card.exitPrice = card.currentPrice || card.entryPrice;
        card.resolvedAt = now;
        card.durationSec = Math.max(1, Math.round((now - card.timestamp) / 1000));
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
  // Strictly invalidates depthReady and clears stale book state so neither the UI nor lifecycle tracker runs on stale depth
  public beginDepthSync(clearBuffer = false) {
    this.isSnapshotLoaded = false;
    this.depthSynced = false;
    this.depthReady = false;
    this.hasBridgedFirstEvent = false;
    this.workerSeq++;
    this.workerBusy = false;
    this.bidsBook.clear();
    this.asksBook.clear();
    this.bestBid = 0;
    this.bestAsk = 0;
    this.spread = 0;
    this.midPrice = 0;
    this.walls = [];
    if (clearBuffer) {
      this.pendingDepthEvents = [];
    }
    if (this.onSyncStateChange) {
      this.onSyncStateChange(false);
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
        this.beginDepthSync(false);
        this.pendingDepthEvents = postSnapEvents;
        return false;
      }
    }

    const now = Date.now();
    this.bidsBook.clear();
    this.asksBook.clear();
    const activeKeys = new Set<string>();
    const candidateFloor = this.effectiveWallFloor * 0.5;

    for (const [p, q] of bids) {
      if (q > 0 && Number.isFinite(p) && p > 0) {
        this.bidsBook.set(p, q);
        const notional = p * q;
        // Only store genuine wall candidates in wallAges (never populate all book dust levels)
        if (notional >= candidateFloor) {
          const key = `B|${p}`;
          activeKeys.add(key);
          const existing = this.wallAges.get(key);
          if (existing) {
            existing.peak = Math.max(existing.peak, notional);
            existing.lastSeenTs = now;
          } else {
            this.wallAges.set(key, {
              born: now,
              peak: notional,
              touches: 0,
              traded: 0,
              lastSeenTs: now,
              initialQty: q,
            });
          }
        }
      }
    }
    for (const [p, q] of asks) {
      if (q > 0 && Number.isFinite(p) && p > 0) {
        this.asksBook.set(p, q);
        const notional = p * q;
        if (notional >= candidateFloor) {
          const key = `A|${p}`;
          activeKeys.add(key);
          const existing = this.wallAges.get(key);
          if (existing) {
            existing.peak = Math.max(existing.peak, notional);
            existing.lastSeenTs = now;
          } else {
            this.wallAges.set(key, {
              born: now,
              peak: notional,
              touches: 0,
              traded: 0,
              lastSeenTs: now,
              initialQty: q,
            });
          }
        }
      }
    }

    // Prune wallAges entries that no longer qualify as wall candidates in the fresh snapshot
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
          const remaining = postSnapEvents.slice(i);
          this.beginDepthSync(false);
          this.pendingDepthEvents = remaining;
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
          const remaining = postSnapEvents.slice(i);
          this.beginDepthSync(false);
          this.pendingDepthEvents = remaining;
          return false;
        }
      }
    }

    this.pendingDepthEvents = [];
    this.depthSynced = true;
    this.depthReady = true;
    this.lastSyncTs = now;
    this.recomputeBest(true);
    this.recalibrateThresholds();
    this.recordDistanceWeightedObi(true);
    this.detectWalls(true);
    this.sampleHeatmap(true);
    if (this.onSyncStateChange) {
      this.onSyncStateChange(this.isOrderbookSynced());
    }
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
        this.depthReady = true;
        this.executeRawDepthUpdate(bids, asks, u, true);
        if (this.onSyncStateChange) {
          this.onSyncStateChange(this.isOrderbookSynced());
        }
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
    this.beginDepthSync(true);
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

    let bestBidInvalidated = false;
    let bestAskInvalidated = false;
    const candidateFloor = this.effectiveWallFloor * 0.5;
    const dustRetireFloor = this.effectiveWallFloor * 0.25;

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
            if (side === 'B' && p === this.bestBid) bestBidInvalidated = true;
            if (side === 'A' && p === this.bestAsk) bestAskInvalidated = true;

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

              // Level was swept if traded volume at the level is significant and it wasn't already marked consumed/logged
              const isSweptByTrades =
                ageRec.status !== 'consumed' &&
                totalExecutedAtLevel >= Math.min(peakNotional * 0.15, this.effectiveWallMinTraded);

              if (isSweptByTrades) {
                const sweepTakerSide = side === 'B' ? 'sell' : 'buy';
                const alreadySweptLevel = this.sweptWallLevels.some(
                  (sw) => sw.side === side && Math.abs(sw.price - p) <= tol && now - sw.ts < 10000
                );
                if (!alreadySweptLevel) {
                  this.sweptWallLevels.push({
                    price: p,
                    side,
                    notional: peakNotional,
                    ts: now,
                    expireTs: now + 8000,
                  });
                  if (this.sweptWallLevels.length > 20) this.sweptWallLevels.shift();
                }

                // Unified 10-second deduplication across all DOM SWEEP paths so the same sweep is never logged twice
                this.recordDomSweepEvent(
                  now,
                  sweepTakerSide,
                  p,
                  tol,
                  peakNotional >= this.effectiveWhaleMinUsdt ? 'high' : 'medium',
                  `⚡ DOM SWEEP: ${side === 'B' ? 'BİD (Destek)' : 'ASK (Direnç)'} Duvarı Süpürüldü @ ${p} ($${this.formatCompact(peakNotional)} temizlendi, $${this.formatCompact(totalExecutedAtLevel)} emildi)`
                );

                this.generateVacuumSweepOpportunity(side, p, peakNotional, totalExecutedAtLevel);
              } else if (ageRec.status !== 'consumed') {
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
          // O(1) incremental top-of-book maintenance
          if (side === 'B' && p > this.bestBid) this.bestBid = p;
          if (side === 'A' && (this.bestAsk <= 0 || p < this.bestAsk)) this.bestAsk = p;

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

          // Restrict wallAges strictly to significant wall candidates (>= 50% of effectiveWallFloor)
          const existingRec = this.wallAges.get(key);
          if (!existingRec) {
            if (notional >= candidateFloor) {
              this.wallAges.set(key, {
                born: now,
                peak: notional,
                touches: 0,
                traded: 0,
                lastSeenTs: now,
                initialQty: q,
              });
            }
          } else {
            if (
              notional < dustRetireFloor &&
              existingRec.status !== 'defended' &&
              existingRec.status !== 'consumed'
            ) {
              this.wallAges.delete(key);
            } else {
              if (oldNotional < this.effectiveWallFloor * 0.35 && notional >= this.effectiveWallFloor) {
                existingRec.born = now;
                existingRec.peak = notional;
                existingRec.initialQty = q;
                existingRec.status = 'active';
                existingRec.statusExpireTs = undefined;
              } else if (notional >= candidateFloor) {
                existingRec.peak = Math.max(existingRec.peak, notional);
              }
              existingRec.lastSeenTs = now;
            }
          }
        }
      }
    };

    processSide(this.bidsBook, bids, 'B');
    processSide(this.asksBook, asks, 'A');

    if (u) this.lastUpdateId = u;
    if (recompute) {
      this.recomputeBest(false, bestBidInvalidated, bestAskInvalidated);
      this.scheduleBookAnalysis(now);
    }
  }

  // Throttled (250ms) Book Analysis Dispatcher:
  // Offloads full-book percentile sorting, wall candidate filtering, OBI, and heatmap binning to the Web Worker
  // (or runs throttled synchronous pass if Worker is unavailable).
  private scheduleBookAnalysis(now = Date.now()) {
    if (now - this.lastWallDetectTs < 250) return;
    this.lastWallDetectTs = now;

    if (!this.bestBid || !this.bestAsk || !this.midPrice) {
      this.walls = [];
      return;
    }

    const needHeatmap = now - this.lastHeatSampleTs >= 1000;
    if (needHeatmap) {
      this.lastHeatSampleTs = now;
    }

    if (this.worker && !this.workerBusy) {
      this.workerBusy = true;
      const seq = ++this.workerSeq;
      const req: WorkerAnalyzeRequest = {
        type: 'ANALYZE_BOOK',
        seq,
        now,
        midPrice: this.midPrice,
        wallPct: this.wallPct,
        effectiveWallFloor: this.effectiveWallFloor,
        needHeatmap,
        bids: Array.from(this.bidsBook.entries()),
        asks: Array.from(this.asksBook.entries()),
      };
      this.worker.postMessage(req);
      return;
    }

    // Fallback if worker is unavailable or busy
    this.recordDistanceWeightedObi(true);
    this.detectWalls(true);
    if (needHeatmap) {
      this.sampleHeatmap(true);
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

    // Quantitative execution tracking against resting wall candidates (O(1) exact lookup + active walls fallback)
    // Taker sell matches against resting Bids; taker buy matches against resting Asks
    const matchSide = trade.side === 'sell' ? 'B' : 'A';
    const exactWallKey = `${matchSide}|${trade.price}`;
    let matchRec = this.wallAges.get(exactWallKey);
    const tol = this.tickSize * 1.5;
    if (!matchRec && this.walls.length > 0) {
      let bestDist = Infinity;
      // Only check the active detected walls (<= 24 items) instead of scanning all book levels
      for (let i = 0; i < this.walls.length; i++) {
        const w = this.walls[i];
        if (w.side === matchSide) {
          const dist = Math.abs(w.price - trade.price);
          if (dist <= tol && dist < bestDist) {
            const candidateRec = this.wallAges.get(`${matchSide}|${w.price}`);
            if (candidateRec) {
              bestDist = dist;
              matchRec = candidateRec;
            }
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

    // Do not run wall execution, iceberg, signal generation, or card lifecycle while orderbook is out of sync
    if (!this.isOrderbookSynced()) {
      return;
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

  // Unified 10-second deduplicated DOM SWEEP event emitter used by executeRawDepthUpdate, checkFlowSweep, and evaluateWallState
  private recordDomSweepEvent(
    now: number,
    side: 'buy' | 'sell',
    price: number,
    tolerance: number,
    severity: 'high' | 'medium',
    text: string
  ) {
    const recentDuplicateSweep = this.events.some(
      (e) =>
        e.type === 'DOM SWEEP' &&
        now - e.ts < 10000 &&
        (e.side === side || (e.price !== undefined && Math.abs(e.price - price) <= Math.max(tolerance * 2, price * 0.0005)))
    );
    if (!recentDuplicateSweep) {
      this.addEvent({
        id: `sweep-${now}-${price}`,
        type: 'DOM SWEEP',
        severity,
        text,
        side,
        price,
        ts: now,
      });
    }
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
      this.recordDomSweepEvent(
        now,
        currentTrade.side,
        currentTrade.price,
        this.tickSize * 2,
        totalSweptNotional >= this.effectiveWhaleMinUsdt ? 'high' : 'medium',
        `⚡ DOM SWEEP: ${currentTrade.side === 'buy' ? 'ALIŞ' : 'SATIŞ'} Süpürmesi! ${prices.length > 1 ? `${prices.length} kademe delindi` : 'agresif süpürme'} ($${this.formatCompact(totalSweptNotional)} @ ${currentTrade.price})`
      );

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

  // Fast O(1) incremental computation of best bid, best ask, spread, and midPrice
  // Only scans the map when the top-of-book price level itself was deleted or on initial snapshot load
  private recomputeBest(
    forceFullScan = false,
    bestBidInvalidated = false,
    bestAskInvalidated = false
  ) {
    if (
      forceFullScan ||
      bestBidInvalidated ||
      this.bestBid <= 0 ||
      !this.bidsBook.has(this.bestBid)
    ) {
      let bb = 0;
      for (const p of this.bidsBook.keys()) {
        if (p > bb) bb = p;
      }
      this.bestBid = bb;
    }

    if (
      forceFullScan ||
      bestAskInvalidated ||
      this.bestAsk <= 0 ||
      !this.asksBook.has(this.bestAsk)
    ) {
      let ba = Infinity;
      for (const p of this.asksBook.keys()) {
        if (p < ba) ba = p;
      }
      this.bestAsk = isFinite(ba) ? ba : 0;
    }

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
  // Throttled to 250ms unless force=true (e.g. on initial snapshot or settings change)
  public detectWalls(force = false) {
    if (!this.bestBid || !this.bestAsk || !this.midPrice) {
      this.walls = [];
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastWallDetectTs < 250) return;
    this.lastWallDetectTs = now;

    const mid = this.midPrice;
    const bandRange = mid * 0.05; // 5.0% scalping band around price
    const minCandidateNotional = this.effectiveWallFloor * 0.5;
    const notionalList: number[] = [];
    const candidates: WorkerCandidate[] = [];

    // Filter within visible scalping band
    for (const [p, q] of this.bidsBook) {
      if (Math.abs(p - mid) <= bandRange) {
        const notional = p * q;
        notionalList.push(notional);
        if (notional >= minCandidateNotional) {
          candidates.push({ price: p, side: 'B', notional });
        }
      }
    }
    for (const [p, q] of this.asksBook) {
      if (Math.abs(p - mid) <= bandRange) {
        const notional = p * q;
        notionalList.push(notional);
        if (notional >= minCandidateNotional) {
          candidates.push({ price: p, side: 'A', notional });
        }
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
    const threshold = Math.max(percentileThreshold, this.effectiveWallFloor);

    this.applyWallCandidates(threshold, candidates, now);
  }

  // Shared wall candidate processor used by both Web Worker results and synchronous fallback
  private applyWallCandidates(threshold: number, candidates: WorkerCandidate[], now: number) {
    const detected: WallRecord[] = [];
    const activeCandidateKeys = new Set<string>();

    for (const c of candidates) {
      const key = `${c.side}|${c.price}`;
      activeCandidateKeys.add(key);
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

        // Preserve existing status within TTL instead of resetting to 'active' on every update
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

        // Evaluate whether this wall just completed a defense bounce or was breached
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

    // Prune stale non-candidate entries from wallAges so the map stays compact
    for (const [wKey, wRec] of this.wallAges.entries()) {
      if (
        !activeCandidateKeys.has(wKey) &&
        wRec.status !== 'defended' &&
        wRec.status !== 'consumed' &&
        now - wRec.lastSeenTs > 15000
      ) {
        this.wallAges.delete(wKey);
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
      if (rec.status === 'consumed' && rec.statusExpireTs && now < rec.statusExpireTs) {
        wall.status = 'consumed';
        return;
      }
      const priorTraded = rec.traded || 0;
      rec.status = 'consumed';
      rec.statusExpireTs = now + 8000;
      wall.status = 'consumed';
      rec.touchHistory = [];
      rec.touches = 0;
      rec.traded = 0;
      wall.touchCount = 0;
      wall.tradedNotional = 0;

      const wallSide: 'B' | 'A' = isBid ? 'B' : 'A';
      const alreadySweptLevel = this.sweptWallLevels.some(
        (sw) => sw.side === wallSide && Math.abs(sw.price - wall.price) <= tolerance && now - sw.ts < 10000
      );
      if (!alreadySweptLevel) {
        this.sweptWallLevels.push({
          price: wall.price,
          side: wallSide,
          notional: Math.max(wall.notional, rec.peak || 0),
          ts: now,
          expireTs: now + 8000,
        });
        if (this.sweptWallLevels.length > 20) this.sweptWallLevels.shift();
      }

      if (trade) {
        const minSweepNotional = Math.max(2000, Math.round(this.effectiveWhaleMinUsdt * 0.25));
        const sweptNotional = Math.max(priorTraded, trade.notional);
        if (sweptNotional >= minSweepNotional) {
          this.recordDomSweepEvent(
            now,
            trade.side,
            wall.price,
            tolerance,
            sweptNotional >= this.effectiveWhaleMinUsdt ? 'high' : 'medium',
            `⚡ DOM SWEEP: ${isBid ? 'BİD' : 'ASK'} Duvarı Süpürüldü @ ${wall.price} ($${this.formatCompact(sweptNotional)})`
          );
          this.generateVacuumSweepOpportunity(wallSide, wall.price, sweptNotional, trade.notional);
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
  // Throttled to 250ms unless force=true
  private recordDistanceWeightedObi(force = false) {
    const now = Date.now();
    if (!force && now - this.lastObiSampleTs < 250) return;
    this.lastObiSampleTs = now;
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
    const bookValid = this.isOrderbookSynced();
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

  // Unified Multi-Window CVD + Distance-Weighted OBI Flow Factor in [0, 1]
  // 0.50 = strictly neutral; < 0.50 = flow opposes signal bias; > 0.50 = flow aligns with signal bias
  private computeUnifiedFlowFactor(
    bias: 'LONG' | 'SHORT',
    cvd: MultiCVDState,
    obi: MultiOBIState
  ): number {
    let score = 0.50;

    // 1. Multi-Window CVD Alignment ([-0.30, +0.30])
    const cvdAligned =
      (bias === 'LONG' && cvd.direction === 'BULL') ||
      (bias === 'SHORT' && cvd.direction === 'BEAR');
    const cvdOpposed =
      (bias === 'LONG' && cvd.direction === 'BEAR') ||
      (bias === 'SHORT' && cvd.direction === 'BULL');

    if (cvdAligned) {
      score += 0.16;
      if (cvd.accelerating) score += 0.08;
      if (cvd.allAligned) score += 0.06;
    } else if (cvdOpposed) {
      score -= 0.20;
      if (cvd.accelerating) score -= 0.06;
      if (cvd.allAligned) score -= 0.04;
    }

    // 2. Multi-Window OBI Alignment ([-0.20, +0.20])
    const obiAligned =
      (bias === 'LONG' && obi.aligned === 'BULL') ||
      (bias === 'SHORT' && obi.aligned === 'BEAR');
    const obiOpposed =
      (bias === 'LONG' && obi.aligned === 'BEAR') ||
      (bias === 'SHORT' && obi.aligned === 'BULL');
    const obiStrengthBoost = Math.min(0.06, (Math.abs(obi.strength) / 100) * 0.08);

    if (obiAligned) {
      score += 0.14 + obiStrengthBoost;
    } else if (obiOpposed) {
      score -= 0.16 + Math.min(0.04, obiStrengthBoost);
    } else {
      // MIXED OBI: check short-term trend
      if (
        (bias === 'LONG' && obi.trend === 'RISING') ||
        (bias === 'SHORT' && obi.trend === 'FALLING')
      ) {
        score += 0.03;
      } else if (
        (bias === 'LONG' && obi.trend === 'FALLING') ||
        (bias === 'SHORT' && obi.trend === 'RISING')
      ) {
        score -= 0.03;
      }
    }

    return Math.min(1, Math.max(0, +score.toFixed(3)));
  }

  // Unified Payoff & Execution Cost Efficiency Factor in [0, 1]
  // Evaluates net R:R (after 10 bps taker fee + half-spread), stop-to-cost buffer ratio, and structural target anchoring
  private computeUnifiedPayoffFactor(
    netRrRatio: number,
    actualRiskBps: number,
    totalCostBps: number,
    usedStructural: boolean
  ): number {
    const rrNorm = Math.min(1, Math.max(0, (netRrRatio - 1.1) / 1.4));
    const costMultiple = actualRiskBps / Math.max(1, totalCostBps);
    const costNorm = Math.min(1, Math.max(0, (costMultiple - 2.5) / 3.5));
    const structBonus = usedStructural ? 0.16 : 0;
    return Math.min(1, Math.max(0, +(rrNorm * 0.58 + costNorm * 0.26 + structBonus).toFixed(3)));
  }

  // Reconstructs normalized [0..1] microstructure factors for legacy cards stored in localStorage prior to factor logging
  private inferLegacyCardFactors(card: OpportunityCard): ConfidenceFactors {
    const reasonsText = (card.reasons || []).join(' | ');
    const bias = card.bias;

    // Infer flow factor from logged CVD and OBI states in card.reasons
    let flow = 0.50;
    const cvdMatch = reasonsText.match(/CVD\s+(BULL|BEAR|FLAT)/i);
    const obiMatch = reasonsText.match(/OBI\s+(BULL|BEAR|MIXED)/i);
    if (cvdMatch) {
      const dir = cvdMatch[1].toUpperCase();
      if ((bias === 'LONG' && dir === 'BULL') || (bias === 'SHORT' && dir === 'BEAR')) flow += 0.22;
      else if ((bias === 'LONG' && dir === 'BEAR') || (bias === 'SHORT' && dir === 'BULL')) flow -= 0.22;
    }
    if (obiMatch) {
      const al = obiMatch[1].toUpperCase();
      if ((bias === 'LONG' && al === 'BULL') || (bias === 'SHORT' && al === 'BEAR')) flow += 0.16;
      else if ((bias === 'LONG' && al === 'BEAR') || (bias === 'SHORT' && al === 'BULL')) flow -= 0.16;
    }
    flow = Math.min(1, Math.max(0, +flow.toFixed(3)));

    const netRr = card.netRrRatio ?? Math.max(1.1, (card.rrRatio || 1.8) - 0.35);
    const payoff = Math.min(1, Math.max(0.15, +(((netRr - 1.1) / 1.4) * 0.75 + 0.15).toFixed(3)));

    // Remove legacy generator-specific constant inflation (+20 on DELTA_DIVERGENCE, +15 on VACUUM_SWEEP)
    const raw = card.rawConfidenceScore ?? card.confidenceScore ?? 65;
    const debias =
      card.type === 'DELTA_DIVERGENCE'
        ? raw - 12
        : card.type === 'VACUUM_SWEEP'
        ? raw - 6
        : card.type === 'ICEBERG_ABSORPTION'
        ? raw + 6
        : raw;
    const baseNorm = Math.min(0.95, Math.max(0.25, (debias - 35) / 60));

    return {
      structure: +Math.min(1, Math.max(0.2, baseNorm)).toFixed(3),
      execution: +Math.min(1, Math.max(0.2, baseNorm * 0.95)).toFixed(3),
      flow,
      payoff,
    };
  }

  // Empirical Factor Weight Calibration:
  // Combines microstructure prior weights w0 = (0.28, 0.30, 0.27, 0.15) with online empirical covariance
  // between each factor f_k and realized net R-multiple across resolved trades (HIT_TARGET, STOPPED, EXPIRED).
  public getCalibratedFactorWeights(excludeId?: string): {
    structure: number;
    execution: number;
    flow: number;
    payoff: number;
    isEmpirical: boolean;
    sampleSize: number;
  } {
    const prior = { structure: 0.28, execution: 0.30, flow: 0.27, payoff: 0.15 };
    const resolved = (this.opportunities || []).filter(
      (o) =>
        o &&
        o.id !== excludeId &&
        (o.status === 'HIT_TARGET' || o.status === 'STOPPED' || o.status === 'EXPIRED')
    );

    const n = resolved.length;
    if (n < 4) {
      return { ...prior, isEmpirical: false, sampleSize: n };
    }

    const samples = resolved.map((o) => {
      const f = o.factors ?? this.inferLegacyCardFactors(o);
      const feePct = o.feePct ?? OrderbookEngine.ROUND_TRIP_TAKER_FEE_PCT;
      const halfSpreadPct = ((o.spreadBps ?? 2.0) / 2) / 100;
      const grossStopPct =
        o.riskPct && o.riskPct > 0
          ? o.riskPct
          : Math.max(0.25, (Math.abs(o.entryPrice - o.stopPrice) / Math.max(1e-9, o.entryPrice)) * 100);
      const netStopPct = Math.max(0.15, grossStopPct + feePct + halfSpreadPct);
      const netPnlPct = o.pnlPct ?? -(feePct + halfSpreadPct);
      const rMult = Math.max(-1.5, Math.min(2.5, netPnlPct / netStopPct));
      const winTarget = (netPnlPct > 0 ? 0.5 : -0.5) + 0.5 * (rMult / 2.0);
      return { f, y: winTarget };
    });

    const meanY = samples.reduce((acc, s) => acc + s.y, 0) / n;
    const keys: (keyof ConfidenceFactors)[] = ['structure', 'execution', 'flow', 'payoff'];
    const rawWeights: Record<keyof ConfidenceFactors, number> = { ...prior };
    const shrinkage = n / (n + 10); // Bayesian shrinkage factor in (0, 1)

    for (const k of keys) {
      const meanF = samples.reduce((acc, s) => acc + s.f[k], 0) / n;
      let cov = 0;
      let varF = 0;
      for (const s of samples) {
        const df = s.f[k] - meanF;
        cov += df * (s.y - meanY);
        varF += df * df;
      }
      cov /= n;
      const stdF = Math.sqrt(varF / n);
      const slope = stdF > 0.02 ? cov / stdF : 0;
      // Exponentially tilt prior weight toward empirically predictive factors, clamped to [0.12, 0.44]
      rawWeights[k] = Math.min(0.44, Math.max(0.12, prior[k] * Math.exp(1.35 * shrinkage * slope)));
    }

    const sumW = rawWeights.structure + rawWeights.execution + rawWeights.flow + rawWeights.payoff;
    const structure = +(rawWeights.structure / sumW).toFixed(3);
    const execution = +(rawWeights.execution / sumW).toFixed(3);
    const flow = +(rawWeights.flow / sumW).toFixed(3);
    const payoff = +(1 - structure - execution - flow).toFixed(3);

    return {
      structure,
      execution,
      flow,
      payoff,
      isEmpirical: true,
      sampleSize: n,
    };
  }

  // Unified & Empirically Calibrated Confidence Calculator:
  // Eliminates per-generator constant inflation, enforces strict multi-factor confluence gates for HIGH (≥78),
  // and applies Bayesian posterior shrinkage based on live resolved outcomes.
  private computeCalibratedConfidence(
    type: OpportunityCard['type'],
    factors: ConfidenceFactors,
    excludeId?: string
  ): {
    rawConfidenceScore: number;
    confidenceScore: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  } {
    const weights = this.getCalibratedFactorWeights(excludeId);

    const composite =
      weights.structure * factors.structure +
      weights.execution * factors.execution +
      weights.flow * factors.flow +
      weights.payoff * factors.payoff;

    // Standardized linear mapping onto [36, 95] without any generator-specific bias
    const rawConfidenceScore = Math.round(Math.min(95, Math.max(36, 35 + composite * 60)));

    // Empirical Signal-Type Bayesian Posterior adjustment from resolved outcomes of the same setup type
    const sameTypeResolved = (this.opportunities || []).filter(
      (o) =>
        o &&
        o.id !== excludeId &&
        o.type === type &&
        (o.status === 'HIT_TARGET' || o.status === 'STOPPED' || o.status === 'EXPIRED')
    );

    let typeAdj = 0;
    if (sameTypeResolved.length >= 2) {
      let sumR = 0;
      let wins = 0;
      for (const o of sameTypeResolved) {
        const feePct = o.feePct ?? OrderbookEngine.ROUND_TRIP_TAKER_FEE_PCT;
        const halfSpreadPct = ((o.spreadBps ?? 2.0) / 2) / 100;
        const grossStopPct =
          o.riskPct && o.riskPct > 0
            ? o.riskPct
            : Math.max(0.25, (Math.abs(o.entryPrice - o.stopPrice) / Math.max(1e-9, o.entryPrice)) * 100);
        const netStopPct = Math.max(0.15, grossStopPct + feePct + halfSpreadPct);
        const netPnl = o.pnlPct ?? -(feePct + halfSpreadPct);
        if (netPnl > 0) wins++;
        sumR += netPnl / netStopPct;
      }
      const nType = sameTypeResolved.length;
      const avgR = sumR / nType;
      const winRate = wins / nType;
      const typeShrinkage = nType / (nType + 8);
      typeAdj = Math.round(
        Math.max(-6, Math.min(6, typeShrinkage * (avgR * 7 + (winRate - 0.50) * 12)))
      );
    }

    let score = Math.min(95, Math.max(36, rawConfidenceScore + typeAdj));

    // Strict Microstructure Confluence Gates:
    // 1. If CVD + OBI order flow actively opposes the signal bias (flow < 0.45), cap at LOW (≤56).
    // 2. To qualify for HIGH (≥78), the signal MUST have positive flow alignment (flow >= 0.58)
    //    AND verified execution/absorption (execution >= 0.48) AND solid structure (structure >= 0.45).
    if (factors.flow < 0.45) {
      score = Math.min(score, 56);
    } else if (factors.flow < 0.58 || factors.execution < 0.48 || factors.structure < 0.45) {
      score = Math.min(score, 76);
    }

    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
      score >= 78 ? 'HIGH' : score >= 58 ? 'MEDIUM' : 'LOW';

    return {
      rawConfidenceScore,
      confidenceScore: score,
      confidence,
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

    // 5. Standardized [0..1] Microstructure Factors & Empirically Calibrated Confidence
    const notionalNorm = Math.min(1, currentNotional / Math.max(1, this.effectiveWhaleMinUsdt * 1.4));
    const retentionNorm = Math.min(1, Math.max(0, (retentionPct - 35) / 65));
    const fStructure = +Math.min(1, Math.max(0.15, notionalNorm * 0.55 + retentionNorm * 0.45)).toFixed(3);

    const touchNorm = Math.min(1, (recentTouchCount - 1) / 3.5);
    const absorbedNorm = Math.min(1, recentTraded / Math.max(1, this.effectiveWallMinTraded * 2.5));
    const bounceNorm = Math.min(1, bounceBps / 10);
    const fExecution = +Math.min(1, Math.max(0.15, touchNorm * 0.35 + absorbedNorm * 0.40 + bounceNorm * 0.25)).toFixed(3);

    const fFlow = this.computeUnifiedFlowFactor(bias, cvd, obi);
    const fPayoff = this.computeUnifiedPayoffFactor(
      netRrRatio,
      actualRiskBps,
      costProfile.totalCostBps,
      structuralTarget !== null
    );

    const factors: ConfidenceFactors = {
      structure: fStructure,
      execution: fExecution,
      flow: fFlow,
      payoff: fPayoff,
    };
    const { rawConfidenceScore, confidenceScore, confidence } = this.computeCalibratedConfidence(
      'DEFENDED_WALL',
      factors
    );

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
      rawConfidenceScore,
      factors,
      reasons: [
        `Anlık Giriş: ${entryPrice} (Duvar: ${wall.price}) · Stop: ${stopPrice} (${actualRiskBps.toFixed(0)} bps) · Hedef: ${targetPrice}.`,
        `Net Kârlılık Modeli: Komisyon %${costProfile.feePct.toFixed(2)} (10 bps) + ½Spread ${costProfile.halfSpreadBps.toFixed(1)} bps · Net Hedef +${netRewardPct}% / Net Stop -${netRiskPct}% (Net R:R 1:${netRrRatio}).`,
        `Duvar Doluluk & Emilim: %${retentionPct.toFixed(0)} korundu ($${this.formatCompact(currentNotional)}), 30s'de ${recentTouchCount}× temas ($${this.formatCompact(recentTraded)} emildi).`,
        `Kalibre Faktörler: Yapı %${Math.round(fStructure * 100)} · İcra %${Math.round(fExecution * 100)} · Akış %${Math.round(fFlow * 100)} (CVD ${cvd.direction}/OBI ${obi.aligned}) · Getiri %${Math.round(fPayoff * 100)} → Güven: %${confidenceScore} (${confidence})`,
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
    if (this.opportunities.length > 150) this.opportunities.pop();
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

    // Standardized [0..1] Microstructure Factors & Empirically Calibrated Confidence
    const sweptSizeNorm = Math.min(1, sweptNotional / Math.max(1, this.effectiveWhaleMinUsdt * 1.3));
    const clearanceNorm = structuralTarget !== null ? 0.85 : 0.55;
    const fStructure = +Math.min(1, Math.max(0.15, sweptSizeNorm * 0.70 + clearanceNorm * 0.30)).toFixed(3);

    const execRatioNorm = Math.min(1, (executedNotional / Math.max(1, sweptNotional)) * 0.82);
    const burstNorm = Math.min(1, executedNotional / Math.max(1, this.effectiveWhaleMinUsdt));
    const fExecution = +Math.min(1, Math.max(0.15, execRatioNorm * 0.65 + burstNorm * 0.35)).toFixed(3);

    const fFlow = this.computeUnifiedFlowFactor(bias, cvd, obi);
    const fPayoff = this.computeUnifiedPayoffFactor(
      netRrRatio,
      actualRiskBps,
      costProfile.totalCostBps,
      structuralTarget !== null
    );

    const factors: ConfidenceFactors = {
      structure: fStructure,
      execution: fExecution,
      flow: fFlow,
      payoff: fPayoff,
    };
    const { rawConfidenceScore, confidenceScore, confidence } = this.computeCalibratedConfidence(
      'VACUUM_SWEEP',
      factors
    );

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
      rawConfidenceScore,
      factors,
      reasons: [
        `Likidite Süpürüldü: ${side === 'B' ? 'Destek' : 'Direnç'} duvarı ($${this.formatCompact(sweptNotional)}) piyasa emirleriyle temizlendi ($${this.formatCompact(executedNotional)} hacim emildi).`,
        `Anlık Giriş: ${entryPrice} (Kırılan: ${price}) · Stop: ${stopPrice} (${actualRiskBps.toFixed(0)} bps) · Hedef: ${targetPrice}.`,
        `Net Kârlılık Modeli: Komisyon %${costProfile.feePct.toFixed(2)} (10 bps) + ½Spread ${costProfile.halfSpreadBps.toFixed(1)} bps · Net Hedef +${netRewardPct}% / Net Stop -${netRiskPct}% (Net R:R 1:${netRrRatio}).`,
        `Kalibre Faktörler: Yapı %${Math.round(fStructure * 100)} · İcra %${Math.round(fExecution * 100)} · Akış %${Math.round(fFlow * 100)} (CVD ${cvd.direction}/OBI ${obi.aligned}) · Getiri %${Math.round(fPayoff * 100)} → Güven: %${confidenceScore} (${confidence})`,
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
    if (this.opportunities.length > 150) this.opportunities.pop();
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

    // Standardized [0..1] Microstructure Factors & Empirically Calibrated Confidence
    const replenishRatio = tracker.replenishedNotional / Math.max(this.effectiveIcebergDisplayedFloor, tracker.peakNotional);
    const replRatioNorm = Math.min(1, replenishRatio / 2.2);
    const replSizeNorm = Math.min(1, tracker.replenishedNotional / Math.max(1, this.effectiveIcebergMinReplenish * 2.5));
    const fStructure = +Math.min(1, Math.max(0.15, replRatioNorm * 0.50 + replSizeNorm * 0.50)).toFixed(3);

    const refillNorm = Math.min(1, (tracker.refillCount - 1) / 3.5);
    const absorbedNorm = Math.min(1, tracker.tradedNotional / Math.max(1, this.effectiveIcebergMinTraded * 2.5));
    const fExecution = +Math.min(1, Math.max(0.15, refillNorm * 0.45 + absorbedNorm * 0.55)).toFixed(3);

    const fFlow = this.computeUnifiedFlowFactor(bias, cvd, obi);
    const fPayoff = this.computeUnifiedPayoffFactor(
      netRrRatio,
      actualRiskBps,
      costProfile.totalCostBps,
      usedStructural
    );

    const factors: ConfidenceFactors = {
      structure: fStructure,
      execution: fExecution,
      flow: fFlow,
      payoff: fPayoff,
    };
    const { rawConfidenceScore, confidenceScore, confidence } = this.computeCalibratedConfidence(
      'ICEBERG_ABSORPTION',
      factors
    );

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
      rawConfidenceScore,
      factors,
      reasons: [
        `Anlık Giriş: ${entryPrice} (Emilim: ${price}) · Stop: ${stopPrice} (${actualRiskBps.toFixed(0)} bps) · Hedef: ${targetPrice}.`,
        `Net Kârlılık Modeli: Komisyon %${costProfile.feePct.toFixed(2)} (10 bps) + ½Spread ${costProfile.halfSpreadBps.toFixed(1)} bps · Net Hedef +${netRewardPct}% / Net Stop -${netRiskPct}% (Net R:R 1:${netRrRatio}).`,
        `Gerçek Likidite Yenilemesi: Tahtaya +$${this.formatCompact(tracker.replenishedNotional)} yeni limit emir eklendi (${tracker.refillCount}× yenilenme, $${this.formatCompact(tracker.tradedNotional)} karşılandı).`,
        `Kalibre Faktörler: Yapı %${Math.round(fStructure * 100)} · İcra %${Math.round(fExecution * 100)} · Akış %${Math.round(fFlow * 100)} (CVD ${cvd.direction}/OBI ${obi.aligned}) · Getiri %${Math.round(fPayoff * 100)} → Güven: %${confidenceScore} (${confidence})`,
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
    if (this.opportunities.length > 150) this.opportunities.pop();
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

    // Standardized [0..1] Microstructure Factors & Empirically Calibrated Confidence (no free +20 offset)
    const divRatio = Math.abs(cvdNotional) / Math.max(1, this.effectiveCvdThreshold);
    const fStructure = +Math.min(1, Math.max(0.18, (divRatio - 1.0) / 3.0)).toFixed(3);

    const s10Aligned = (bias === 'LONG' && cvd.s10 > 0) || (bias === 'SHORT' && cvd.s10 < 0);
    const s30Aligned = (bias === 'LONG' && cvd.s30 > 0) || (bias === 'SHORT' && cvd.s30 < 0);
    const s10Mag = Math.min(1, Math.abs(cvd.s10) / Math.max(1, this.effectiveCvdThreshold * 0.45));
    const fExecution = +Math.min(
      1,
      Math.max(
        0.15,
        (s10Aligned ? 0.45 : 0.12) + (s30Aligned ? 0.30 : 0.08) + (s10Aligned ? s10Mag * 0.25 : 0)
      )
    ).toFixed(3);

    const fFlow = this.computeUnifiedFlowFactor(bias, cvd, obi);
    const fPayoff = this.computeUnifiedPayoffFactor(
      netRrRatio,
      actualRiskBps,
      costProfile.totalCostBps,
      usedStructural
    );

    const factors: ConfidenceFactors = {
      structure: fStructure,
      execution: fExecution,
      flow: fFlow,
      payoff: fPayoff,
    };
    const { rawConfidenceScore, confidenceScore, confidence } = this.computeCalibratedConfidence(
      'DELTA_DIVERGENCE',
      factors
    );

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
      rawConfidenceScore,
      factors,
      reasons: [
        `Net Akış Uyumsuzluğu: Fiyat %${priceDeltaPct.toFixed(2)} hareket ederken 60s CVD $${this.formatCompact(cvdNotional)} baskı üretti.`,
        `Anlık Giriş: ${entryPrice} · Stop: ${stopPrice} (${actualRiskBps.toFixed(0)} bps) · Hedef: ${targetPrice}.`,
        `Net Kârlılık Modeli: Komisyon %${costProfile.feePct.toFixed(2)} (10 bps) + ½Spread ${costProfile.halfSpreadBps.toFixed(1)} bps · Net Hedef +${netRewardPct}% / Net Stop -${netRiskPct}% (Net R:R 1:${netRrRatio}).`,
        `Kalibre Faktörler: Yapı %${Math.round(fStructure * 100)} · İcra %${Math.round(fExecution * 100)} · Akış %${Math.round(fFlow * 100)} (CVD ${cvd.direction}/OBI ${obi.aligned}) · Getiri %${Math.round(fPayoff * 100)} → Güven: %${confidenceScore} (${confidence})`,
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
    if (this.opportunities.length > 150) this.opportunities.pop();
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
    // Strictly pause lifecycle evaluation when orderbook snapshot or sequence stream is not synchronized
    if (!this.isOrderbookSynced() || !currentPrice || !this.opportunities.length) return;

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

      // If card belongs to a different symbol than currently active book, mark it CANCELLED (user switched symbol) so it does not pollute stats
      if (card.symbol !== this.symbol) {
        card.status = 'CANCELLED';
        card.exitPrice = card.currentPrice || card.entryPrice;
        card.resolvedAt = now;
        anyResolved = true;
        if (this.onOpportunityUpdated) this.onOpportunityUpdated(card);
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

        // Conservative Priority Rule: If both Stop and Target are touched within the same tick/candle update,
        // ALWAYS evaluate STOP LOSS FIRST to prevent optimistic look-ahead bias.
        if (checkLow <= card.stopPrice) {
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
        } else if (checkHigh >= card.targetPrice) {
          // Target reached: Executable Bid price rose to or above targetPrice without breaching stopPrice
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

        // Conservative Priority Rule: Always evaluate STOP LOSS FIRST before Target on the same tick/candle update
        if (checkHigh >= card.stopPrice) {
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
        } else if (checkLow <= card.targetPrice) {
          // Target reached: Executable Ask price fell to or below targetPrice without breaching stopPrice
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

  // Statistical Performance & Equity Curve Analytics of generated scalping opportunities:
  // 1. CANCELLED cards (e.g. symbol switched while card was active) are strictly excluded from all stats.
  // 2. EXPIRED cards ARE included in resolvedCount and winRate denominator (never hidden).
  // 3. Portfolio performance is modeled via a position-sized Equity Curve ($1,000 initial equity, 1% account risk = 1R per trade)
  //    plus 1x compounded net return %, rather than a naive sum of unweighted percentages.
  public getOpportunityStats(): OpportunityStats {
    const total = this.opportunities.length;
    const active = this.opportunities.filter((o) => o.status === 'ACTIVE');
    const hits = this.opportunities.filter((o) => o.status === 'HIT_TARGET');
    const stops = this.opportunities.filter((o) => o.status === 'STOPPED');
    const expired = this.opportunities.filter((o) => o.status === 'EXPIRED');
    const cancelled = this.opportunities.filter((o) => o.status === 'CANCELLED');

    // Only completed market outcomes (HIT_TARGET, STOPPED, EXPIRED) enter statistics; CANCELLED & ACTIVE are excluded
    const resolved = this.opportunities.filter(
      (o): o is OpportunityCard & { status: 'HIT_TARGET' | 'STOPPED' | 'EXPIRED' } =>
        o.status === 'HIT_TARGET' || o.status === 'STOPPED' || o.status === 'EXPIRED'
    );
    const resolvedCount = resolved.length;

    // A trade is a net win ONLY if its Net PnL (after commission + half-spread) is strictly > 0
    // EXPIRED trades are included in the denominator (resolvedCount); negative/flat EXPIRED trades count as losses
    const winCount = resolved.filter((o) => (o.pnlPct ?? 0) > 0).length;
    const lossCount = resolvedCount - winCount;

    const winRate = resolvedCount > 0 ? +((winCount / resolvedCount) * 100).toFixed(1) : 0;
    const targetHitRate = resolvedCount > 0 ? +((hits.length / resolvedCount) * 100).toFixed(1) : 0;

    // Chronological Equity Curve & Risk-Sized Position Model ($1,000 starting capital, 1% equity risk = 1R per trade)
    const initialEquity = 1000;
    const riskPerTradeFrac = 0.01; // 1% of current equity risked per trade
    let equity = initialEquity;
    let peakEquity = initialEquity;
    let maxDrawdownPct = 0;
    let compounded1x = 1.0;
    let totalR = 0;

    const chronological = [...resolved].sort(
      (a, b) => (a.resolvedAt || a.timestamp) - (b.resolvedAt || b.timestamp)
    );

    const equityCurve: EquityPoint[] = [];

    for (const o of chronological) {
      const feePct = o.feePct ?? OrderbookEngine.ROUND_TRIP_TAKER_FEE_PCT;
      const halfSpreadPct = ((o.spreadBps ?? 2.0) / 2) / 100;
      const grossStopPct = o.riskPct && o.riskPct > 0
        ? o.riskPct
        : Math.max(0.25, (Math.abs(o.entryPrice - o.stopPrice) / Math.max(1e-9, o.entryPrice)) * 100);
      // Total net loss % if Stop Loss is hit (stop distance + commission + half-spread)
      const netStopPct = Math.max(0.15, grossStopPct + feePct + halfSpreadPct);
      const netPnlPct = o.pnlPct ?? -(feePct + halfSpreadPct);

      // Position Notional (USDT) sized so that a full netStopPct loss equals 1% of current equity (capped at 5x leverage)
      const riskBudgetUsdt = equity * riskPerTradeFrac;
      const positionUsdt = Math.min(equity * 5, riskBudgetUsdt / (netStopPct / 100));

      const pnlUsdt = positionUsdt * (netPnlPct / 100);
      const rMultiple = netPnlPct / netStopPct;

      equity = Math.max(0, equity + pnlUsdt);
      if (equity > peakEquity) peakEquity = equity;
      if (peakEquity > 0) {
        const dd = ((peakEquity - equity) / peakEquity) * 100;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }

      compounded1x *= Math.max(0, 1 + netPnlPct / 100);
      totalR += rMultiple;

      equityCurve.push({
        ts: o.resolvedAt || o.timestamp,
        equity: +equity.toFixed(2),
        pnlUsdt: +pnlUsdt.toFixed(2),
        rMultiple: +rMultiple.toFixed(2),
        symbol: o.symbol,
        status: o.status,
      });
    }

    const currentEquity = +equity.toFixed(2);
    const netProfitUsdt = +(currentEquity - initialEquity).toFixed(2);
    const equityReturnPct = +(((currentEquity - initialEquity) / initialEquity) * 100).toFixed(2);
    const compoundedPnLPct = +((compounded1x - 1) * 100).toFixed(2);
    const roundedTotalR = +totalR.toFixed(2);
    const expectancyR = resolvedCount > 0 ? +(totalR / resolvedCount).toFixed(2) : 0;

    // Helper to compute realized R-multiple for any resolved card
    const computeCardR = (o: OpportunityCard) => {
      const feePct = o.feePct ?? OrderbookEngine.ROUND_TRIP_TAKER_FEE_PCT;
      const halfSpreadPct = ((o.spreadBps ?? 2.0) / 2) / 100;
      const grossStopPct =
        o.riskPct && o.riskPct > 0
          ? o.riskPct
          : Math.max(0.25, (Math.abs(o.entryPrice - o.stopPrice) / Math.max(1e-9, o.entryPrice)) * 100);
      const netStopPct = Math.max(0.15, grossStopPct + feePct + halfSpreadPct);
      const netPnlPct = o.pnlPct ?? -(feePct + halfSpreadPct);
      return netPnlPct / netStopPct;
    };

    // Empirical Confidence Bucket Breakdown: HIGH (≥78), MEDIUM (58-77), LOW (<58)
    const buildBucket = (
      tier: 'HIGH' | 'MEDIUM' | 'LOW',
      label: string,
      cards: (OpportunityCard & { status: 'HIT_TARGET' | 'STOPPED' | 'EXPIRED' })[]
    ): ConfidenceBucketStats => {
      const n = cards.length;
      if (n === 0) {
        return {
          tier,
          label,
          resolvedCount: 0,
          winCount: 0,
          lossCount: 0,
          hitCount: 0,
          stopCount: 0,
          expiredCount: 0,
          winRate: 0,
          targetHitRate: 0,
          avgScore: 0,
          avgNetPnlPct: 0,
          expectancyR: 0,
          totalR: 0,
        };
      }
      const wCount = cards.filter((c) => (c.pnlPct ?? 0) > 0).length;
      const hCount = cards.filter((c) => c.status === 'HIT_TARGET').length;
      const sCount = cards.filter((c) => c.status === 'STOPPED').length;
      const eCount = cards.filter((c) => c.status === 'EXPIRED').length;
      const sumScore = cards.reduce((acc, c) => acc + (c.confidenceScore || 60), 0);
      const sumPnl = cards.reduce((acc, c) => acc + (c.pnlPct ?? 0), 0);
      const sumR = cards.reduce((acc, c) => acc + computeCardR(c), 0);

      return {
        tier,
        label,
        resolvedCount: n,
        winCount: wCount,
        lossCount: n - wCount,
        hitCount: hCount,
        stopCount: sCount,
        expiredCount: eCount,
        winRate: +((wCount / n) * 100).toFixed(1),
        targetHitRate: +((hCount / n) * 100).toFixed(1),
        avgScore: Math.round(sumScore / n),
        avgNetPnlPct: +(sumPnl / n).toFixed(2),
        expectancyR: +(sumR / n).toFixed(2),
        totalR: +sumR.toFixed(2),
      };
    };

    const highCards = resolved.filter((o) => (o.confidenceScore ?? 0) >= 78);
    const medCards = resolved.filter((o) => (o.confidenceScore ?? 0) >= 58 && (o.confidenceScore ?? 0) < 78);
    const lowCards = resolved.filter((o) => (o.confidenceScore ?? 0) < 58);

    const confidenceBuckets = {
      HIGH: buildBucket('HIGH', 'HIGH (≥78)', highCards),
      MEDIUM: buildBucket('MEDIUM', 'MEDIUM (58–77)', medCards),
      LOW: buildBucket('LOW', 'LOW (<58)', lowCards),
    };

    // Breakdown by Signal Type
    const typeDefinitions: { type: OpportunityCard['type']; label: string }[] = [
      { type: 'DEFENDED_WALL', label: '🛡️ Duvar Savunması' },
      { type: 'VACUUM_SWEEP', label: '⚡ Sweep Kırılımı' },
      { type: 'ICEBERG_ABSORPTION', label: '🧊 Iceberg Emilim' },
      { type: 'DELTA_DIVERGENCE', label: '📊 Delta Uyumsuzluğu' },
    ];

    const typeBreakdown: SignalTypeStats[] = typeDefinitions.map(({ type, label }) => {
      const cards = resolved.filter((o) => o.type === type);
      const n = cards.length;
      if (n === 0) {
        return { type, label, resolvedCount: 0, winCount: 0, winRate: 0, expectancyR: 0, avgScore: 0 };
      }
      const wCount = cards.filter((c) => (c.pnlPct ?? 0) > 0).length;
      const sumR = cards.reduce((acc, c) => acc + computeCardR(c), 0);
      const sumScore = cards.reduce((acc, c) => acc + (c.confidenceScore || 60), 0);
      return {
        type,
        label,
        resolvedCount: n,
        winCount: wCount,
        winRate: +((wCount / n) * 100).toFixed(1),
        expectancyR: +(sumR / n).toFixed(2),
        avgScore: Math.round(sumScore / n),
      };
    });

    // Brier Calibration Score & Monotonicity Verification (Does HIGH >= MEDIUM >= LOW hold empirically?)
    let brierSum = 0;
    for (const o of resolved) {
      const prob = Math.min(0.95, Math.max(0.05, ((o.confidenceScore || 60) - 25) / 75));
      const actual = (o.pnlPct ?? 0) > 0 ? 1 : 0;
      brierSum += (prob - actual) * (prob - actual);
    }
    const brierScore = resolvedCount > 0 ? +(brierSum / resolvedCount).toFixed(3) : 0;

    const highVsMedWinDelta = +(confidenceBuckets.HIGH.winRate - confidenceBuckets.MEDIUM.winRate).toFixed(1);
    const highVsLowWinDelta = +(confidenceBuckets.HIGH.winRate - confidenceBuckets.LOW.winRate).toFixed(1);
    const highVsMedRDelta = +(confidenceBuckets.HIGH.expectancyR - confidenceBuckets.MEDIUM.expectancyR).toFixed(2);

    const calWeights = this.getCalibratedFactorWeights();
    let calStatus: ConfidenceCalibration['status'] = 'INSUFFICIENT_DATA';
    let calStatusText = 'Kalibrasyon ölçümü için kapanmış işlem verisi toplanıyor';

    const hasHigh = confidenceBuckets.HIGH.resolvedCount > 0;
    const hasMed = confidenceBuckets.MEDIUM.resolvedCount > 0;
    const hasLow = confidenceBuckets.LOW.resolvedCount > 0;

    if (resolvedCount >= 2 && (hasHigh || hasMed)) {
      if (hasHigh && hasMed) {
        const highBeatsMed =
          confidenceBuckets.HIGH.winRate >= confidenceBuckets.MEDIUM.winRate &&
          (!hasLow || confidenceBuckets.MEDIUM.winRate >= confidenceBuckets.LOW.winRate);
        const highBeatsMedR = confidenceBuckets.HIGH.expectancyR >= confidenceBuckets.MEDIUM.expectancyR;

        if (highBeatsMed) {
          calStatus = 'MONOTONIC_VALID';
          calStatusText = `Doğrulandı: HIGH (%${confidenceBuckets.HIGH.winRate}) ≥ MEDIUM (%${confidenceBuckets.MEDIUM.winRate})${
            hasLow ? ` ≥ LOW (%${confidenceBuckets.LOW.winRate})` : ''
          }`;
        } else if (highBeatsMedR) {
          calStatus = 'PARTIAL_VALID';
          calStatusText = `R-Beklentisi Kalibre: HIGH (${confidenceBuckets.HIGH.expectancyR}R) ≥ MEDIUM (${confidenceBuckets.MEDIUM.expectancyR}R) · Kazanma farkı ${highVsMedWinDelta}%`;
        } else {
          calStatus = 'INVERTED_WARNING';
          calStatusText = `Kalibrasyon Uyarısı: HIGH (%${confidenceBuckets.HIGH.winRate}) < MEDIUM (%${confidenceBuckets.MEDIUM.winRate}) — Bayesyen ağırlık düzeltmesi aktif`;
        }
      } else if (hasHigh && hasLow) {
        if (confidenceBuckets.HIGH.winRate >= confidenceBuckets.LOW.winRate) {
          calStatus = 'MONOTONIC_VALID';
          calStatusText = `Doğrulandı: HIGH (%${confidenceBuckets.HIGH.winRate}) ≥ LOW (%${confidenceBuckets.LOW.winRate})`;
        } else {
          calStatus = 'INVERTED_WARNING';
          calStatusText = `Kalibrasyon Uyarısı: HIGH (%${confidenceBuckets.HIGH.winRate}) < LOW (%${confidenceBuckets.LOW.winRate}) — Ağırlıklar sıkılaştırılıyor`;
        }
      } else {
        calStatus = 'PARTIAL_VALID';
        calStatusText = `${resolvedCount} kapanmış işlem kaydedildi — Kademeler arası karşılaştırma için örneklem birikiyor`;
      }
    }

    const calibration: ConfidenceCalibration = {
      status: calStatus,
      statusText: calStatusText,
      highVsMedWinDelta,
      highVsLowWinDelta,
      highVsMedRDelta,
      brierScore,
      sampleSize: resolvedCount,
      weights: {
        structure: calWeights.structure,
        execution: calWeights.execution,
        flow: calWeights.flow,
        payoff: calWeights.payoff,
        isEmpirical: calWeights.isEmpirical,
      },
    };

    return {
      total,
      activeCount: active.length,
      hitCount: hits.length,
      stopCount: stops.length,
      expiredCount: expired.length,
      cancelledCount: cancelled.length,
      resolvedCount,
      winCount,
      lossCount,
      winRate,
      targetHitRate,
      initialEquity,
      currentEquity,
      netProfitUsdt,
      equityReturnPct,
      compoundedPnLPct,
      totalR: roundedTotalR,
      expectancyR,
      maxDrawdownPct: +maxDrawdownPct.toFixed(2),
      equityCurve,
      totalPnL: equityReturnPct,
      confidenceBuckets,
      typeBreakdown,
      calibration,
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
