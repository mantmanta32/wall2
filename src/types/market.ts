export interface Candle {
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AggTrade {
  ts: number;
  price: number;
  qty: number;
  notional: number;
  isBuyerMaker: boolean; // true = sell taker, false = buy taker
  side: 'buy' | 'sell';
}

export interface ForceOrder {
  ts: number;
  price: number;
  qty: number;
  notional: number;
  side: 'BUY' | 'SELL';
  type: 'LONG_LIQ' | 'SHORT_LIQ';
}

export interface WallRecord {
  price: number;
  side: 'B' | 'A';
  notional: number;
  peakNotional: number;
  bornTs: number;
  lastTouchTs: number;
  touchCount: number;
  tradedNotional: number;
  status: 'active' | 'defended' | 'consumed' | 'pulled';
  label: string;
}

export interface FlowEvent {
  id: string;
  type: 'WHALE' | 'DOM SWEEP' | 'ICEBERG' | 'DELTA BURST' | 'SPOOF PULL' | 'SAVUNULDU' | 'DELTA DIVERGENCE';
  severity: 'high' | 'medium' | 'low';
  text: string;
  side?: 'buy' | 'sell';
  ts: number;
  price?: number;
}

export interface ConfidenceFactors {
  structure: number; // [0..1] Normalized liquidity depth, retention & structural placement
  execution: number; // [0..1] Normalized absorption, touch/bounce, sweep ratio or short-term trigger
  flow: number;      // [0..1] Unified Multi-CVD + Multi-OBI alignment (0.5 = neutral, <0.5 opposing, >0.5 aligned)
  payoff: number;    // [0..1] Net R:R & execution cost efficiency after 10 bps fee + half-spread
}

export interface OpportunityCard {
  id: string;
  symbol: string;
  type: 'DEFENDED_WALL' | 'VACUUM_SWEEP' | 'ICEBERG_ABSORPTION' | 'DELTA_DIVERGENCE';
  title: string;
  bias: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskPct: number;
  rrRatio: number;
  netRrRatio?: number;
  feePct?: number;
  spreadBps?: number;
  grossPnlPct?: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  confidenceScore: number;
   rawConfidenceScore?: number;
  factors?: ConfidenceFactors;
  reasons: string[];
  timestamp: number;
  status: 'ACTIVE' | 'HIT_TARGET' | 'STOPPED' | 'EXPIRED' | 'CANCELLED';
  currentPrice?: number;
  postEntryHigh?: number;
  postEntryLow?: number;
  progressPct?: number;
  maxDurationSec?: number;
  exitPrice?: number;
  resolvedAt?: number;
  durationSec?: number;
  pnlPct?: number;
}

export interface EquityPoint {
  ts: number;
  equity: number;
  pnlUsdt: number;
  rMultiple: number;
  symbol: string;
  status: 'HIT_TARGET' | 'STOPPED' | 'EXPIRED';
}

export interface ConfidenceBucketStats {
  tier: 'HIGH' | 'MEDIUM' | 'LOW';
  label: string;
  resolvedCount: number;
  winCount: number;
  lossCount: number;
  hitCount: number;
  stopCount: number;
  expiredCount: number;
  winRate: number;
  targetHitRate: number;
  avgScore: number;
  avgNetPnlPct: number;
  expectancyR: number;
  totalR: number;
}

export interface SignalTypeStats {
  type: 'DEFENDED_WALL' | 'VACUUM_SWEEP' | 'ICEBERG_ABSORPTION' | 'DELTA_DIVERGENCE';
  label: string;
  resolvedCount: number;
  winCount: number;
  winRate: number;
  expectancyR: number;
  avgScore: number;
}

export interface ConfidenceCalibration {
  status: 'INSUFFICIENT_DATA' | 'MONOTONIC_VALID' | 'PARTIAL_VALID' | 'INVERTED_WARNING';
  statusText: string;
  highVsMedWinDelta: number;
  highVsLowWinDelta: number;
  highVsMedRDelta: number;
  brierScore: number;
  sampleSize: number;
  weights: {
    structure: number;
    execution: number;
    flow: number;
    payoff: number;
    isEmpirical: boolean;
  };
}

export interface OpportunityStats {
  total: number;
  activeCount: number;
  hitCount: number;
  stopCount: number;
  expiredCount: number;
  cancelledCount: number;
  resolvedCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  targetHitRate: number;
  initialEquity: number;
  currentEquity: number;
  netProfitUsdt: number;
  equityReturnPct: number;
  compoundedPnLPct: number;
  totalR: number;
  expectancyR: number;
  maxDrawdownPct: number;
  equityCurve: EquityPoint[];
  totalPnL: number;
  confidenceBuckets: {
    HIGH: ConfidenceBucketStats;
    MEDIUM: ConfidenceBucketStats;
    LOW: ConfidenceBucketStats;
  };
  typeBreakdown: SignalTypeStats[];
  calibration: ConfidenceCalibration;
}


export interface MultiCVDState {
  s10: number;
  s30: number;
  s60: number;
  s180: number;
  direction: 'BULL' | 'BEAR' | 'FLAT';
  accelerating: boolean;
  allAligned: boolean;
}

export interface MultiOBIState {
  s5: number;
  s15: number;
  s30: number;
  s60: number;
  aligned: 'BULL' | 'BEAR' | 'MIXED';
  trend: 'RISING' | 'FALLING' | 'FLAT';
  strength: number;
}

export type LiquidityTier = 'MEGA_CAP' | 'LARGE_CAP' | 'MID_CAP' | 'SMALL_CAP' | 'MICRO_CAP';

export interface AppSettings {
  // Orderbook / Depth
  showLadder: boolean;
  showHeatmap: boolean;
  showWallRays: boolean;
  wallPct: number; // percentile threshold (80-99)
  wallMinAgeSec: number; // minimum persistence in seconds (default 25)
  whaleMinUsdt: number; // min whale notional (e.g. 100000)
  autoScaleThresholds: boolean; // adaptive threshold scaling based on coin liquidity tier (BTC vs Altcoins)
  
  // Indicators & Overlays
  showMa: boolean;
  showSar: boolean;
  showVol: boolean;
  showBB: boolean;
  showVwap: boolean;
  showRsi: boolean;
  showMacd: boolean;
  
  // Parameters
  ma1: number;
  ma2: number;
  ma3: number;
  sarStep: number;
  sarMax: number;
  
  // Audio & Alerts
  alertSound: boolean;
  alertSoundVol: number;
  alertVibrate: boolean;
  alertOnHighFlow: boolean;
  alertOnOpportunity: boolean;
  
  // Theme
  dark: boolean;
}
