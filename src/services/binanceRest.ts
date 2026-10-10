import { Candle } from '../types/market';

export const BINANCE_REST_BASE = 'https://fapi.binance.com';

export interface SymbolMeta {
  symbol: string;
  tickSize: number;
  precision: number;
}

// Strict Genuine Data: No mock, fake, or synthetic data generation.

export async function fetchExchangeInfo(): Promise<{ symbols: string[]; meta: Record<string, SymbolMeta> }> {
  const fallbackSymbols = [
    'ALLOUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 
    'BNBUSDT', 'XRPUSDT', 'SUIUSDT', 'NEARUSDT', 'AVAXUSDT', 'RLCUSDT'
  ];
  const meta: Record<string, SymbolMeta> = {};
  
  // Set defaults
  fallbackSymbols.forEach(s => {
    const tick = s.includes('BTC') ? 0.1 :
                 s.includes('ETH') ? 0.01 :
                 s.includes('SOL') ? 0.01 :
                 s.includes('ALLO') ? 0.00001 : 0.0001;
    meta[s] = { symbol: s, tickSize: tick, precision: Math.max(0, Math.round(-Math.log10(tick))) };
  });

  try {
    const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/exchangeInfo`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const symbols: string[] = [];
    
    if (Array.isArray(data.symbols)) {
      data.symbols.forEach((s: { contractType: string; quoteAsset: string; status: string; symbol: string; filters: Array<{ filterType: string; tickSize?: string }> }) => {
        if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING') {
          symbols.push(s.symbol);
          const filter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
          const tick = filter && filter.tickSize ? parseFloat(filter.tickSize) : 0.0001;
          meta[s.symbol] = {
            symbol: s.symbol,
            tickSize: tick,
            precision: Math.max(0, Math.round(-Math.log10(tick)))
          };
        }
      });
      symbols.sort();
      return { symbols: symbols.length ? symbols : fallbackSymbols, meta };
    }
  } catch (err) {
    console.warn('Binance exchangeInfo fetch failed, using cached symbols list:', err);
  }

  return { symbols: fallbackSymbols, meta };
}

export async function fetchKlines(symbol: string, interval = '5m', limit = 500): Promise<Candle[]> {
  try {
    const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      return data.map((k: (number | string)[]) => ({
        time: Math.floor(Number(k[0]) / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      }));
    }
  } catch (err) {
    console.warn(`Binance REST klines failed for ${symbol} ${interval}:`, err);
  }
  return [];
}

export async function fetchDepthSnapshot(symbol: string, limit = 1000): Promise<{ bids: [number, number][]; asks: [number, number][]; lastUpdateId: number } | null> {
  try {
    const res = await fetch(
      `${BINANCE_REST_BASE}/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}&_t=${Date.now()}`,
      { cache: 'no-store' }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const bids: [number, number][] = (data.bids || []).map(([p, q]: [string, string]) => [parseFloat(p), parseFloat(q)]);
    const asks: [number, number][] = (data.asks || []).map(([p, q]: [string, string]) => [parseFloat(p), parseFloat(q)]);
    return {
      bids,
      asks,
      lastUpdateId: Number(data.lastUpdateId) || 0
    };
  } catch (err) {
    console.warn(`Depth snapshot failed for ${symbol}:`, err);
    return null;
  }
}

export async function fetch24hrTicker(symbol: string): Promise<{
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
} | null> {
  try {
    const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const lastPrice = Number(data.lastPrice) || 0;
    const volume = Number(data.volume) || 0;
    const quoteVolume = Number(data.quoteVolume) || (volume * lastPrice) || 0;
    return {
      lastPrice,
      priceChangePercent: Number(data.priceChangePercent) || 0,
      highPrice: Number(data.highPrice) || 0,
      lowPrice: Number(data.lowPrice) || 0,
      volume,
      quoteVolume,
    };
  } catch {
    return null;
  }
}

export async function fetchOpenInterest(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Number(data.openInterest) || null;
  } catch {
    return null;
  }
}

export async function fetchFundingRate(symbol: string): Promise<{ rate: number; markPrice: number } | null> {
  try {
    const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      rate: Number(data.lastFundingRate) || 0,
      markPrice: Number(data.markPrice) || 0
    };
  } catch {
    return null;
  }
}
