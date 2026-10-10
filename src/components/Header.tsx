import React, { useState } from 'react';
import { Star, Settings as SettingsIcon, Search } from 'lucide-react';

interface HeaderProps {
  symbol: string;
  symbols: string[];
  lastPrice: number;
  priceChangePercent: number;
  isConnected: boolean;
  isFavorite: boolean;
  onSelectSymbol: (symbol: string) => void;
  onToggleFavorite: () => void;
  onOpenSettings: () => void;
  precision?: number;
  user?: { displayName?: string | null; email?: string | null; photoURL?: string | null } | null;
  onLogin?: () => void;
  isLoggingIn?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  symbol,
  symbols,
  lastPrice,
  priceChangePercent,
  isConnected,
  isFavorite,
  onSelectSymbol,
  onToggleFavorite,
  onOpenSettings,
  precision = 4,
  user,
  onLogin,
  isLoggingIn = false,
}) => {
  const [query, setQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const filtered = query.trim()
    ? symbols.filter((s) => s.includes(query.trim().toUpperCase())).slice(0, 30)
    : symbols.slice(0, 15);

  const handleSelect = (s: string) => {
    onSelectSymbol(s);
    setQuery('');
    setIsSearchOpen(false);
  };

  return (
    <>
      <header className="fixed top-0 left-0 right-0 h-13 bg-[#161b22] border-b border-[#2a3038] flex items-center justify-between px-3 z-50">
        {/* Left: Connection dot & Symbol Selector */}
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full flex-none transition-colors duration-300 ${
              isConnected ? 'bg-[#26a69a] shadow-[0_0_8px_#26a69a]' : 'bg-[#ef5350]'
            }`}
            title={isConnected ? 'Binance WS Bağlı' : 'Bağlantı Bekleniyor'}
          />

          <div className="relative">
            <button
              onClick={() => setIsSearchOpen(!isSearchOpen)}
              className="flex items-center gap-1.5 bg-[#0d1117] border border-[#2a3038] hover:border-[#4c8ce0] px-2.5 py-1.5 rounded-lg text-sm font-bold tracking-wide text-[#e6e8ea]"
            >
              <span>{symbol}</span>
              <Search className="w-3.5 h-3.5 text-[#8b949e]" />
            </button>
          </div>

          <button
            onClick={onToggleFavorite}
            className={`p-1 transition-colors ${
              isFavorite ? 'text-[#e0b64c]' : 'text-[#8b949e] hover:text-[#e6e8ea]'
            }`}
            title="Favorilere Ekle"
          >
            <Star className="w-4.5 h-4.5 fill-current" />
          </button>
        </div>

        {/* Right: Quick Settings + Real-Time Price */}
        <div className="flex items-center gap-2 sm:gap-3">
          {user ? (
            <button
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 bg-[#161b22] border border-[#26a69a]/50 text-[#26a69a] px-2 py-1 rounded-md text-xs font-semibold"
              title={`${user.email || user.displayName || 'Kullanıcı'} (Bulut Senkronize)`}
            >
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-4 h-4 rounded-full" />
              ) : (
                <span className="w-4 h-4 rounded-full bg-[#26a69a]/20 flex items-center justify-center text-[10px] font-bold">
                  {(user.displayName || user.email || 'U')[0].toUpperCase()}
                </span>
              )}
              <span className="hidden sm:inline text-[11px] truncate max-w-20">
                {user.displayName || 'Bulut'}
              </span>
            </button>
          ) : (
            onLogin && (
              <button
                onClick={onLogin}
                disabled={isLoggingIn}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold transition-all ${
                  isLoggingIn
                    ? 'bg-[#4c8ce0]/10 border border-[#4c8ce0]/20 text-[#8b949e] cursor-wait'
                    : 'bg-[#4c8ce0]/20 border border-[#4c8ce0]/40 text-[#4c8ce0] hover:bg-[#4c8ce0]/30'
                }`}
                title="Google ile Giriş Yap & Senkronize Et"
              >
                <span>{isLoggingIn ? 'Bağlanıyor...' : 'Giriş'}</span>
              </button>
            )
          )}

          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1 bg-[#4c8ce0]/15 border border-[#4c8ce0]/40 text-[#4c8ce0] hover:bg-[#4c8ce0]/25 px-2 py-1 rounded-md text-xs font-semibold"
          >
            <SettingsIcon className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Ayarlar</span>
          </button>

          <div className="flex flex-col items-end">
            <span className="font-mono text-base font-extrabold tracking-tight text-[#e6e8ea]">
              {lastPrice > 0 ? lastPrice.toFixed(precision) : '—'}
            </span>
            <span
              className={`font-mono text-[11px] font-bold ${
                priceChangePercent >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'
              }`}
            >
              {priceChangePercent >= 0 ? '+' : ''}
              {priceChangePercent.toFixed(2)}%
            </span>
          </div>
        </div>
      </header>

      {/* Symbol Search Modal Dropdown */}
      {isSearchOpen && (
        <div className="fixed inset-x-0 top-13 max-h-[60vh] bg-[#161b22] border-b border-[#2a3038] shadow-2xl z-50 overflow-y-auto p-2">
          <div className="p-2 border-b border-[#2a3038] flex items-center gap-2">
            <Search className="w-4 h-4 text-[#8b949e]" />
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Coin ara (örn: BTC, ETH, SOL)..."
              className="bg-transparent border-none outline-none text-[#e6e8ea] w-full text-sm font-semibold uppercase"
            />
          </div>

          <div className="divide-y divide-[#2a3038]/50">
            {filtered.map((s) => (
              <div
                key={s}
                onClick={() => handleSelect(s)}
                className="flex items-center justify-between p-2.5 hover:bg-[#21262d] cursor-pointer rounded-md transition-colors"
              >
                <span className="font-bold text-sm text-[#e6e8ea]">{s}</span>
                <span className="text-xs text-[#8b949e]">PERP USDT</span>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="p-4 text-center text-xs text-[#8b949e]">Sembol bulunamadı.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
