import React, { useState } from 'react';
import { Star, Trash2, Plus, ArrowUpRight, ArrowDownRight, Search } from 'lucide-react';

interface FavoritesViewProps {
  favorites: string[];
  currentSymbol: string;
  allSymbols: string[];
  lastPrice: number;
  priceChangePercent: number;
  onSelectSymbol: (symbol: string) => void;
  onRemoveFavorite: (symbol: string) => void;
  onAddFavorite: (symbol: string) => void;
}

export const FavoritesView: React.FC<FavoritesViewProps> = ({
  favorites,
  currentSymbol,
  allSymbols,
  lastPrice,
  priceChangePercent,
  onSelectSymbol,
  onRemoveFavorite,
  onAddFavorite,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  const searchResults = searchQuery.trim()
    ? allSymbols.filter(
        (s) => s.includes(searchQuery.trim().toUpperCase()) && !favorites.includes(s)
      ).slice(0, 15)
    : allSymbols.filter((s) => !favorites.includes(s)).slice(0, 10);

  const handleAdd = (sym: string) => {
    onAddFavorite(sym);
    setSearchQuery('');
    setShowAddModal(false);
  };

  return (
    <div className="p-3 space-y-3 pb-24 max-w-xl mx-auto">
      {/* Top Header */}
      <div className="flex items-center justify-between bg-[#161b22] border border-[#2a3038] rounded-xl p-3 shadow-md">
        <div className="flex items-center gap-2">
          <Star className="w-5 h-5 text-[#e0b64c] fill-current" />
          <div>
            <h3 className="font-extrabold text-sm text-[#e6e8ea]">Favori Takip Listesi</h3>
            <span className="text-[11px] text-[#8b949e]">
              {favorites.length} sembol izleniyor
            </span>
          </div>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1 bg-[#4c8ce0] hover:bg-[#4c8ce0]/90 text-white font-bold text-xs px-3 py-1.5 rounded-lg shadow transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Coin Ekle</span>
        </button>
      </div>

      {/* Add Coin Search Dropdown */}
      {showAddModal && (
        <div className="bg-[#161b22] border border-[#2a3038] rounded-xl p-3 shadow-xl space-y-2">
          <div className="flex items-center gap-2 bg-[#0d1117] border border-[#2a3038] rounded-lg px-2.5 py-1.5">
            <Search className="w-4 h-4 text-[#8b949e]" />
            <input
              type="text"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Coin ara ve ekle (örn: BTC, ETH)..."
              className="bg-transparent border-none outline-none text-[#e6e8ea] w-full text-xs font-semibold uppercase"
            />
          </div>

          <div className="max-h-48 overflow-y-auto divide-y divide-[#2a3038]/50">
            {searchResults.map((sym) => (
              <div
                key={sym}
                onClick={() => handleAdd(sym)}
                className="flex items-center justify-between p-2 hover:bg-[#21262d] cursor-pointer rounded transition-colors text-xs"
              >
                <span className="font-bold text-[#e6e8ea]">{sym}</span>
                <span className="text-[#4c8ce0] font-semibold flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Ekle
                </span>
              </div>
            ))}
            {searchResults.length === 0 && (
              <div className="p-3 text-center text-xs text-[#8b949e]">
                Eklenecek yeni sembol bulunamadı.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Favorites List */}
      <div className="bg-[#161b22] border border-[#2a3038] rounded-xl overflow-hidden shadow-xl">
        <div className="divide-y divide-[#2a3038]/60">
          {favorites.map((sym) => {
            const isCurrent = sym === currentSymbol;
            return (
              <div
                key={sym}
                className={`p-3 flex items-center justify-between transition-colors ${
                  isCurrent ? 'bg-[#21262d]/90' : 'hover:bg-[#21262d]/50'
                }`}
              >
                {/* Left: Click to Select Symbol */}
                <div
                  onClick={() => onSelectSymbol(sym)}
                  className="flex-1 cursor-pointer flex items-center gap-2.5"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      isCurrent ? 'bg-[#26a69a] shadow-[0_0_6px_#26a69a]' : 'bg-[#2a3038]'
                    }`}
                  />
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-extrabold text-sm text-[#e6e8ea]">{sym}</span>
                      {isCurrent && (
                        <span className="text-[9px] bg-[#26a69a]/20 text-[#26a69a] font-bold px-1.5 py-0.2 rounded">
                          AKTİF
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-[#8b949e]">Binance USDⓈ-M</span>
                  </div>
                </div>

                {/* Right: Price & Delete */}
                <div className="flex items-center gap-3">
                  {isCurrent && lastPrice > 0 && (
                    <div className="text-right">
                      <span className="font-mono text-xs font-bold text-[#e6e8ea] block">
                        {lastPrice}
                      </span>
                      <span
                        className={`font-mono text-[10px] font-semibold flex items-center justify-end ${
                          priceChangePercent >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'
                        }`}
                      >
                        {priceChangePercent >= 0 ? (
                          <ArrowUpRight className="w-3 h-3" />
                        ) : (
                          <ArrowDownRight className="w-3 h-3" />
                        )}
                        {priceChangePercent.toFixed(2)}%
                      </span>
                    </div>
                  )}

                  <button
                    onClick={() => onRemoveFavorite(sym)}
                    className="p-1.5 text-[#8b949e] hover:text-[#ef5350] transition-colors rounded hover:bg-[#0d1117]"
                    title="Favorilerden Kaldır"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}

          {favorites.length === 0 && (
            <div className="p-8 text-center text-xs text-[#8b949e]">
              Henüz favori eklenmedi. Üstteki &quot;Coin Ekle&quot; butonuna basarak istediğin coinleri ekleyebilirsin.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
