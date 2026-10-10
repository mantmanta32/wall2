// Dedicated Web Worker for Orderbook Microstructure Calculations
// Offloads O(N log N) percentile sorting, wall candidate filtering, distance-weighted OBI,
// and heatmap bin aggregation from the main UI thread.

export interface WorkerAnalyzeRequest {
  type: 'ANALYZE_BOOK';
  seq: number;
  now: number;
  midPrice: number;
  wallPct: number;
  effectiveWallFloor: number;
  needHeatmap: boolean;
  bids: [number, number][];
  asks: [number, number][];
}

export interface WorkerCandidate {
  price: number;
  side: 'B' | 'A';
  notional: number;
}

export interface WorkerHeatmapBin {
  side: 'B' | 'A';
  price: number;
  notional: number;
}

export interface WorkerAnalyzeResponse {
  type: 'ANALYZE_RESULT';
  seq: number;
  now: number;
  obi: number;
  threshold: number;
  candidates: WorkerCandidate[];
  heatmap?: {
    t: number;
    bins: WorkerHeatmapBin[];
    maxNotional: number;
  };
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkerAnalyzeRequest>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'ANALYZE_BOOK') return;

  const { seq, now, midPrice, wallPct, effectiveWallFloor, needHeatmap, bids, asks } = msg;
  if (!midPrice || midPrice <= 0) return;

  const obiMaxDist = midPrice * 0.015; // 1.5% band for distance-weighted OBI
  const decayScale = midPrice * 0.004;
  const wallBandRange = midPrice * 0.05; // 5.0% scalping band for walls & heatmap

  let weightedBids = 0;
  let weightedAsks = 0;

  const notionalList: number[] = [];
  const rawCandidates: WorkerCandidate[] = [];
  const heatBins: WorkerHeatmapBin[] = [];

  for (let i = 0; i < bids.length; i++) {
    const p = bids[i][0];
    const q = bids[i][1];
    const dist = Math.abs(midPrice - p);
    if (dist <= wallBandRange) {
      const notional = p * q;
      notionalList.push(notional);
      rawCandidates.push({ price: p, side: 'B', notional });
      if (needHeatmap) {
        heatBins.push({ side: 'B', price: p, notional });
      }
      if (dist <= obiMaxDist) {
        const w = Math.exp(-dist / decayScale);
        weightedBids += notional * w;
      }
    }
  }

  for (let i = 0; i < asks.length; i++) {
    const p = asks[i][0];
    const q = asks[i][1];
    const dist = Math.abs(p - midPrice);
    if (dist <= wallBandRange) {
      const notional = p * q;
      notionalList.push(notional);
      rawCandidates.push({ price: p, side: 'A', notional });
      if (needHeatmap) {
        heatBins.push({ side: 'A', price: p, notional });
      }
      if (dist <= obiMaxDist) {
        const w = Math.exp(-dist / decayScale);
        weightedAsks += notional * w;
      }
    }
  }

  const totalWeight = weightedBids + weightedAsks;
  const obi = totalWeight > 0 ? (weightedBids - weightedAsks) / totalWeight : 0;

  let threshold = effectiveWallFloor;
  if (notionalList.length > 0) {
    notionalList.sort((a, b) => a - b);
    const pIndex = Math.floor(notionalList.length * (wallPct / 100));
    const percentileThreshold = notionalList[Math.min(notionalList.length - 1, pIndex)] || 10000;
    threshold = Math.max(percentileThreshold, effectiveWallFloor);
  }

  // Filter candidates to only those >= 50% of effectiveWallFloor so main thread never processes dust levels
  const minCandidateNotional = effectiveWallFloor * 0.5;
  const candidates = rawCandidates.filter((c) => c.notional >= minCandidateNotional);

  let heatmap: WorkerAnalyzeResponse['heatmap'] | undefined;
  if (needHeatmap && heatBins.length > 0) {
    heatBins.sort((a, b) => b.notional - a.notional);
    const topBins = heatBins.slice(0, 250);
    const maxNotional = topBins.length ? topBins[0].notional : 10000;
    heatmap = {
      t: Math.floor(now / 1000),
      bins: topBins,
      maxNotional,
    };
  }

  const response: WorkerAnalyzeResponse = {
    type: 'ANALYZE_RESULT',
    seq,
    now,
    obi,
    threshold,
    candidates,
    heatmap,
  };

  ctx.postMessage(response);
};
