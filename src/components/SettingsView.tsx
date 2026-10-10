import React from 'react';
import { AppSettings } from '../types/market';
import { Sliders, Volume2, Shield, Eye, Layers, Cloud, LogIn, LogOut, CheckCircle2, Zap } from 'lucide-react';
import { OrderbookEngine } from '../services/orderbookEngine';

interface SettingsViewProps {
  settings: AppSettings;
  onChange: (newSettings: AppSettings) => void;
  onReset: () => void;
  user?: { displayName?: string | null; email?: string | null; photoURL?: string | null } | null;
  onLogin?: () => void;
  onLogout?: () => void;
  isLoggingIn?: boolean;
  engine?: OrderbookEngine;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onChange,
  onReset,
  user,
  onLogin,
  onLogout,
  isLoggingIn = false,
  engine,
}) => {
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div className="p-3 space-y-4 pb-24 max-w-2xl mx-auto">
      {/* 0. Firebase Cloud Sync & Account */}
      <div className="bg-[#161b22] border border-[#2a3038] rounded-xl p-3.5 shadow-lg space-y-3">
        <h3 className="text-xs font-bold text-[#8b949e] uppercase tracking-wider flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Cloud className="w-4 h-4 text-[#4c8ce0]" />
            <span>Firebase Bulut Senkronizasyonu</span>
          </span>
          <span className="text-[10px] text-[#26a69a] flex items-center gap-1 font-mono">
            <CheckCircle2 className="w-3 h-3" /> Firestore Aktif
          </span>
        </h3>

        {user ? (
          <div className="bg-[#0d1117] border border-[#2a3038] rounded-lg p-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-8 h-8 rounded-full border border-[#4c8ce0]" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-[#4c8ce0]/20 text-[#4c8ce0] font-bold flex items-center justify-center text-xs">
                  {(user.displayName || user.email || 'U')[0].toUpperCase()}
                </div>
              )}
              <div>
                <b className="text-xs text-[#e6e8ea] block">{user.displayName || 'Kullanıcı'}</b>
                <span className="text-[11px] text-[#8b949e]">{user.email}</span>
              </div>
            </div>

            {onLogout && (
              <button
                onClick={onLogout}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-[#ef5350] bg-[#ef5350]/10 hover:bg-[#ef5350]/20 border border-[#ef5350]/30 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Çıkış Yap</span>
              </button>
            )}
          </div>
        ) : (
          <div className="bg-[#0d1117] border border-[#2a3038] rounded-lg p-3 space-y-2">
            <p className="text-xs text-[#8b949e]">
              Favorilerinizi ve terminal ayarlarınızı tüm cihazlarınızda canlı senkronize etmek için Google hesabınızla giriş yapın.
            </p>
            {onLogin && (
              <button
                onClick={onLogin}
                disabled={isLoggingIn}
                className={`flex items-center justify-center gap-2 w-full py-2 px-3 rounded-lg text-xs font-bold text-white transition-colors shadow ${
                  isLoggingIn
                    ? 'bg-[#4c8ce0]/50 cursor-wait'
                    : 'bg-[#4c8ce0] hover:bg-[#4c8ce0]/90 cursor-pointer'
                }`}
              >
                <LogIn className="w-4 h-4" />
                <span>{isLoggingIn ? 'Google Hesabı Bağlanıyor...' : 'Google ile Giriş Yap'}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* 1. Duvar Işınları & Canlı Grafik Katmanları */}
      <div className="bg-[#161b22] border border-[#2a3038] rounded-xl p-3.5 shadow-lg space-y-3">
        <h3 className="text-xs font-bold text-[#8b949e] uppercase tracking-wider flex items-center gap-1.5">
          <Layers className="w-4 h-4 text-[#4c8ce0]" />
          <span>Duvar Işınları & Grafik Katmanları</span>
        </h3>

        <div className="space-y-3 divide-y divide-[#2a3038]/60 text-sm">
          <div className="flex items-center justify-between pt-2">
            <div>
              <span className="font-semibold text-[#e6e8ea] block">Duvar Işınları & Etiketleri</span>
              <small className="text-xs text-[#8b949e]">Canlı fiyata uzanan kurumsal seviye ışınları, nominal büyüklükler ve durum rozetleri</small>
            </div>
            <input
              type="checkbox"
              checked={settings.showWallRays}
              onChange={(e) => update('showWallRays', e.target.checked)}
              className="w-4 h-4 accent-[#4c8ce0] rounded cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between pt-3">
            <div>
              <span className="font-semibold text-[#e6e8ea] block">Canlı DOM Kademe Çubukları (Ladder)</span>
              <small className="text-xs text-[#8b949e]">Fiyat ekseni boyunca anlık L2 alış/satış kademe derinlik histogramı</small>
            </div>
            <input
              type="checkbox"
              checked={settings.showLadder}
              onChange={(e) => update('showLadder', e.target.checked)}
              className="w-4 h-4 accent-[#4c8ce0] rounded cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between pt-3">
            <div>
              <span className="font-semibold text-[#e6e8ea] block">Likidite Isı Haritası (Heatmap)</span>
              <small className="text-xs text-[#8b949e]">Mumların arkasında hafif derinlik yoğunluğu parlaması</small>
            </div>
            <input
              type="checkbox"
              checked={settings.showHeatmap}
              onChange={(e) => update('showHeatmap', e.target.checked)}
              className="w-4 h-4 accent-[#4c8ce0] rounded cursor-pointer"
            />
          </div>

          <div className="pt-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
            <label className="flex items-center justify-between bg-[#0d1117] px-2.5 py-2 rounded-lg border border-[#2a3038] cursor-pointer text-xs">
              <span className="font-semibold text-[#e6e8ea]">MA ({settings.ma1}/{settings.ma2}/{settings.ma3})</span>
              <input
                type="checkbox"
                checked={settings.showMa}
                onChange={(e) => update('showMa', e.target.checked)}
                className="w-3.5 h-3.5 accent-[#4c8ce0] rounded"
              />
            </label>
            <label className="flex items-center justify-between bg-[#0d1117] px-2.5 py-2 rounded-lg border border-[#2a3038] cursor-pointer text-xs">
              <span className="font-semibold text-[#e6e8ea]">VWAP</span>
              <input
                type="checkbox"
                checked={settings.showVwap}
                onChange={(e) => update('showVwap', e.target.checked)}
                className="w-3.5 h-3.5 accent-[#4c8ce0] rounded"
              />
            </label>
            <label className="flex items-center justify-between bg-[#0d1117] px-2.5 py-2 rounded-lg border border-[#2a3038] cursor-pointer text-xs">
              <span className="font-semibold text-[#e6e8ea]">PSAR</span>
              <input
                type="checkbox"
                checked={settings.showSar}
                onChange={(e) => update('showSar', e.target.checked)}
                className="w-3.5 h-3.5 accent-[#4c8ce0] rounded"
              />
            </label>
            <label className="flex items-center justify-between bg-[#0d1117] px-2.5 py-2 rounded-lg border border-[#2a3038] cursor-pointer text-xs">
              <span className="font-semibold text-[#e6e8ea]">Bollinger</span>
              <input
                type="checkbox"
                checked={settings.showBB}
                onChange={(e) => update('showBB', e.target.checked)}
                className="w-3.5 h-3.5 accent-[#4c8ce0] rounded"
              />
            </label>
            <label className="flex items-center justify-between bg-[#0d1117] px-2.5 py-2 rounded-lg border border-[#2a3038] cursor-pointer text-xs">
              <span className="font-semibold text-[#e6e8ea]">Hacim</span>
              <input
                type="checkbox"
                checked={settings.showVol}
                onChange={(e) => update('showVol', e.target.checked)}
                className="w-3.5 h-3.5 accent-[#4c8ce0] rounded"
              />
            </label>
          </div>
        </div>
      </div>

      {/* 2. Microstructure Detection Thresholds */}
      <div className="bg-[#161b22] border border-[#2a3038] rounded-xl p-3.5 shadow-lg space-y-3">
        <h3 className="text-xs font-bold text-[#8b949e] uppercase tracking-wider flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Shield className="w-4 h-4 text-[#26a69a]" />
            <span>Tespit & Doğrulama Eşikleri</span>
          </span>
          {engine && (
            <span
              className={`text-[10px] px-2 py-0.5 rounded font-black font-mono border uppercase ${
                engine.liquidityTier === 'MEGA_CAP'
                  ? 'bg-[#e0b64c]/20 text-[#e0b64c] border-[#e0b64c]/50'
                  : engine.liquidityTier === 'LARGE_CAP'
                  ? 'bg-[#4c8ce0]/20 text-[#4c8ce0] border-[#4c8ce0]/50'
                  : engine.liquidityTier === 'MID_CAP'
                  ? 'bg-[#26a69a]/20 text-[#26a69a] border-[#26a69a]/50'
                  : 'bg-[#b06ce0]/20 text-[#b06ce0] border-[#b06ce0]/50'
              }`}
            >
              {engine.liquidityTier.replace('_', ' ')}
            </span>
          )}
        </h3>

        <div className="space-y-3.5 text-sm">
          {/* Adaptive Auto-Scaling Toggle */}
          <div className="bg-[#0d1117] p-3 rounded-lg border border-[#2a3038] space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-[#e0b64c]" />
                <div>
                  <span className="font-semibold text-[#e6e8ea] block text-xs">
                    Akıllı Dinamik Eşik Ölçekleme (Coin Tier Adaptasyonu)
                  </span>
                  <small className="text-[11px] text-[#8b949e]">
                    BTC ile ALLO aynı ölçekte değerlendirilmez. 24s hacim ve L2 derinliğine göre eşikler otomatik adapte olur.
                  </small>
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.autoScaleThresholds}
                onChange={(e) => update('autoScaleThresholds', e.target.checked)}
                className="w-4 h-4 accent-[#4c8ce0] rounded cursor-pointer flex-none ml-2"
              />
            </div>

            {/* Live Effective Thresholds Breakdown */}
            {engine && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-1.5 border-t border-[#21262d] text-center font-mono text-[10px]">
                <div className="bg-[#161b22] p-1.5 rounded border border-[#2a3038]">
                  <span className="text-[#8b949e] block text-[9px]">BALİNA (WHALE)</span>
                  <b className="text-[#26a69a] text-[11px]">
                    ${engine.formatCompact(engine.effectiveWhaleMinUsdt)}
                  </b>
                </div>
                <div className="bg-[#161b22] p-1.5 rounded border border-[#2a3038]">
                  <span className="text-[#8b949e] block text-[9px]">CVD YÖNÜ (30s)</span>
                  <b className="text-[#4c8ce0] text-[11px]">
                    ±${engine.formatCompact(engine.effectiveCvdThreshold)}
                  </b>
                </div>
                <div className="bg-[#161b22] p-1.5 rounded border border-[#2a3038]">
                  <span className="text-[#8b949e] block text-[9px]">DELTA PATLAMASI</span>
                  <b className="text-[#e0b64c] text-[11px]">
                    ${engine.formatCompact(engine.effectiveDeltaBurstThreshold)}
                  </b>
                </div>
                <div className="bg-[#161b22] p-1.5 rounded border border-[#2a3038]">
                  <span className="text-[#8b949e] block text-[9px]">DUVAR TABANI</span>
                  <b className="text-[#e6e8ea] text-[11px]">
                    ${engine.formatCompact(engine.effectiveWallFloor)}
                  </b>
                </div>
              </div>
            )}
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="font-semibold text-[#e6e8ea]">Duvar Persentil Eşiği</span>
              <b className="font-mono text-[#4c8ce0]">%{settings.wallPct}</b>
            </div>
            <input
              type="range"
              min="80"
              max="99"
              value={settings.wallPct}
              onChange={(e) => update('wallPct', Number(e.target.value))}
              className="w-full accent-[#4c8ce0]"
            />
            <small className="text-xs text-[#8b949e]">Tahtadaki en üst dilime giren göreli büyük emirler</small>
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="font-semibold text-[#e6e8ea]">Minimum Duvar Yaşı (Kalıcılık)</span>
              <b className="font-mono text-[#e0b64c]">{settings.wallMinAgeSec} saniye</b>
            </div>
            <input
              type="range"
              min="10"
              max="60"
              step="5"
              value={settings.wallMinAgeSec}
              onChange={(e) => update('wallMinAgeSec', Number(e.target.value))}
              className="w-full accent-[#e0b64c]"
            />
            <small className="text-xs text-[#8b949e]">Bu süreyi aşan emirler ⏱ (kalıcı/gerçek) rozeti alır</small>
          </div>

          {!settings.autoScaleThresholds ? (
            <div className="border-t border-[#2a3038] pt-2">
              <div className="flex justify-between mb-1">
                <span className="font-semibold text-[#e6e8ea]">Manuel Balina / Büyük Emir Eşiği</span>
                <b className="font-mono text-[#26a69a]">${settings.whaleMinUsdt.toLocaleString()}</b>
              </div>
              <input
                type="range"
                min="5000"
                max="1000000"
                step="5000"
                value={settings.whaleMinUsdt}
                onChange={(e) => update('whaleMinUsdt', Number(e.target.value))}
                className="w-full accent-[#26a69a]"
              />
              <small className="text-xs text-[#8b949e]">Tüm diğer eşikler bu değere orantılı olarak manuel ayarlanır.</small>
            </div>
          ) : (
            <div className="text-[11px] text-[#8b949e] bg-[#0d1117] p-2 rounded border border-[#21262d]">
              ℹ️ Otomatik ölçekleme açık olduğunda, balina ve akış eşikleri seçili coin&apos;in 24s işlem hacmine (${engine ? engine.formatCompact(engine.quoteVolume24h) : '0'}) ve tahta yoğunluğuna göre dinamik yönetilir.
            </div>
          )}
        </div>
      </div>

      {/* 3. Audio & Alerts */}
      <div className="bg-[#161b22] border border-[#2a3038] rounded-xl p-3.5 shadow-lg space-y-3">
        <h3 className="text-xs font-bold text-[#8b949e] uppercase tracking-wider flex items-center gap-1.5">
          <Volume2 className="w-4 h-4 text-[#e0b64c]" />
          <span>Ses & Bildirim Ayarları</span>
        </h3>

        <div className="space-y-3 divide-y divide-[#2a3038]/60 text-sm">
          <div className="flex items-center justify-between pt-2">
            <span className="font-semibold text-[#e6e8ea]">Sesli Bildirimler</span>
            <input
              type="checkbox"
              checked={settings.alertSound}
              onChange={(e) => update('alertSound', e.target.checked)}
              className="w-4 h-4 accent-[#4c8ce0] rounded cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between pt-3">
            <span className="font-semibold text-[#e6e8ea]">Yüksek Akış & Sweep Uyarıları</span>
            <input
              type="checkbox"
              checked={settings.alertOnHighFlow}
              onChange={(e) => update('alertOnHighFlow', e.target.checked)}
              className="w-4 h-4 accent-[#4c8ce0] rounded cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between pt-3">
            <span className="font-semibold text-[#e6e8ea]">Scalp Fırsat Sinyali Uyarıları</span>
            <input
              type="checkbox"
              checked={settings.alertOnOpportunity}
              onChange={(e) => update('alertOnOpportunity', e.target.checked)}
              className="w-4 h-4 accent-[#4c8ce0] rounded cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between pt-3">
            <span className="font-semibold text-[#e6e8ea]">Mobil Vibrasyon</span>
            <input
              type="checkbox"
              checked={settings.alertVibrate}
              onChange={(e) => update('alertVibrate', e.target.checked)}
              className="w-4 h-4 accent-[#4c8ce0] rounded cursor-pointer"
            />
          </div>

          <div className="pt-3">
            <div className="flex justify-between mb-1">
              <span className="font-semibold text-[#e6e8ea]">Ses Düzeyi</span>
              <b className="font-mono text-[#e6e8ea]">{(settings.alertSoundVol * 100).toFixed(0)}%</b>
            </div>
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={settings.alertSoundVol}
              onChange={(e) => update('alertSoundVol', Number(e.target.value))}
              className="w-full accent-[#4c8ce0]"
            />
          </div>
        </div>
      </div>

      {/* Reset */}
      <button
        onClick={onReset}
        className="w-full py-2 bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-[#e6e8ea] text-xs font-bold rounded-lg border border-[#2a3038] transition-colors"
      >
        Varsayılan Ayarlara Dön
      </button>
    </div>
  );
};
