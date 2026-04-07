'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useGameStore } from '@/stores/game';
import { useLocationAgent } from '@/hooks/use-locations';
import { MAP_LOCATIONS } from '@legacyapp/shared';
import { api } from '@/lib/api';

function LocationStatusDot({ locationId }: { locationId: string }) {
  const { data: agent } = useLocationAgent(locationId);
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${
        agent ? 'bg-green-500 shadow-[0_0_4px_rgba(74,222,128,0.6)]' : 'bg-gray-500/50'
      }`}
    />
  );
}

type MenuView = 'main' | 'locations' | 'help';

export default function GameMenu() {
  const router = useRouter();
  const { menuOpen, setMenuOpen, setSettingsModalOpen, openLocationConfig, openclawConnected, setOpenclawModalOpen, setSkillBuilderOpen, openMarketplace } =
    useGameStore();
  const [view, setView] = useState<MenuView>('main');
  const menuRef = useRef<HTMLDivElement>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  // Reset view when menu closes
  useEffect(() => {
    if (!menuOpen) {
      setView('main');
    }
  }, [menuOpen]);

  // Close on click outside
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen, setMenuOpen]);

  // Close on Escape
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [menuOpen, setMenuOpen]);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await api.logout();
      router.push('/login');
    } catch {
      setLoggingOut(false);
    }
  };

  const handleOpenPetSettings = () => {
    setMenuOpen(false);
    setSettingsModalOpen(true);
  };

  const handleLocationClick = (locationId: string) => {
    setMenuOpen(false);
    openLocationConfig(locationId);
  };

  return (
    <div ref={menuRef} className="fixed top-4 right-4 z-50">
      {/* Gear button */}
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className="w-12 h-12 rounded-full bg-gradient-to-b from-yellow-400 to-yellow-600 border-3 border-yellow-700 shadow-claw flex items-center justify-center text-2xl hover:brightness-110 transition-all active:translate-y-0.5 active:shadow-none"
        aria-label="Game menu"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      {/* Dropdown */}
      {menuOpen && (
        <div className="absolute top-14 right-0 w-72 border-3 border-claw-panel-border rounded-xl bg-gradient-to-b from-[#FFE066] to-[#FFD700] shadow-claw overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
          {view === 'main' && (
            <div className="py-1">
              <button
                onClick={handleOpenPetSettings}
                className="w-full px-4 py-3 text-left text-white font-semibold hover:bg-yellow-400/50 transition-colors flex items-center gap-3"
              >
                <span className="text-lg">🐾</span>
                My Pet
              </button>
              <button
                onClick={() => setView('locations')}
                className="w-full px-4 py-3 text-left text-white font-semibold hover:bg-yellow-400/50 transition-colors flex items-center gap-3"
              >
                <span className="text-lg">🗺️</span>
                Locations
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  useGameStore.getState().toggleActivityFeed();
                }}
                className="w-full px-4 py-3 text-left text-white font-semibold hover:bg-yellow-400/50 transition-colors flex items-center gap-3"
              >
                <span className="text-lg">📋</span>
                Activity Log
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setOpenclawModalOpen(true);
                }}
                className="w-full px-4 py-3 text-left text-white font-semibold hover:bg-yellow-400/50 transition-colors flex items-center gap-3"
              >
                <span className="text-lg">🔌</span>
                {openclawConnected ? (
                  <span className="flex items-center gap-2">
                    OpenClaw
                    <span className="w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_4px_rgba(74,222,128,0.6)]" />
                  </span>
                ) : (
                  'Connect OpenClaw'
                )}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setSkillBuilderOpen(true);
                }}
                className="w-full px-4 py-3 text-left text-white font-semibold hover:bg-yellow-400/50 transition-colors flex items-center gap-3"
              >
                <span className="text-lg">🔧</span>
                Skill Builder
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  openMarketplace();
                }}
                className="w-full px-4 py-3 text-left text-white font-semibold hover:bg-yellow-400/50 transition-colors flex items-center gap-3"
              >
                <span className="text-lg">🛒</span>
                Marketplace
              </button>
              <button
                onClick={() => setView('help')}
                className="w-full px-4 py-3 text-left text-white font-semibold hover:bg-yellow-400/50 transition-colors flex items-center gap-3"
              >
                <span className="text-lg">❓</span>
                How to Play
              </button>
              <div className="border-t border-yellow-600/30 mx-3" />
              <button
                onClick={handleLogout}
                disabled={loggingOut}
                className="w-full px-4 py-3 text-left text-red-700 font-semibold hover:bg-red-100/50 transition-colors flex items-center gap-3 disabled:opacity-50"
              >
                <span className="text-lg">🚪</span>
                {loggingOut ? 'Logging out...' : 'Logout'}
              </button>
            </div>
          )}

          {view === 'locations' && (
            <div>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-yellow-600/30">
                <button
                  onClick={() => setView('main')}
                  className="text-white/70 hover:text-white transition-colors font-bold"
                  aria-label="Back"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
                <span className="font-bold text-white">Locations</span>
              </div>
              <div className="max-h-80 overflow-y-auto py-1">
                {MAP_LOCATIONS.map((loc) => (
                  <button
                    key={loc.id}
                    onClick={() => handleLocationClick(loc.id)}
                    className="w-full px-4 py-2.5 text-left hover:bg-yellow-400/50 transition-colors flex items-center gap-3"
                  >
                    <LocationStatusDot locationId={loc.id} />
                    <span className="text-sm">{loc.icon}</span>
                    <span className="text-sm text-white font-medium truncate">
                      {loc.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {view === 'help' && (
            <div>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-yellow-600/30">
                <button
                  onClick={() => setView('main')}
                  className="text-white/70 hover:text-white transition-colors font-bold"
                  aria-label="Back"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
                <span className="font-bold text-white">How to Play</span>
              </div>
              <div className="px-4 py-3 space-y-3 text-sm text-black/90">
                <div className="flex items-start gap-3">
                  <span className="font-mono bg-white/10 rounded px-2 py-0.5 text-xs font-bold flex-shrink-0">
                    WASD
                  </span>
                  <span>Move your pet around The Depths</span>
                </div>
                <div className="flex items-start gap-3">
                  <span className="font-mono bg-white/10 rounded px-2 py-0.5 text-xs font-bold flex-shrink-0">
                    E
                  </span>
                  <span>Enter a building when nearby</span>
                </div>
                <div className="flex items-start gap-3">
                  <span className="font-mono bg-white/10 rounded px-2 py-0.5 text-xs font-bold flex-shrink-0">
                    ESC
                  </span>
                  <span>Exit a building / close chat</span>
                </div>
                <div className="border-t border-yellow-600/30 pt-3">
                  <p className="text-white/70 text-xs">
                    Walk near buildings to see their name. Enter to chat with the
                    AI agent inside. Configure agents through the Locations menu
                    or the gear icon in the chat panel.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
