import React from 'react';
import { TrendingUp, Star, Settings } from 'lucide-react';

export type ActiveTab = 'chart' | 'favorites' | 'settings';

interface BottomNavProps {
  activeTab: ActiveTab;
  onChangeTab: (tab: ActiveTab) => void;
  favoritesCount?: number;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onChangeTab,
  favoritesCount = 0,
}) => {
  const tabs = [
    { id: 'chart' as ActiveTab, label: 'Grafik', icon: TrendingUp },
    { id: 'favorites' as ActiveTab, label: 'Favoriler', icon: Star, badge: favoritesCount },
    { id: 'settings' as ActiveTab, label: 'Ayarlar', icon: Settings },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-14 bg-[#161b22] border-t border-[#2a3038] flex items-center justify-around z-50 px-3 pb-safe">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onChangeTab(tab.id)}
            className={`relative flex flex-col items-center justify-center flex-1 py-1 text-xs font-bold transition-all ${
              isActive ? 'text-[#4c8ce0]' : 'text-[#8b949e] hover:text-[#e6e8ea]'
            }`}
          >
            <div className="relative">
              <Icon className="w-5 h-5 mb-0.5" />
              {tab.badge && tab.badge > 0 ? (
                <span className="absolute -top-1 -right-2 bg-[#e0b64c] text-[#0d1117] text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center shadow">
                  {tab.badge}
                </span>
              ) : null}
            </div>
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
};
