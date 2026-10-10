import React, { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts';
import { Candle, AppSettings, OpportunityCard } from '../types/market';
import { OrderbookEngine } from '../services/orderbookEngine';

interface ChartWithOrderbookProps {
  candles: Candle[];
  symbol: string;
  engine: OrderbookEngine;
  settings: AppSettings;
  precision?: number;
  tickSize?: number;
  activeOpportunity?: OpportunityCard | null;
}

export const ChartWithOrderbook: React.FC<ChartWithOrderbookProps> = ({
  candles,
  symbol,
  engine,
  settings,
  precision = 4,
  tickSize = 0.0001,
  activeOpportunity,
}) => {
  const activeOppRef = useRef<OpportunityCard | null | undefined>(activeOpportunity);
  activeOppRef.current = activeOpportunity;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma1SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ma2SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ma3SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const sarSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpperSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const heatmapCanvasRef = useRef<HTMLCanvasElement>(null);
  const isDirtyRef = useRef(true);
  const lastOverlayDrawTsRef = useRef(0);
  const lastHeatmapDrawTsRef = useRef(0);
  const lastSyncStateRef = useRef<boolean>(false);

  // Initialize TradingView Lightweight Chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: {
        background: { color: 'transparent' },
        textColor: '#8b949e',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(42, 48, 56, 0.45)' },
        horzLines: { color: 'rgba(42, 48, 56, 0.45)' },
      },
      crosshair: {
        mode: 0,
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#2a3038',
      },
      rightPriceScale: {
        borderColor: '#2a3038',
        scaleMargins: {
          top: 0.08,
          bottom: 0.12,
        },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      priceFormat: {
        type: 'price',
        precision: precision,
        minMove: tickSize,
      },
    });

    const volSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: {
        top: 0.85,
        bottom: 0,
      },
      visible: false,
    });

    // MAs, SAR, VWAP & Bollinger Bands
    const ma1 = chart.addSeries(LineSeries, { color: '#e0b64c', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ma2 = chart.addSeries(LineSeries, { color: '#4c8ce0', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ma3 = chart.addSeries(LineSeries, { color: '#b06ce0', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const sar = chart.addSeries(LineSeries, { color: '#9aa4ae', lineStyle: LineStyle.Dotted, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const vwap = chart.addSeries(LineSeries, { color: '#38bdf8', lineStyle: LineStyle.Dashed, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const bbUpper = chart.addSeries(LineSeries, { color: 'rgba(139, 148, 158, 0.55)', lineStyle: LineStyle.Solid, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const bbLower = chart.addSeries(LineSeries, { color: 'rgba(139, 148, 158, 0.55)', lineStyle: LineStyle.Solid, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volSeriesRef.current = volSeries;
    ma1SeriesRef.current = ma1;
    ma2SeriesRef.current = ma2;
    ma3SeriesRef.current = ma3;
    sarSeriesRef.current = sar;
    vwapSeriesRef.current = vwap;
    bbUpperSeriesRef.current = bbUpper;
    bbLowerSeriesRef.current = bbLower;

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      isDirtyRef.current = true;
    });

    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries.length || !containerRef.current || !chartRef.current) return;
      const { width, height } = entries[0].contentRect;
      chartRef.current.resize(width, height);
      syncCanvasSizes();
      isDirtyRef.current = true;
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [symbol, precision, tickSize]);

  // Sync Canvas resolutions
  const syncCanvasSizes = () => {
    if (!containerRef.current) return;
    const dpr = window.devicePixelRatio || 1;
    const w = containerRef.current.clientWidth;
    const h = containerRef.current.clientHeight;

    [overlayCanvasRef.current, heatmapCanvasRef.current].forEach((cv) => {
      if (!cv) return;
      cv.width = w * dpr;
      cv.height = h * dpr;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      const ctx = cv.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    });
  };

  // Helper calculations for indicators
  const calculateSMA = (data: Candle[], period: number) => {
    const res: { time: UTCTimestamp; value: number }[] = [];
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j].close;
      }
      res.push({ time: data[i].time as UTCTimestamp, value: sum / period });
    }
    return res;
  };

  const calculatePSAR = (cs: Candle[]) => {
    if (cs.length < 3) return [];
    const res: { time: UTCTimestamp; value: number }[] = [];
    let up = cs[1].close >= cs[0].close;
    let s = up ? Math.min(cs[0].low, cs[1].low) : Math.max(cs[0].high, cs[1].high);
    let ep = up ? cs[1].high : cs[1].low;
    let af = settings.sarStep || 0.02;

    for (let i = 2; i < cs.length; i++) {
      s = s + af * (ep - s);
      if (up) s = Math.min(s, cs[i - 1].low, cs[i - 2].low);
      else s = Math.max(s, cs[i - 1].high, cs[i - 2].high);

      if (up && cs[i].low < s) {
        up = false;
        s = ep;
        ep = cs[i].low;
        af = settings.sarStep || 0.02;
      } else if (!up && cs[i].high > s) {
        up = true;
        s = ep;
        ep = cs[i].high;
        af = settings.sarStep || 0.02;
      } else {
        if (up && cs[i].high > ep) {
          ep = cs[i].high;
          af = Math.min(af + (settings.sarStep || 0.02), settings.sarMax || 0.2);
        }
        if (!up && cs[i].low < ep) {
          ep = cs[i].low;
          af = Math.min(af + (settings.sarStep || 0.02), settings.sarMax || 0.2);
        }
      }
      res.push({ time: cs[i].time as UTCTimestamp, value: s });
    }
    return res;
  };

  const calculateVWAP = (cs: Candle[]) => {
    const res: { time: UTCTimestamp; value: number }[] = [];
    let cumPV = 0;
    let cumV = 0;
    let currentDay = -1;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const day = Math.floor(c.time / 86400);
      if (day !== currentDay) {
        currentDay = day;
        cumPV = 0;
        cumV = 0;
      }
      const typicalPrice = (c.high + c.low + c.close) / 3;
      const vol = Math.max(c.volume, 1e-8);
      cumPV += typicalPrice * vol;
      cumV += vol;
      res.push({ time: c.time as UTCTimestamp, value: cumPV / cumV });
    }
    return res;
  };

  const calculateBollingerBands = (cs: Candle[], period = 20, mult = 2) => {
    const upper: { time: UTCTimestamp; value: number }[] = [];
    const lower: { time: UTCTimestamp; value: number }[] = [];
    for (let i = period - 1; i < cs.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += cs[i - j].close;
      }
      const mean = sum / period;
      let sqSum = 0;
      for (let j = 0; j < period; j++) {
        const diff = cs[i - j].close - mean;
        sqSum += diff * diff;
      }
      const std = Math.sqrt(sqSum / period);
      const t = cs[i].time as UTCTimestamp;
      upper.push({ time: t, value: mean + mult * std });
      lower.push({ time: t, value: mean - mult * std });
    }
    return { upper, lower };
  };

  // Update chart data whenever candles, settings, or symbol precision update
  useEffect(() => {
    if (!candleSeriesRef.current || !candles.length) return;

    candleSeriesRef.current.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    if (volSeriesRef.current) {
      if (settings.showVol) {
        volSeriesRef.current.setData(
          candles.map((c) => ({
            time: c.time as UTCTimestamp,
            value: c.volume,
            color: c.close >= c.open ? 'rgba(38,166,154,0.45)' : 'rgba(239,83,80,0.45)',
          }))
        );
      } else {
        volSeriesRef.current.setData([]);
      }
    }

    if (settings.showMa) {
      ma1SeriesRef.current?.setData(calculateSMA(candles, settings.ma1 || 9));
      ma2SeriesRef.current?.setData(calculateSMA(candles, settings.ma2 || 21));
      ma3SeriesRef.current?.setData(calculateSMA(candles, settings.ma3 || 50));
    } else {
      ma1SeriesRef.current?.setData([]);
      ma2SeriesRef.current?.setData([]);
      ma3SeriesRef.current?.setData([]);
    }

    if (settings.showSar) {
      sarSeriesRef.current?.setData(calculatePSAR(candles));
    } else {
      sarSeriesRef.current?.setData([]);
    }

    if (settings.showVwap) {
      vwapSeriesRef.current?.setData(calculateVWAP(candles));
    } else {
      vwapSeriesRef.current?.setData([]);
    }

    if (settings.showBB) {
      const { upper, lower } = calculateBollingerBands(candles, 20, 2);
      bbUpperSeriesRef.current?.setData(upper);
      bbLowerSeriesRef.current?.setData(lower);
    } else {
      bbUpperSeriesRef.current?.setData([]);
      bbLowerSeriesRef.current?.setData([]);
    }

    isDirtyRef.current = true;
  }, [candles, settings, symbol, precision, tickSize]);

  // Throttled RequestAnimationFrame Loop (220ms for overlay, 250ms for heatmap; immediate on chart pan/zoom/resize)
  useEffect(() => {
    let animationFrameId: number;
    isDirtyRef.current = true;

    const renderLoop = () => {
      const now = performance.now();
      const currentSynced = engine.isOrderbookSynced();
      if (currentSynced !== lastSyncStateRef.current) {
        lastSyncStateRef.current = currentSynced;
        isDirtyRef.current = true;
      }
      const dirty = isDirtyRef.current;

      if (dirty || now - lastOverlayDrawTsRef.current >= 200) {
        lastOverlayDrawTsRef.current = now;
        drawOrderbookOverlay();
      }

      if (settings.showHeatmap && currentSynced) {
        if (dirty || now - lastHeatmapDrawTsRef.current >= 250) {
          lastHeatmapDrawTsRef.current = now;
          drawLiquidityHeatmap();
        }
      } else if (dirty || !currentSynced) {
        const cv = heatmapCanvasRef.current;
        if (cv) {
          const ctx = cv.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
        }
      }

      if (dirty) {
        isDirtyRef.current = false;
      }

      animationFrameId = requestAnimationFrame(renderLoop);
    };

    animationFrameId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [settings]);

  // 1. IN-SITU DOM LADDER & WALL RAYS OVERLAY
  const drawOrderbookOverlay = () => {
    const cv = overlayCanvasRef.current;
    if (!cv || !chartRef.current || !candleSeriesRef.current || !containerRef.current) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const w = containerRef.current.clientWidth;
    const h = containerRef.current.clientHeight;

    ctx.clearRect(0, 0, w, h);

    const axisW = Math.max(0, Math.ceil(chartRef.current.priceScale('right').width() || 75));
    const chartRight = Math.max(0, w - axisW);

    // Strictly refuse to render stale DOM ladder, stale wall rays, or stale MID price when orderbook is out of sync
    if (!engine.isOrderbookSynced()) {
      const msg = '⚠️ DEFTER SENKRONİZE DEĞİL · YENİDEN EŞİTLENİYOR';
      ctx.font = 'bold 10.5px monospace';
      const tw = ctx.measureText(msg).width;
      const bx = Math.max(8, chartRight - tw - 20);
      const by = 10;
      ctx.fillStyle = 'rgba(22, 27, 34, 0.92)';
      ctx.fillRect(bx, by, tw + 14, 22);
      ctx.strokeStyle = 'rgba(239, 83, 80, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(bx, by, tw + 14, 22);
      ctx.fillStyle = '#ef5350';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(msg, bx + 7, by + 11);
      return;
    }

    const candleSeries = candleSeriesRef.current;

    // 0. In-Situ Right-Axis DOM Depth Ladder Histogram Bars (when showLadder is enabled)
    if (settings.showLadder && (engine.bidsBook.size > 0 || engine.asksBook.size > 0)) {
      const binPx = 4;
      const rows = Math.ceil(h / binPx);
      if (rows > 0 && chartRight > 0) {
        const bidBins = new Float64Array(rows);
        const askBins = new Float64Array(rows);
        const topP = candleSeries.coordinateToPrice(0);
        const botP = candleSeries.coordinateToPrice(h);
        const minVisP = topP !== null && botP !== null ? Math.min(topP, botP) : 0;
        const maxVisP = topP !== null && botP !== null ? Math.max(topP, botP) : Infinity;

        const priceToRow = (p: number) => {
          if (p < minVisP || p > maxVisP) return -1;
          const y = candleSeries.priceToCoordinate(p);
          if (y == null || y < 0 || y > h) return -1;
          return Math.min(rows - 1, Math.max(0, Math.floor(y / binPx)));
        };

        for (const [p, q] of engine.bidsBook) {
          const idx = priceToRow(p);
          if (idx >= 0) bidBins[idx] += p * q;
        }
        for (const [p, q] of engine.asksBook) {
          const idx = priceToRow(p);
          if (idx >= 0) askBins[idx] += p * q;
        }

        let maxBin = 0;
        for (let i = 0; i < rows; i++) {
          const m = Math.max(bidBins[i], askBins[i]);
          if (m > maxBin) maxBin = m;
        }
        if (maxBin > 0) {
          const maxBarWidth = Math.min(140, chartRight * 0.28);
          for (let i = 0; i < rows; i++) {
            const bVal = bidBins[i];
            const aVal = askBins[i];
            const val = Math.max(bVal, aVal);
            if (val <= 0) continue;
            const isBid = bVal >= aVal;
            const ratio = Math.min(1, val / maxBin);
            const barW = Math.max(2, ratio * maxBarWidth);
            const y = i * binPx;
            ctx.fillStyle = isBid
              ? `rgba(38, 166, 154, ${(0.18 + ratio * 0.45).toFixed(2)})`
              : `rgba(239, 83, 80, ${(0.18 + ratio * 0.45).toFixed(2)})`;
            ctx.fillRect(chartRight - barW, y, barW, binPx - 1);
          }
        }
      }
    }

    // Horizontal Wall Rays & Badges (Laser-focused on institutional wall levels)
    if (settings.showWallRays && engine.walls.length > 0) {
      const rayEnd = chartRight - 4;
      const rayLeft = Math.max(0, chartRight - 240);
      const raySpan = Math.max(1, rayEnd - rayLeft);
      const now = Date.now();
      const labeledY: number[] = [];

      engine.walls.forEach((wall) => {
        const wy = candleSeries.priceToCoordinate(wall.price);
        if (wy == null || wy < 15 || wy > h - 15) return;

        // Prevent overlapping label collisions
        if (labeledY.some((prevY) => Math.abs(prevY - wy) < 16)) return;

        const isBid = wall.side === 'B';
        const rgb = isBid ? '38, 166, 154' : '239, 83, 80';
        const ageMs = now - wall.bornTs;
        const isEstablished = ageMs >= (settings.wallMinAgeSec * 1000 || 25000);
        const isDefended = wall.status === 'defended';
        const isSwept = wall.status === 'consumed';

        // 1. Draw horizontal laser ray projecting from price axis into the active candles
        const grad = ctx.createLinearGradient(rayLeft, wy, rayEnd, wy);
        grad.addColorStop(0, `rgba(${rgb}, 0)`);
        grad.addColorStop(0.4, `rgba(${rgb}, ${isDefended ? '0.35' : '0.15'})`);
        grad.addColorStop(0.85, `rgba(${rgb}, ${isDefended ? '0.85' : '0.45'})`);
        grad.addColorStop(1, `rgba(${rgb}, ${isDefended ? '1' : '0.75'})`);

        ctx.fillStyle = grad;
        ctx.fillRect(rayLeft, wy - (isDefended ? 2 : 1), raySpan, isDefended ? 4 : 2);

        // Axis notch tick mark on the right border
        ctx.fillStyle = `rgb(${rgb})`;
        ctx.fillRect(rayEnd - 3, wy - 3, 3, 6);

        // 2. Format Badge Label
        let badgeText = wall.label;
        if (isDefended && !badgeText.includes('SAVUNULDU')) {
          badgeText = `🛡️ SAVUNULDU ${wall.label}`;
        } else if (isSwept && !badgeText.includes('SWEEP')) {
          badgeText = `⚡ SWEEP ${wall.label}`;
        }

        ctx.font = `${isEstablished || isDefended ? 'bold ' : ''}10.5px monospace`;
        const tw = ctx.measureText(badgeText).width;
        const badgeX = rayEnd - tw - 12;

        // Pill background
        ctx.fillStyle = isDefended
          ? (isBid ? 'rgba(38, 166, 154, 0.40)' : 'rgba(239, 83, 80, 0.40)')
          : 'rgba(16, 21, 28, 0.92)';
        ctx.fillRect(badgeX, wy - 9, tw + 10, 18);

        // Pill border
        ctx.strokeStyle = isDefended
          ? (isBid ? '#26a69a' : '#ef5350')
          : `rgba(${rgb}, 0.55)`;
        ctx.lineWidth = isDefended ? 1.5 : 1;
        ctx.strokeRect(badgeX, wy - 9, tw + 10, 18);

        // Label text
        ctx.fillStyle = isDefended ? '#ffffff' : (isBid ? '#26a69a' : '#ef5350');
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, rayEnd - 6, wy);

        labeledY.push(wy);
      });
    }

    // Render Recently Swept Liquidity Levels (Gold/Yellow Pulsating Rays)
    if (settings.showWallRays && engine.sweptWallLevels.length > 0) {
      const rayEnd = chartRight - 4;
      const rayLeft = Math.max(0, chartRight - 260);
      const raySpan = Math.max(1, rayEnd - rayLeft);
      const now = Date.now();

      engine.sweptWallLevels.forEach((swept) => {
        if (now >= swept.expireTs) return;
        const wy = candleSeries.priceToCoordinate(swept.price);
        if (wy == null || wy < 15 || wy > h - 15) return;

        const badgeText = `⚡ SWEEP $${engine.formatCompact(swept.notional)}`;
        ctx.font = 'bold 10.5px monospace';
        const tw = ctx.measureText(badgeText).width;
        const badgeX = rayEnd - tw - 12;

        const grad = ctx.createLinearGradient(rayLeft, wy, rayEnd, wy);
        grad.addColorStop(0, 'rgba(224, 182, 76, 0)');
        grad.addColorStop(0.5, 'rgba(224, 182, 76, 0.40)');
        grad.addColorStop(1, 'rgba(224, 182, 76, 0.95)');

        ctx.fillStyle = grad;
        ctx.fillRect(rayLeft, wy - 1.5, raySpan, 3);

        ctx.fillStyle = 'rgba(224, 182, 76, 0.35)';
        ctx.fillRect(badgeX, wy - 9, tw + 10, 18);
        ctx.strokeStyle = '#e0b64c';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(badgeX, wy - 9, tw + 10, 18);

        ctx.fillStyle = '#fef08a';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, rayEnd - 6, wy);
      });
    }

    // Real-Time MID Line & Dynamic Spread Area
    if (engine.midPrice > 0) {
      const my = candleSeries.priceToCoordinate(engine.midPrice);
      const by = candleSeries.priceToCoordinate(engine.bestBid);
      const ay = candleSeries.priceToCoordinate(engine.bestAsk);

      // Spread zone
      if (by != null && ay != null) {
        ctx.fillStyle = 'rgba(76, 140, 224, 0.08)';
        ctx.fillRect(0, Math.min(by, ay), chartRight, Math.max(1, Math.abs(by - ay)));
      }

      // MID dashed line
      if (my != null && my >= 0 && my <= h) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#ef5350';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, my);
        ctx.lineTo(chartRight, my);
        ctx.stroke();
        ctx.restore();

        // Label 'MID'
        ctx.font = '800 10px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText('MID', chartRight - 8, my - 4);
      }
    }

    // Live Opportunity Card Risk/Reward Zone & Entry/TP/SL Laser Lines
    const opp = activeOppRef.current;
    if (opp && opp.symbol === symbol) {
      const ey = candleSeries.priceToCoordinate(opp.entryPrice);
      const ty = candleSeries.priceToCoordinate(opp.targetPrice);
      const sy = candleSeries.priceToCoordinate(opp.stopPrice);
      const zoneLeft = Math.max(0, chartRight - 300);
      const zoneWidth = Math.max(1, chartRight - zoneLeft);

      if (ey != null && ty != null) {
        ctx.fillStyle = 'rgba(38, 166, 154, 0.09)';
        ctx.fillRect(zoneLeft, Math.min(ey, ty), zoneWidth, Math.max(1, Math.abs(ty - ey)));
      }
      if (ey != null && sy != null) {
        ctx.fillStyle = 'rgba(239, 83, 80, 0.09)';
        ctx.fillRect(zoneLeft, Math.min(ey, sy), zoneWidth, Math.max(1, Math.abs(sy - ey)));
      }

      const drawOppLevel = (
        y: number | null,
        color: string,
        bg: string,
        label: string
      ) => {
        if (y == null || y < 12 || y > h - 12) return;
        ctx.save();
        ctx.setLineDash([5, 3]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(zoneLeft, y);
        ctx.lineTo(chartRight, y);
        ctx.stroke();
        ctx.restore();

        ctx.font = 'bold 10px monospace';
        const tw = ctx.measureText(label).width;
        const bx = zoneLeft + 4;
        ctx.fillStyle = bg;
        ctx.fillRect(bx, y - 8, tw + 8, 16);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, y - 8, tw + 8, 16);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + 4, y);
      };

      const pnl = opp.pnlPct ?? 0;
      const pnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
      drawOppLevel(
        ty,
        '#26a69a',
        'rgba(38, 166, 154, 0.85)',
        `🎯 HEDEF ${opp.targetPrice} (1:${opp.rrRatio})`
      );
      drawOppLevel(
        ey,
        '#4c8ce0',
        'rgba(76, 140, 224, 0.85)',
        `⚡ GİRİŞ ${opp.entryPrice} (${pnlStr})`
      );
      drawOppLevel(
        sy,
        '#ef5350',
        'rgba(239, 83, 80, 0.85)',
        `🛑 STOP ${opp.stopPrice}`
      );
    }
  };

  // Color interpolation helper for strength gradient
  const interpolateRGB = (
    c1: [number, number, number],
    c2: [number, number, number],
    t: number
  ): [number, number, number] => {
    return [
      Math.round(c1[0] + (c2[0] - c1[0]) * t),
      Math.round(c1[1] + (c2[1] - c1[1]) * t),
      Math.round(c1[2] + (c2[2] - c1[2]) * t),
    ];
  };

  // Maps normalized orderbook liquidity strength (0.0 to 1.0) to a rich color gradient representing depth
  const getLiquidityStrengthColor = (
    strength: number,
    isBid: boolean
  ): { rgb: string; alpha: number } => {
    const s = Math.max(0, Math.min(1, strength));
    // Alpha smoothly scales with strength (subtle at low depth, distinct semi-transparent at dense clusters)
    const alpha = 0.035 + Math.pow(s, 1.15) * 0.42;

    if (isBid) {
      // Bid Strength Gradient:
      // Low (0.0): Deep Navy/Teal -> Medium (0.35): Cyan -> High (0.65): Vibrant Emerald -> Wall (0.85+): Luminous Lime/White-Gold
      let rgb: [number, number, number];
      if (s < 0.35) {
        rgb = interpolateRGB([12, 48, 64], [25, 125, 120], s / 0.35);
      } else if (s < 0.65) {
        rgb = interpolateRGB([25, 125, 120], [38, 166, 154], (s - 0.35) / 0.3);
      } else if (s < 0.85) {
        rgb = interpolateRGB([38, 166, 154], [52, 211, 153], (s - 0.65) / 0.2);
      } else {
        rgb = interpolateRGB([52, 211, 153], [220, 252, 100], (s - 0.85) / 0.15);
      }
      return { rgb: `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`, alpha };
    } else {
      // Ask Strength Gradient:
      // Low (0.0): Deep Maroon -> Medium (0.35): Crimson -> High (0.65): Coral-Red -> Wall (0.85+): Blazing Amber/Gold-White
      let rgb: [number, number, number];
      if (s < 0.35) {
        rgb = interpolateRGB([60, 16, 26], [155, 36, 46], s / 0.35);
      } else if (s < 0.65) {
        rgb = interpolateRGB([155, 36, 46], [239, 83, 80], (s - 0.35) / 0.3);
      } else if (s < 0.85) {
        rgb = interpolateRGB([239, 83, 80], [251, 146, 60], (s - 0.65) / 0.2);
      } else {
        rgb = interpolateRGB([251, 146, 60], [254, 215, 64], (s - 0.85) / 0.15);
      }
      return { rgb: `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`, alpha };
    }
  };

  // 2. DEPTH SNAPSHOT VOLUME PROFILE HEATMAP LAYER (Behind Candlesticks)
  const drawLiquidityHeatmap = () => {
    const cv = heatmapCanvasRef.current;
    if (!cv || !chartRef.current || !candleSeriesRef.current || !containerRef.current) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const w = containerRef.current.clientWidth;
    const h = containerRef.current.clientHeight;

    ctx.clearRect(0, 0, w, h);

    if (!engine.isOrderbookSynced() || (!engine.bidsBook.size && !engine.asksBook.size)) return;

    const candleSeries = candleSeriesRef.current;
    const axisW = Math.max(0, Math.ceil(chartRef.current.priceScale('right').width() || 75));
    const chartRight = Math.max(0, w - axisW);

    // Group current depth snapshot into vertical pixel bins aligned with price scale
    const binPx = 3;
    const rows = Math.ceil(h / binPx);
    if (rows <= 0 || chartRight <= 0) return;

    const bidBins = new Float64Array(rows);
    const askBins = new Float64Array(rows);
    const topP = candleSeries.coordinateToPrice(0);
    const botP = candleSeries.coordinateToPrice(h);
    const minVisP = topP !== null && botP !== null ? Math.min(topP, botP) : 0;
    const maxVisP = topP !== null && botP !== null ? Math.max(topP, botP) : Infinity;

    const priceToRow = (p: number) => {
      if (p < minVisP || p > maxVisP) return -1;
      const y = candleSeries.priceToCoordinate(p);
      if (y == null || y < 0 || y > h) return -1;
      return Math.min(rows - 1, Math.max(0, Math.floor(y / binPx)));
    };

    for (const [p, q] of engine.bidsBook) {
      const idx = priceToRow(p);
      if (idx >= 0) bidBins[idx] += p * q;
    }
    for (const [p, q] of engine.asksBook) {
      const idx = priceToRow(p);
      if (idx >= 0) askBins[idx] += p * q;
    }

    let maxNotional = 0;
    for (let i = 0; i < rows; i++) {
      const val = Math.max(bidBins[i], askBins[i]);
      if (val > maxNotional) maxNotional = val;
    }
    if (maxNotional === 0) maxNotional = 10000;
    const logMax = Math.log1p(maxNotional);

    // Render price-aligned volume profile liquidity density directly behind the candlestick series
    for (let i = 0; i < rows; i++) {
      const bNotional = bidBins[i];
      const aNotional = askBins[i];
      const notional = Math.max(bNotional, aNotional);
      if (notional <= 0) continue;

      const isBid = bNotional >= aNotional;
      const y = i * binPx;
      const strength = Math.min(1, Math.log1p(notional) / logMax);

      // Multi-stop color gradient reflecting liquidity strength
      const { rgb, alpha } = getLiquidityStrengthColor(strength, isBid);

      // Horizontal volume profile density gradient extending behind candles across chart width
      const grad = ctx.createLinearGradient(0, y, chartRight, y);
      grad.addColorStop(0, `rgba(${rgb}, ${(alpha * 0.15).toFixed(3)})`);
      grad.addColorStop(0.35, `rgba(${rgb}, ${(alpha * 0.45).toFixed(3)})`);
      grad.addColorStop(0.75, `rgba(${rgb}, ${(alpha * 0.80).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${rgb}, ${alpha.toFixed(3)})`);

      ctx.fillStyle = grad;
      ctx.fillRect(0, y, chartRight, binPx);

      // Accentuate high-liquidity volume nodes (HVN) with luminous price-aligned core line
      if (strength > 0.65) {
        const coreAlpha = Math.min(0.65, alpha * 1.25);
        ctx.fillStyle = `rgba(${rgb}, ${coreAlpha.toFixed(3)})`;
        ctx.fillRect(chartRight * 0.25, y + binPx / 2 - 0.5, chartRight * 0.75, 1);
      }
    }
  };

  return (
    <div className="relative w-full h-full select-none overflow-hidden bg-[#0d1117]">
      {/* 1. Liquidity Density Heatmap Layer (Mounted directly BEHIND the candlestick series) */}
      <canvas
        ref={heatmapCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-0"
      />

      {/* 2. TradingView Candlestick & Indicators Canvas (Transparent background enables heatmap visibility behind candles) */}
      <div ref={containerRef} className="absolute inset-0 w-full h-full z-10" />

      {/* 3. In-Situ DOM Ladder & Wall Rays Foreground Layer */}
      <canvas
        ref={overlayCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-20"
      />
    </div>
  );
};
