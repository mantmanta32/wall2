import React, { useState } from 'react';
import { OpportunityCard } from '../types/market';

interface OpportunityStats {
  total: number;
  activeCount: number;
  hitCount: number;
  stopCount: number;
  expiredCount: number;
  resolvedCount: number;
  winRate: number;
  totalPnL: number;
}

interface OrderFlowHUDProps {
  marketStatus: 'NOTR' | 'AL' | 'SAT' | 'SAVUNULDU' | 'SWEEP' | 'ICEBERG' | 'SPOOF' | 'DIVERGENCE';
  activeOpportunity?: OpportunityCard | null;
  opportunityStats?: OpportunityStats;
  allOpportunities?: OpportunityCard[];
  onDismissOpportunity?: () => void;
  onSelectOpportunity?: (opp: OpportunityCard) => void;
  onClearHistory?: () => void;
}

export const OrderFlowHUD: React.FC<OrderFlowHUDProps> = ({
  marketStatus,
  activeOpportunity,
  opportunityStats,
  allOpportunities = [],
  onDismissOpportunity,
  onSelectOpportunity,
  onClearHistory,
}) => {
  const [showOppDetails, setShowOppDetails] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);

  const statusColors: Record<string, string> = {
    NOTR: 'bg-[#161b22]/90 text-[#8b949e] border-[#2a3038]',
    AL: 'bg-[#26a69a]/20 text-[#26a69a] border-[#26a69a]/60 shadow-[0_0_12px_rgba(38,166,154,0.25)]',
    SAT: 'bg-[#ef5350]/20 text-[#ef5350] border-[#ef5350]/60 shadow-[0_0_12px_rgba(239,83,80,0.25)]',
    SAVUNULDU: 'bg-[#4c8ce0]/25 text-[#4c8ce0] border-[#4c8ce0]/70 shadow-[0_0_14px_rgba(76,140,224,0.4)] animate-pulse',
    SWEEP: 'bg-[#e0b64c]/25 text-[#e0b64c] border-[#e0b64c]/70 shadow-[0_0_12px_rgba(224,182,76,0.35)]',
    ICEBERG: 'bg-[#38bdf8]/25 text-[#38bdf8] border-[#38bdf8]/70 shadow-[0_0_12px_rgba(56,189,248,0.35)]',
    SPOOF: 'bg-[#f59e0b]/25 text-[#f59e0b] border-[#f59e0b]/70 shadow-[0_0_12px_rgba(245,158,11,0.35)]',
    DIVERGENCE: 'bg-[#a855f7]/25 text-[#c084fc] border-[#c084fc]/70 shadow-[0_0_14px_rgba(192,132,252,0.35)] animate-pulse',
  };

  const statusLabels: Record<string, string> = {
    NOTR: 'NÖTR',
    AL: 'AL BASKISI',
    SAT: 'SAT BASKISI',
    SAVUNULDU: '🛡️ DUVAR SAVUNULDU',
    SWEEP: '⚡ SWEEP',
    ICEBERG: '🧊 ICEBERG EMİLİM',
    SPOOF: '⚠️ SPOOF ÇEKİLDİ',
    DIVERGENCE: '📊 DELTA UYUMSUZLUĞU',
  };

  // Status visual configurations for opportunities
  const getPillStyle = (opp: OpportunityCard) => {
    switch (opp.status) {
      case 'HIT_TARGET':
        return 'bg-[#26a69a]/35 text-[#26a69a] border-[#26a69a] shadow-[0_0_16px_rgba(38,166,154,0.5)]';
      case 'STOPPED':
        return 'bg-[#ef5350]/35 text-[#ef5350] border-[#ef5350] shadow-[0_0_16px_rgba(239,83,80,0.5)]';
      case 'EXPIRED':
        return 'bg-[#6e7681]/30 text-[#8b949e] border-[#6e7681]/60';
      case 'ACTIVE':
      default:
        return opp.bias === 'LONG'
          ? 'bg-[#26a69a]/25 text-[#26a69a] border-[#26a69a]/60 hover:bg-[#26a69a]/35 animate-pulse'
          : 'bg-[#ef5350]/25 text-[#ef5350] border-[#ef5350]/60 hover:bg-[#ef5350]/35 animate-pulse';
    }
  };

  const getPillText = (opp: OpportunityCard) => {
    const pnl = opp.pnlPct ?? 0;
    const pnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
    switch (opp.status) {
      case 'HIT_TARGET':
        return `✅ HEDEF ALINDI (${pnlStr})`;
      case 'STOPPED':
        return `🛑 STOPLANDI (${pnlStr})`;
      case 'EXPIRED':
        return `⏱️ SÜRE DOLDU (${pnlStr})`;
      case 'ACTIVE':
      default:
        if (opp.type === 'VACUUM_SWEEP') {
          return opp.bias === 'LONG' ? '⚡ BOĞA SÜPÜRME (LONG)' : '⚡ AYI SÜPÜRME (SHORT)';
        }
        if (opp.type === 'ICEBERG_ABSORPTION') {
          return opp.bias === 'LONG' ? '🧊 ICEBERG EMİLİM (LONG)' : '🧊 ICEBERG EMİLİM (SHORT)';
        }
        if (opp.type === 'DELTA_DIVERGENCE') {
          return opp.bias === 'LONG' ? '📊 BOĞA UYUMSUZLUK (LONG)' : '📊 AYI UYUMSUZLUK (SHORT)';
        }
        return opp.bias === 'LONG' ? '🛡️ DUVAR SAVUNULDU (LONG)' : '🛡️ DUVAR SAVUNULDU (SHORT)';
    }
  };

  const remainingSec = activeOpportunity
    ? Math.max(0, (activeOpportunity.maxDurationSec || 180) - (activeOpportunity.durationSec || 0))
    : 0;
  const liveProgress = activeOpportunity?.progressPct ?? 0;
  const livePnl = activeOpportunity?.pnlPct ?? 0;

  return (
    <div className="absolute top-2.5 left-2.5 z-30 flex flex-col gap-2 max-w-[calc(100vw-90px)] pointer-events-auto">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Market Microstructure Flow Badge */}
        <span
          className={`px-3 py-1 rounded-full text-[11px] font-black tracking-wider uppercase border backdrop-blur-md transition-all ${
            statusColors[marketStatus] || statusColors.NOTR
          }`}
        >
          {statusLabels[marketStatus] || marketStatus}
        </span>

        {/* Scalp Opportunity Live Pill */}
        {activeOpportunity && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowOppDetails(!showOppDetails)}
              className={`px-3 py-1 rounded-full text-[11px] font-bold border backdrop-blur-md transition-all flex items-center gap-1.5 shadow-lg ${getPillStyle(
                activeOpportunity
              )}`}
            >
              <span>{getPillText(activeOpportunity)}</span>
              {activeOpportunity.status === 'ACTIVE' && (
                <>
                  <span
                    className={`font-mono text-[10px] px-1.5 py-0.2 rounded font-black ${
                      livePnl >= 0
                        ? 'bg-[#26a69a]/25 text-[#26a69a]'
                        : 'bg-[#ef5350]/25 text-[#ef5350]'
                    }`}
                  >
                    {livePnl >= 0 ? '+' : ''}
                    {livePnl.toFixed(2)}%
                  </span>
                  <span className="font-mono text-[10px] opacity-85 hidden sm:inline">
                    {liveProgress >= 0 ? `🎯%${liveProgress}` : `🛑%${Math.abs(liveProgress)}`}
                  </span>
                  <span className="font-mono text-[10px] opacity-80">⏳{remainingSec}s</span>
                </>
              )}
              <span className="text-[9px] opacity-60 ml-0.5">{showOppDetails ? '▲' : '▼'}</span>
            </button>
            <button
              onClick={() => {
                setShowOppDetails(false);
                if (onDismissOpportunity) onDismissOpportunity();
              }}
              title="Kapat"
              className="w-5 h-5 rounded-full bg-[#161b22]/90 border border-[#30363d] text-[#8b949e] hover:text-[#e6e8ea] flex items-center justify-center text-[10px]"
            >
              ✕
            </button>
          </div>
        )}

        {/* Scalp Performance Win-Rate Badge (Always visible & clickable to view history) */}
        {opportunityStats && (
          <button
            onClick={() => setShowHistoryModal(true)}
            title="Tüm fırsat geçmişini ve başarı analitiğini gör"
            className="px-2.5 py-1 rounded-full text-[10px] font-mono font-bold bg-[#161b22]/90 border border-[#30363d] hover:border-[#4c8ce0]/60 backdrop-blur-md flex items-center gap-1.5 transition-all shadow-sm cursor-pointer"
          >
            <span className="text-[#8b949e]">BAŞARI:</span>
            <span
              className={
                opportunityStats.winRate >= 50
                  ? 'text-[#26a69a]'
                  : opportunityStats.resolvedCount > 0
                  ? 'text-[#ef5350]'
                  : 'text-[#e6e8ea]'
              }
            >
              %{opportunityStats.winRate}
            </span>
            <span className="text-[#8b949e] opacity-80">
              ({opportunityStats.hitCount}W/{opportunityStats.stopCount}L
              {opportunityStats.activeCount > 0 ? ` · ${opportunityStats.activeCount} aktif` : ''})
            </span>
            <span
              className={`font-semibold ${
                opportunityStats.totalPnL > 0
                  ? 'text-[#26a69a]'
                  : opportunityStats.totalPnL < 0
                  ? 'text-[#ef5350]'
                  : 'text-[#8b949e]'
              }`}
            >
              {opportunityStats.totalPnL >= 0 ? '+' : ''}
              {opportunityStats.totalPnL}%
            </span>
            <span className="text-[9px] text-[#4c8ce0] ml-0.5">📊</span>
          </button>
        )}
      </div>

      {/* Expanded Opportunity Card Details */}
      {activeOpportunity && showOppDetails && (
        <div className="bg-[#161b22]/95 border border-[#30363d] rounded-lg p-3 shadow-2xl backdrop-blur-md text-xs font-mono w-84 max-w-full">
          <div className="flex items-center justify-between border-b border-[#30363d] pb-1.5 mb-2">
            <div className="flex items-center gap-1.5 truncate">
              <span
                className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                  activeOpportunity.status === 'HIT_TARGET'
                    ? 'bg-[#26a69a]/20 text-[#26a69a] border border-[#26a69a]/40'
                    : activeOpportunity.status === 'STOPPED'
                    ? 'bg-[#ef5350]/20 text-[#ef5350] border border-[#ef5350]/40'
                    : activeOpportunity.status === 'EXPIRED'
                    ? 'bg-[#6e7681]/20 text-[#8b949e] border border-[#6e7681]/40'
                    : 'bg-[#4c8ce0]/20 text-[#4c8ce0] border border-[#4c8ce0]/40'
                }`}
              >
                {activeOpportunity.status === 'HIT_TARGET'
                  ? 'HEDEF'
                  : activeOpportunity.status === 'STOPPED'
                  ? 'STOP'
                  : activeOpportunity.status === 'EXPIRED'
                  ? 'SÜRE DOLDU'
                  : 'AKTİF'}
              </span>
              <span className="font-bold text-[#e6e8ea] truncate text-[11px]">
                {activeOpportunity.title}
              </span>
            </div>
            <button
              onClick={() => setShowOppDetails(false)}
              className="text-[#8b949e] hover:text-[#e6e8ea] px-1 text-[11px]"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-4 gap-1.5 mb-2 text-center">
            <div className="bg-[#0d1117] p-1.5 rounded border border-[#21262d]">
              <div className="text-[8px] text-[#8b949e]">GİRİŞ</div>
              <div className="font-bold text-[#e6e8ea] text-[10px]">{activeOpportunity.entryPrice}</div>
            </div>
            <div className="bg-[#0d1117] p-1.5 rounded border border-[#4c8ce0]/40">
              <div className="text-[8px] text-[#4c8ce0]">ANLIK</div>
              <div className="font-bold text-[#e6e8ea] text-[10px]">
                {activeOpportunity.currentPrice ?? activeOpportunity.entryPrice}
              </div>
            </div>
            <div className="bg-[#0d1117] p-1.5 rounded border border-[#21262d]">
              <div className="text-[8px] text-[#ef5350]">STOP</div>
              <div className="font-bold text-[#ef5350] text-[10px]">{activeOpportunity.stopPrice}</div>
            </div>
            <div className="bg-[#0d1117] p-1.5 rounded border border-[#21262d]">
              <div className="text-[8px] text-[#26a69a]">HEDEF</div>
              <div className="font-bold text-[#26a69a] text-[10px]">{activeOpportunity.targetPrice}</div>
            </div>
          </div>

          {/* Live Stop <-> Entry <-> Target Progress Bar */}
          <div className="bg-[#0d1117] p-2 rounded border border-[#21262d] mb-2 space-y-1">
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-[#ef5350] font-bold">🛑 STOP</span>
              <span
                className={`font-bold ${
                  livePnl >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'
                }`}
              >
                {livePnl >= 0 ? '+' : ''}
                {livePnl.toFixed(2)}% ({liveProgress >= 0 ? `Hedefe %${liveProgress}` : `Stopa %${Math.abs(liveProgress)}`})
              </span>
              <span className="text-[#26a69a] font-bold">🎯 HEDEF</span>
            </div>
            <div className="relative h-2 bg-[#161b22] rounded-full overflow-hidden border border-[#30363d]">
              {/* Center Entry Line */}
              <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-[#8b949e] z-10" />
              {liveProgress >= 0 ? (
                <div
                  className="absolute top-0 bottom-0 bg-[#26a69a] transition-all duration-200"
                  style={{
                    left: '50%',
                    width: `${Math.min(50, Math.max(0, liveProgress / 2))}%`,
                  }}
                />
              ) : (
                <div
                  className="absolute top-0 bottom-0 bg-[#ef5350] transition-all duration-200"
                  style={{
                    right: '50%',
                    width: `${Math.min(50, Math.max(0, Math.abs(liveProgress) / 2))}%`,
                  }}
                />
              )}
            </div>
            <div className="flex items-center justify-between text-[9px] text-[#8b949e]">
              <span>Geçen: {activeOpportunity.durationSec || 0}s</span>
              <span> R:R 1:{activeOpportunity.rrRatio} · Güven %{activeOpportunity.confidenceScore}</span>
              <span>
                {activeOpportunity.status === 'ACTIVE'
                  ? `Kalan: ${remainingSec}s`
                  : `Çıkış: ${activeOpportunity.exitPrice}`}
              </span>
            </div>
          </div>

          <div className="space-y-1 text-[10px] text-[#8b949e] border-t border-[#21262d] pt-1.5">
            {activeOpportunity.reasons.map((r, i) => (
              <div key={i} className="flex items-start gap-1">
                <span className="text-[#4c8ce0]">•</span>
                <span className="leading-tight">{r}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Signal History & Performance Modal */}
      {showHistoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col font-mono text-xs overflow-hidden">
            {/* Header */}
            <div className="p-3 border-b border-[#21262d] flex items-center justify-between bg-[#0d1117]">
              <div className="flex items-center gap-2">
                <span className="text-base">📊</span>
                <h3 className="font-bold text-[#e6e8ea] text-sm">Scalp Sinyal Geçmişi & Başarı Analitiği</h3>
              </div>
              <div className="flex items-center gap-2">
                {onClearHistory && allOpportunities.length > 0 && (
                  <button
                    onClick={onClearHistory}
                    className="px-2 py-1 rounded text-[10px] bg-[#21262d] hover:bg-[#ef5350]/20 text-[#8b949e] hover:text-[#ef5350] border border-[#30363d] transition-colors"
                  >
                    Geçmişi Sıfırla
                  </button>
                )}
                <button
                  onClick={() => setShowHistoryModal(false)}
                  className="w-7 h-7 rounded-lg hover:bg-[#21262d] flex items-center justify-center text-[#8b949e] hover:text-[#e6e8ea]"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Performance Stats Overview */}
            {opportunityStats && (
              <div className="grid grid-cols-4 gap-2 p-3 bg-[#161b22] border-b border-[#21262d] text-center">
                <div className="bg-[#0d1117] p-2 rounded border border-[#21262d]">
                  <div className="text-[9px] text-[#8b949e]">BAŞARI ORANI</div>
                  <div
                    className={`font-bold text-sm ${
                      opportunityStats.winRate >= 50
                        ? 'text-[#26a69a]'
                        : opportunityStats.resolvedCount > 0
                        ? 'text-[#ef5350]'
                        : 'text-[#e6e8ea]'
                    }`}
                  >
                    %{opportunityStats.winRate}
                  </div>
                </div>
                <div className="bg-[#0d1117] p-2 rounded border border-[#21262d]">
                  <div className="text-[9px] text-[#8b949e]">HEDEF / STOP</div>
                  <div className="font-bold text-sm text-[#e6e8ea]">
                    <span className="text-[#26a69a]">{opportunityStats.hitCount}W</span> /{' '}
                    <span className="text-[#ef5350]">{opportunityStats.stopCount}L</span>
                  </div>
                </div>
                <div className="bg-[#0d1117] p-2 rounded border border-[#21262d]">
                  <div className="text-[9px] text-[#8b949e]">SÜRE / AKTİF</div>
                  <div className="font-bold text-sm text-[#8b949e]">
                    {opportunityStats.expiredCount}E /{' '}
                    <span className="text-[#4c8ce0]">{opportunityStats.activeCount}A</span>
                  </div>
                </div>
                <div className="bg-[#0d1117] p-2 rounded border border-[#21262d]">
                  <div className="text-[9px] text-[#8b949e]">TOPLAM PnL</div>
                  <div
                    className={`font-bold text-sm ${
                      opportunityStats.totalPnL >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'
                    }`}
                  >
                    {opportunityStats.totalPnL >= 0 ? '+' : ''}
                    {opportunityStats.totalPnL}%
                  </div>
                </div>
              </div>
            )}

            {/* Signals List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {allOpportunities.length === 0 ? (
                <div className="text-center py-8 text-[#8b949e]">
                  Henüz üretilmiş bir fırsat sinyali bulunmuyor. Derinlik defteri ve akış izleniyor...
                </div>
              ) : (
                allOpportunities.map((opp) => {
                  const pnl = opp.pnlPct ?? 0;
                  const prog = opp.progressPct ?? 0;
                  const rem = Math.max(0, (opp.maxDurationSec || 180) - (opp.durationSec || 0));
                  return (
                    <div
                      key={opp.id}
                      onClick={() => {
                        if (onSelectOpportunity) onSelectOpportunity(opp);
                        setShowOppDetails(true);
                        setShowHistoryModal(false);
                      }}
                      className={`p-2.5 rounded-lg border transition-all cursor-pointer hover:border-[#4c8ce0] ${
                        opp.status === 'HIT_TARGET'
                          ? 'bg-[#26a69a]/10 border-[#26a69a]/40'
                          : opp.status === 'STOPPED'
                          ? 'bg-[#ef5350]/10 border-[#ef5350]/40'
                          : opp.status === 'EXPIRED'
                          ? 'bg-[#6e7681]/10 border-[#6e7681]/30'
                          : 'bg-[#0d1117] border-[#4c8ce0]/40'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[9px] px-1.5 py-0.5 rounded font-bold bg-[#21262d] text-[#e6e8ea]">
                            {opp.symbol}
                          </span>
                          <span
                            className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                              opp.bias === 'LONG'
                                ? 'bg-[#26a69a]/20 text-[#26a69a]'
                                : 'bg-[#ef5350]/20 text-[#ef5350]'
                            }`}
                          >
                            {opp.bias}
                          </span>
                          <span className="font-bold text-[#e6e8ea] text-[11px] truncate">
                            {opp.title}
                          </span>
                        </div>
                        <span
                          className={`text-[9px] px-2 py-0.5 rounded-full font-bold uppercase border flex-none ${
                            opp.status === 'HIT_TARGET'
                              ? 'bg-[#26a69a]/25 text-[#26a69a] border-[#26a69a]/60'
                              : opp.status === 'STOPPED'
                              ? 'bg-[#ef5350]/25 text-[#ef5350] border-[#ef5350]/60'
                              : opp.status === 'EXPIRED'
                              ? 'bg-[#6e7681]/25 text-[#8b949e] border-[#6e7681]/50'
                              : 'bg-[#4c8ce0]/25 text-[#4c8ce0] border-[#4c8ce0]/50 animate-pulse'
                          }`}
                        >
                          {opp.status === 'HIT_TARGET'
                            ? `✅ Hedef (${pnl >= 0 ? '+' : ''}${pnl}%)`
                            : opp.status === 'STOPPED'
                            ? `🛑 Stop (${pnl}%)`
                            : opp.status === 'EXPIRED'
                            ? `⏱️ Süre (${pnl >= 0 ? '+' : ''}${pnl}%)`
                            : `🎯 Aktif (${pnl >= 0 ? '+' : ''}${pnl}% · ${rem}s)`}
                        </span>
                      </div>

                      <div className="grid grid-cols-4 gap-1 text-[10px] text-[#8b949e] mb-1">
                        <div>
                          Giriş: <strong className="text-[#e6e8ea]">{opp.entryPrice}</strong>
                        </div>
                        <div>
                          {opp.status === 'ACTIVE' ? 'Anlık' : 'Çıkış'}:{' '}
                          <strong className="text-[#4c8ce0]">
                            {opp.exitPrice ?? opp.currentPrice ?? opp.entryPrice}
                          </strong>
                        </div>
                        <div>
                          Stop: <strong className="text-[#ef5350]">{opp.stopPrice}</strong>
                        </div>
                        <div>
                          Hedef: <strong className="text-[#26a69a]">{opp.targetPrice}</strong>
                        </div>
                      </div>

                      {opp.status === 'ACTIVE' && (
                        <div className="relative h-1.5 bg-[#161b22] rounded-full overflow-hidden border border-[#30363d] my-1">
                          <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-[#8b949e] z-10" />
                          {prog >= 0 ? (
                            <div
                              className="absolute top-0 bottom-0 bg-[#26a69a]"
                              style={{ left: '50%', width: `${Math.min(50, prog / 2)}%` }}
                            />
                          ) : (
                            <div
                              className="absolute top-0 bottom-0 bg-[#ef5350]"
                              style={{ right: '50%', width: `${Math.min(50, Math.abs(prog) / 2)}%` }}
                            />
                          )}
                        </div>
                      )}

                      <div className="flex items-center justify-between text-[9px] text-[#8b949e] border-t border-[#21262d]/60 pt-1">
                        <span>
                          R:R 1:{opp.rrRatio} · Güven: %{opp.confidenceScore} ({opp.confidence})
                        </span>
                        <span>
                          {opp.durationSec ? `${opp.durationSec}s` : '0s'} ·{' '}
                          {new Date(opp.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="p-2 border-t border-[#21262d] bg-[#0d1117] text-center text-[10px] text-[#8b949e]">
              Bir sinyale tıklayarak grafikteki canlı/geçmiş seviyelerini inceleyebilirsiniz.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
