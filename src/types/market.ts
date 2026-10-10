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
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  confidenceScore: number;
  reasons: string[];
  timestamp: number;
  status: 'ACTIVE' | 'HIT_TARGET' | 'STOPPED' | 'EXPIRED';
  currentPrice?: number;
  progressPct?: number;
  maxDurationSec?: number;
  exitPrice?: number;
  resolvedAt?: number;
  durationSec?: number;
  pnlPct?: number;
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
