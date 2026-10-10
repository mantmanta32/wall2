import { Candle } from '../types/market';
import { OrderbookEngine } from './orderbookEngine';
import { fetchDepthSnapshot } from './binanceRest';

export const WS_MARKET_BASE = 'wss://fstream.binance.com/market';
export const WS_PUBLIC_BASE = 'wss://fstream.binance.com/public';

export class BinanceWsManager {
  private symbol: string;
  private interval: string;
  private engine: OrderbookEngine;

  private klineWs: WebSocket | null = null;
  private marketWs: WebSocket | null = null;
  private depthWs: WebSocket | null = null;

  public isKlineConnected = false;
  public isMarketConnected = false;
  public isDepthConnected = false;

  private isStopped = false;
  private isSyncingSnapshot = false;
  private pendingResyncRequest = false;
  private resyncRetryTimer: number | null = null;
  private depthReconnectTimer: number | null = null;
  private klineReconnectTimer: number | null = null;
  private marketReconnectTimer: number | null = null;
  private syncWatchdogTimer: number | null = null;
  private firstDepthEventResolve: (() => void) | null = null;

  public onKlineUpdate?: (candle: Candle, isClosed: boolean) => void;
  public onConnectionChange?: (connected: boolean) => void;

  private handleVisibilityChange = () => {
    if (this.isStopped) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      if (!this.depthWs || this.depthWs.readyState !== WebSocket.OPEN) {
        this.connectDepthStream();
      } else if (!this.engine.isSnapshotLoaded || !this.engine.depthSynced) {
        this.resyncSnapshot(false);
      }
    }
  };

  constructor(symbol: string, interval: string, engine: OrderbookEngine) {
    this.symbol = symbol.toLowerCase();
    this.interval = interval;
    this.engine = engine;

    // Attach snapshot resync request from engine if depth sequence breaks
    this.engine.onRequestSnapshot = () => {
      this.notifyConnection();
      this.resyncSnapshot(false);
    };
    this.engine.onSyncStateChange = () => {
      this.notifyConnection();
    };
  }

  public setSymbolAndInterval(symbol: string, interval: string) {
    this.symbol = symbol.toLowerCase();
    this.interval = interval;
    this.reconnect();
  }

  public setIntervalOnly(interval: string) {
    if (this.interval === interval && this.isKlineConnected) return;
    this.interval = interval;
    if (this.klineReconnectTimer !== null) {
      clearTimeout(this.klineReconnectTimer);
      this.klineReconnectTimer = null;
    }
    if (this.klineWs) {
      this.klineWs.onclose = null;
      try {
        this.klineWs.close();
      } catch {}
      this.klineWs = null;
    }
    this.isKlineConnected = false;
    if (!this.isStopped) {
      this.connectKline();
    }
  }

  public connect() {
    this.isStopped = false;
    this.clearTimers();
    this.connectKline();
    this.connectMarketStream();
    this.connectDepthStream();
    this.startSyncWatchdog();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private clearTimers() {
    if (this.resyncRetryTimer !== null) {
      clearTimeout(this.resyncRetryTimer);
      this.resyncRetryTimer = null;
    }
    if (this.depthReconnectTimer !== null) {
      clearTimeout(this.depthReconnectTimer);
      this.depthReconnectTimer = null;
    }
    if (this.klineReconnectTimer !== null) {
      clearTimeout(this.klineReconnectTimer);
      this.klineReconnectTimer = null;
    }
    if (this.marketReconnectTimer !== null) {
      clearTimeout(this.marketReconnectTimer);
      this.marketReconnectTimer = null;
    }
    if (this.syncWatchdogTimer !== null) {
      clearInterval(this.syncWatchdogTimer);
      this.syncWatchdogTimer = null;
    }
    if (this.firstDepthEventResolve) {
      const resolve = this.firstDepthEventResolve;
      this.firstDepthEventResolve = null;
      resolve();
    }
  }

  public disconnect() {
    this.isStopped = true;
    this.clearTimers();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    if (this.klineWs) {
      this.klineWs.onclose = null;
      try { this.klineWs.close(); } catch {}
      this.klineWs = null;
    }
    if (this.marketWs) {
      this.marketWs.onclose = null;
      try { this.marketWs.close(); } catch {}
      this.marketWs = null;
    }
    if (this.depthWs) {
      this.depthWs.onclose = null;
      try { this.depthWs.close(); } catch {}
      this.depthWs = null;
    }
    this.isKlineConnected = false;
    this.isMarketConnected = false;
    this.isDepthConnected = false;
    this.isSyncingSnapshot = false;
    this.pendingResyncRequest = false;
    if (this.onConnectionChange) this.onConnectionChange(false);
  }

  public reconnect() {
    this.disconnect();
    setTimeout(() => {
      this.connect();
    }, 150);
  }

  private startSyncWatchdog() {
    if (this.syncWatchdogTimer !== null) {
      clearInterval(this.syncWatchdogTimer);
    }
    this.syncWatchdogTimer = window.setInterval(() => {
      if (this.isStopped) return;
      if (
        this.isDepthConnected &&
        (!this.engine.isSnapshotLoaded || !this.engine.depthSynced) &&
        !this.isSyncingSnapshot
      ) {
        this.resyncSnapshot(false);
      }
    }, 2500);
  }

  private connectKline() {
    if (this.isStopped) return;
    const url = `${WS_MARKET_BASE}/ws/${this.symbol}@kline_${this.interval}`;
    const ws = new WebSocket(url);
    this.klineWs = ws;

    ws.onopen = () => {
      if (this.klineWs !== ws) return;
      this.isKlineConnected = true;
      this.notifyConnection();
    };

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.e === 'kline' && data.k) {
          const k = data.k;
          const candle: Candle = {
            time: Math.floor(k.t / 1000),
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
          };
          if (this.onKlineUpdate) {
            this.onKlineUpdate(candle, !!k.x);
          }
        }
      } catch {
        // parsing error
      }
    };

    ws.onclose = () => {
      if (this.klineWs !== ws) return;
      this.isKlineConnected = false;
      this.notifyConnection();
      if (!this.isStopped) {
        if (this.klineReconnectTimer !== null) clearTimeout(this.klineReconnectTimer);
        this.klineReconnectTimer = window.setTimeout(() => this.connectKline(), 2000);
      }
    };

    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  private connectMarketStream() {
    if (this.isStopped) return;
    if (this.marketWs) {
      this.marketWs.onclose = null;
      try { this.marketWs.close(); } catch {}
      this.marketWs = null;
    }
    const streams = [
      `${this.symbol}@aggTrade`,
      `${this.symbol}@markPrice@1s`,
      `${this.symbol}@forceOrder`
    ].join('/');
    const url = `${WS_MARKET_BASE}/stream?streams=${streams}`;
    const ws = new WebSocket(url);
    this.marketWs = ws;

    ws.onopen = () => {
      if (this.marketWs !== ws) return;
      this.isMarketConnected = true;
      this.notifyConnection();
    };

    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        const data = parsed.data || parsed;
        if (!data || !data.e) return;

        if (data.e === 'aggTrade') {
          const price = parseFloat(data.p);
          const qty = parseFloat(data.q);
          const isBuyerMaker = !!data.m;
          this.engine.onAggTrade({
            ts: data.T || Date.now(),
            price,
            qty,
            notional: price * qty,
            isBuyerMaker,
            side: isBuyerMaker ? 'sell' : 'buy',
          });
        } else if (data.e === 'forceOrder' && data.o) {
          const o = data.o;
          const price = parseFloat(o.p || o.ap);
          const qty = parseFloat(o.q || o.z);
          this.engine.onForceOrder({
            ts: data.E || Date.now(),
            price,
            qty,
            notional: price * qty,
            side: o.S,
            type: o.S === 'SELL' ? 'LONG_LIQ' : 'SHORT_LIQ',
          });
        }
      } catch {
        // error
      }
    };

    ws.onclose = () => {
      if (this.marketWs !== ws) return;
      this.isMarketConnected = false;
      this.notifyConnection();
      if (!this.isStopped) {
        if (this.marketReconnectTimer !== null) clearTimeout(this.marketReconnectTimer);
        this.marketReconnectTimer = window.setTimeout(() => this.connectMarketStream(), 2000);
      }
    };

    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  private connectDepthStream() {
    if (this.isStopped) return;
    if (this.depthReconnectTimer !== null) {
      clearTimeout(this.depthReconnectTimer);
      this.depthReconnectTimer = null;
    }
    if (this.depthWs) {
      this.depthWs.onclose = null;
      try { this.depthWs.close(); } catch {}
      this.depthWs = null;
    }

    // Prepare engine to buffer incoming WS depth updates from the new socket
    this.engine.beginDepthSync(true);

    // Connect to 100ms full depth stream
    const url = `${WS_PUBLIC_BASE}/ws/${this.symbol}@depth@100ms`;
    const ws = new WebSocket(url);
    this.depthWs = ws;

    ws.onopen = () => {
      if (this.depthWs !== ws || this.isStopped) return;
      this.isDepthConnected = true;
      this.notifyConnection();
      // Official Binance orderbook sync protocol:
      // Fetch REST snapshot AFTER depth WebSocket is open and buffering events
      this.resyncSnapshot(true);
    };

    ws.onmessage = (ev) => {
      if (this.depthWs !== ws || this.isStopped) return;
      try {
        const parsed = JSON.parse(ev.data);
        const data = parsed.data || parsed;
        if (data && data.b && data.a) {
          // Binance Futures depth stream contains:
          // e: "depthUpdate", E: Event time, T: Transaction time, s: Symbol,
          // U: First update ID in event, u: Final update ID in event, pu: Final update Id in last event
          this.engine.applyDepthUpdate(data.b, data.a, data.u, data.U, data.pu);
          if (this.firstDepthEventResolve) {
            const resolve = this.firstDepthEventResolve;
            this.firstDepthEventResolve = null;
            resolve();
          }
        }
      } catch {
        // parsing error
      }
    };

    ws.onclose = () => {
      if (this.depthWs !== ws) return;
      this.isDepthConnected = false;
      this.engine.beginDepthSync(true);
      this.notifyConnection();
      if (!this.isStopped) {
        if (this.depthReconnectTimer !== null) clearTimeout(this.depthReconnectTimer);
        this.depthReconnectTimer = window.setTimeout(() => {
          if (!this.isStopped) {
            this.connectDepthStream();
          }
        }, 1500);
      }
    };

    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  private scheduleResyncRetry(delayMs = 500) {
    if (this.isStopped) return;
    if (this.resyncRetryTimer !== null) {
      clearTimeout(this.resyncRetryTimer);
    }
    this.resyncRetryTimer = window.setTimeout(() => {
      this.resyncRetryTimer = null;
      if (!this.isStopped && (!this.engine.isSnapshotLoaded || !this.engine.depthSynced)) {
        this.resyncSnapshot(false);
      }
    }, delayMs);
  }

  private waitForFirstDepthEvent(timeoutMs = 250): Promise<void> {
    if (this.engine.hasBufferedDepthEvents()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.firstDepthEventResolve === done) {
          this.firstDepthEventResolve = null;
        }
        resolve();
      }, timeoutMs);

      const done = () => {
        clearTimeout(timer);
        resolve();
      };

      this.firstDepthEventResolve = done;
    });
  }

  // Fetch genuine 1000-level depth snapshot and apply with buffered WS sequence reconciliation
  public async resyncSnapshot(waitForFirstEvent = false) {
    if (this.isStopped) return;

    // Ensure engine is actively buffering incoming WS updates while snapshot is fetched
    if (this.engine.isSnapshotLoaded && !this.engine.depthSynced) {
      this.engine.beginDepthSync(false);
    }

    if (this.isSyncingSnapshot) {
      this.pendingResyncRequest = true;
      return;
    }

    this.isSyncingSnapshot = true;
    this.pendingResyncRequest = false;

    try {
      // Wait briefly for the first WS depth event so the buffer starts BEFORE the snapshot lastUpdateId
      if (waitForFirstEvent && !this.engine.hasBufferedDepthEvents()) {
        await this.waitForFirstDepthEvent(250);
      }
      if (this.isStopped) return;

      const targetSymbol = this.symbol.toUpperCase();
      const snap = await fetchDepthSnapshot(targetSymbol, 1000);
      if (this.isStopped || this.symbol.toUpperCase() !== targetSymbol) return;

      if (snap && (snap.bids.length > 0 || snap.asks.length > 0)) {
        const syncedOk = this.engine.applySnapshot(snap.bids, snap.asks, snap.lastUpdateId);
        if (!syncedOk) {
          // Snapshot was older than buffer; schedule immediate fresh snapshot
          this.scheduleResyncRetry(350);
        }
      } else {
        this.scheduleResyncRetry(1000);
      }
    } catch (err) {
      console.warn(`[BinanceWsManager] Failed to resync snapshot for ${this.symbol}:`, err);
      this.scheduleResyncRetry(1000);
    } finally {
      this.isSyncingSnapshot = false;
      this.notifyConnection();
      if (this.pendingResyncRequest && !this.isStopped && (!this.engine.isSnapshotLoaded || !this.engine.depthSynced)) {
        this.pendingResyncRequest = false;
        this.scheduleResyncRetry(250);
      }
    }
  }

  private notifyConnection() {
    if (this.onConnectionChange) {
      this.onConnectionChange(
        this.isKlineConnected &&
          this.isDepthConnected &&
          this.engine.isOrderbookSynced()
      );
    }
  }
}
