'use client';

/**
 * SidebarMenu — the right-edge RPG sidebar that replaces the legacy
 * legacyapp-ported yellow-gold gear dropdown (`game-menu.tsx`).
 *
 * Visual language: ClawVille dark-navy + cyan HUD, composed entirely from
 * Team 1's RPG primitives (`RuneFrame`, `RpgButton`, `RpgModal`, `RarityBadge`,
 * `RpgTooltip`, `getRarity`). No raw `bg-black/30 border border-white/10` —
 * every chrome element comes from `@/components/rpg`.
 *
 * Category partition — mapped to the 4 TOP PROJECT PRIORITIES:
 *
 *   WORLD   (Priority 2: open agent onboarding)
 *     - Locations  — the 10 building zones where agents learn skills
 *     - OpenClaw   — external bot entry point
 *
 *   AVATAR     (Priority 1: Milady app store shipping surface)
 *     - My Avatar       — settings for the user's agent
 *     - Skill Forge  — skill authoring (renamed from Skill Builder)
 *
 *   ECONOMY (Priority 3: skill marketplace / value flow)
 *     - Marketplace  — knowledge book shop
 *     - Bazaar       — skill trading (rarity-tinted rare/cyan)
 *     - Auction      — timed bidding (rarity-tinted epic/purple)
 *
 *   QUESTS  (Priority 4: gamified UI + leaderboard + free promo)
 *     - Quest Board   — team-posted coding bounties
 *     - Bounty Board  — community-posted bounties
 *     - Activity Log  — live world signal
 *
 *   SYSTEM  (utility chrome)
 *     - How to Play   — inline WASD/E/ESC hints
 *     - Logout        — (danger variant)
 *
 * Layout:
 *   - Desktop: floating column at `top: 56px, right: 16px`, 220px wide,
 *     max-height `calc(100vh - 80px)`, scrolls internally. Sits below the
 *     PerfHud strip so we don't collide with its `right-20 top-4` pill.
 *   - Mobile (<768px): collapses to a single gear FAB; tapping opens an
 *     RpgModal with the same content.
 *
 * Component tree:
 *   SidebarMenu
 *   ├── (desktop) SidebarShell        — RuneFrame wrapper with character frame
 *   │             + 5 category sections
 *   └── (mobile)  GearFAB + RpgModal  — same SidebarShell contents
 *
 * Store contract — zero new actions, reads/writes the exact existing store:
 *   setSettingsModalOpen, openLocationConfig, setOpenclawModalOpen,
 *   setSkillBuilderOpen, openMarketplace, openBazaar, openAuction,
 *   openQuestBoard, openBountyBoard, toggleActivityFeed.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { MAP_LOCATIONS, AVATAR_SPECIES } from '@clawville/shared';
import { RuneFrame, RpgButton, RpgModal, RpgTooltip, getRarity, type RarityId } from '@/components/rpg';
import { useGameStore, type GameState } from '@/stores/game';
import { useLocationAgent } from '@/hooks/use-locations';
import { useAvatar } from '@/hooks/use-avatar';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Responsive hook — matches the same 768px breakpoint AvatarStatusBar uses.
// ---------------------------------------------------------------------------

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}

// ---------------------------------------------------------------------------
// Character frame — top-of-sidebar "unit frame" showing the avatar identity.
// ---------------------------------------------------------------------------

function CharacterFrame({ onCreatePet }: { onCreatePet: () => void }) {
  const { data: avatar, isLoading } = useAvatar();

  if (isLoading) {
    return (
      <div
        style={{
          padding: '14px 14px 12px',
          borderBottom: '1px solid rgba(56, 189, 248, 0.18)',
        }}
      >
        <div
          style={{
            height: 54,
            borderRadius: 6,
            background: 'rgba(15, 31, 58, 0.55)',
            animation: 'pulse 1.6s ease-in-out infinite',
          }}
        />
      </div>
    );
  }

  if (!avatar) {
    return (
      <div
        style={{
          padding: '14px 14px 14px',
          borderBottom: '1px solid rgba(56, 189, 248, 0.18)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 11,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'rgba(56, 189, 248, 0.75)',
            fontWeight: 700,
          }}
        >
          No Agent Bound
        </div>
        <p style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.4, margin: 0 }}>
          Enter the world by selecting or creating an agent.
        </p>
        <RpgButton size="sm" variant="primary" onClick={onCreatePet}>
          Create Agent
        </RpgButton>
      </div>
    );
  }

  const species = AVATAR_SPECIES.find((s) => s.id === avatar.species);
  const emoji = species?.emoji ?? '🦞';
  const level = avatar.level ?? 1;
  const tokens = avatar.clawTokens ?? 0;
  const knowledgeCount =
    (avatar.characterConfig as { knowledge?: unknown[] } | null)?.knowledge?.length ?? 0;

  return (
    <div
      style={{
        padding: '14px 14px 14px',
        borderBottom: '1px solid rgba(56, 189, 248, 0.18)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Identity row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div
          aria-hidden
          style={{
            width: 42,
            height: 42,
            flexShrink: 0,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 24,
            background:
              'linear-gradient(160deg, rgba(56, 189, 248, 0.22) 0%, rgba(10, 22, 40, 0.9) 100%)',
            border: '1px solid rgba(56, 189, 248, 0.45)',
            boxShadow: 'inset 0 0 16px rgba(56, 189, 248, 0.18)',
            color: '#38bdf8',
          }}
        >
          {emoji}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 13,
              fontWeight: 700,
              color: '#f1f5f9',
              textShadow: '0 0 12px rgba(56, 189, 248, 0.35)',
              lineHeight: 1.15,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {avatar.name}
          </div>
          <div
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 10,
              color: 'rgba(56, 189, 248, 0.65)',
              letterSpacing: '0.08em',
              marginTop: 2,
            }}
          >
            LV {level} · {knowledgeCount} SKILLS
          </div>
        </div>
      </div>

      {/* Token balance strip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 10px',
          borderRadius: 6,
          background: 'rgba(10, 22, 40, 0.65)',
          border: '1px solid rgba(250, 204, 21, 0.25)',
        }}
      >
        <span
          style={{
            fontSize: 9,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'rgba(250, 204, 21, 0.7)',
            fontWeight: 700,
          }}
        >
          ClawTokens
        </span>
        <span
          style={{
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 13,
            fontWeight: 700,
            color: '#facc15',
            textShadow: '0 0 10px rgba(250, 204, 21, 0.35)',
          }}
        >
          {tokens.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category section header — small-caps cyan with a rune divider line.
// ---------------------------------------------------------------------------

function CategoryHeader({ label, subtitle }: { label: string; subtitle: string }) {
  return (
    <div style={{ padding: '12px 14px 6px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 2,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: 'rgba(56, 189, 248, 0.55)',
          }}
        >
          {label}
        </span>
        <span
          aria-hidden
          style={{
            flex: 1,
            height: 1,
            background:
              'linear-gradient(90deg, rgba(56, 189, 248, 0.35) 0%, transparent 100%)',
          }}
        />
      </div>
      <div
        style={{
          fontSize: 9,
          color: 'rgba(148, 163, 184, 0.55)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        {subtitle}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar row — the unit button every category uses.
// ---------------------------------------------------------------------------

interface SidebarRowProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  rarity?: RarityId;
  badge?: ReactNode;
  trailing?: ReactNode;
  danger?: boolean;
  ariaLabel?: string;
  expandedIndicator?: boolean;
}

function SidebarRow({
  icon,
  label,
  onClick,
  active = false,
  rarity,
  badge,
  trailing,
  danger = false,
  ariaLabel,
  expandedIndicator,
}: SidebarRowProps) {
  const tier = rarity ? getRarity(rarity) : null;
  const accent = danger
    ? '#f87171'
    : (tier?.base ?? '#38bdf8');
  const glow = danger
    ? 'rgba(248, 113, 113, 0.4)'
    : (tier?.glow ?? 'rgba(56, 189, 248, 0.55)');

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      aria-pressed={active}
      className="rpg-sidebar-row"
      style={
        {
          ['--rpg-row-accent' as string]: accent,
          ['--rpg-row-glow' as string]: glow,
        } as React.CSSProperties
      }
      data-active={active ? 'true' : undefined}
      data-danger={danger ? 'true' : undefined}
    >
      <span className="rpg-sidebar-row__icon" aria-hidden>
        {icon}
      </span>
      <span className="rpg-sidebar-row__label">{label}</span>
      {badge && <span className="rpg-sidebar-row__badge">{badge}</span>}
      {trailing && <span className="rpg-sidebar-row__trailing">{trailing}</span>}
      {expandedIndicator !== undefined && (
        <span
          className="rpg-sidebar-row__chevron"
          aria-hidden
          style={{ transform: expandedIndicator ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          ▸
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Locations submenu — expandable list of all 10 MAP_LOCATIONS with status dots.
// ---------------------------------------------------------------------------

function LocationStatusDot({ locationId }: { locationId: string }) {
  const { data: agent } = useLocationAgent(locationId);
  const active = !!agent;
  return (
    <>
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          flexShrink: 0,
          background: active ? '#22c55e' : 'rgba(100, 116, 139, 0.45)',
          boxShadow: active
            ? '0 0 6px rgba(34, 197, 94, 0.65)'
            : 'inset 0 0 0 1px rgba(148, 163, 184, 0.25)',
        }}
      />
      <span className="sr-only">{active ? 'Agent active' : 'No agent'}</span>
    </>
  );
}

function LocationsSubmenu({ onPick }: { onPick: (locationId: string) => void }) {
  return (
    <div className="rpg-sidebar-submenu">
      {MAP_LOCATIONS.map((loc) => (
        <button
          key={loc.id}
          type="button"
          onClick={() => onPick(loc.id)}
          className="rpg-sidebar-subrow"
          aria-label={`Configure ${loc.name}`}
        >
          <LocationStatusDot locationId={loc.id} />
          <span className="rpg-sidebar-subrow__icon" aria-hidden>
            {loc.icon}
          </span>
          <span className="rpg-sidebar-subrow__label">{loc.name}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Help submenu — inline WASD / E / ESC hint block.
// ---------------------------------------------------------------------------

function HelpSubmenu() {
  return (
    <div className="rpg-sidebar-submenu" style={{ padding: '10px 14px 12px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <HelpRow keys="WASD" label="Move your agent around The Depths" />
        <HelpRow keys="E" label="Enter a building when nearby" />
        <HelpRow keys="ESC" label="Exit a building / close chat" />
        <p
          style={{
            fontSize: 10,
            color: 'rgba(148, 163, 184, 0.7)',
            lineHeight: 1.5,
            margin: '4px 0 0',
            borderTop: '1px dashed rgba(56, 189, 248, 0.2)',
            paddingTop: 8,
          }}
        >
          Walk near buildings to see their name. Enter to chat with the agent
          inside, or configure it via Locations.
        </p>
      </div>
    </div>
  );
}

function HelpRow({ keys, label }: { keys: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <span
        style={{
          flexShrink: 0,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.06em',
          padding: '3px 7px',
          borderRadius: 4,
          background: 'rgba(56, 189, 248, 0.12)',
          border: '1px solid rgba(56, 189, 248, 0.35)',
          color: '#cbd5e1',
        }}
      >
        {keys}
      </span>
      <span style={{ fontSize: 11, color: '#cbd5e1', lineHeight: 1.4 }}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar content — the actual category list, shared by desktop and mobile.
// ---------------------------------------------------------------------------

interface SidebarContentProps {
  closeMenu: () => void;
}

function SidebarContent({ closeMenu }: SidebarContentProps) {
  const router = useRouter();

  // Pull every store action we need with discrete selectors — this keeps the
  // zustand subscription surface tight so the sidebar re-renders only when
  // one of these flags actually changes.
  const openclawConnected = useGameStore((s: GameState) => s.openclawConnected);
  const activityFeedOpen = useGameStore((s: GameState) => s.activityFeedOpen);
  const setSettingsModalOpen = useGameStore((s: GameState) => s.setSettingsModalOpen);
  const openLocationConfig = useGameStore((s: GameState) => s.openLocationConfig);
  const setOpenclawModalOpen = useGameStore((s: GameState) => s.setOpenclawModalOpen);
  const setSkillBuilderOpen = useGameStore((s: GameState) => s.setSkillBuilderOpen);
  const openMarketplace = useGameStore((s: GameState) => s.openMarketplace);
  const openBazaar = useGameStore((s: GameState) => s.openBazaar);
  const openAuction = useGameStore((s: GameState) => s.openAuction);
  const openQuestBoard = useGameStore((s: GameState) => s.openQuestBoard);
  const openBountyBoard = useGameStore((s: GameState) => s.openBountyBoard);
  const toggleActivityFeed = useGameStore((s: GameState) => s.toggleActivityFeed);

  const [locationsOpen, setLocationsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const runAction = (fn: () => void) => () => {
    closeMenu();
    fn();
  };

  const handleCreateAgent = () => {
    closeMenu();
    router.push('/select-agent');
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await api.logout();
      router.push('/login');
    } catch {
      setLoggingOut(false);
    }
  };

  const handleLocationPick = (locationId: string) => {
    closeMenu();
    openLocationConfig(locationId);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <CharacterFrame onCreatePet={handleCreateAgent} />

      <div
        className="rpg-sidebar-scroll"
        style={{
          flex: '1 1 auto',
          overflowY: 'auto',
          minHeight: 0,
          paddingBottom: 10,
        }}
      >
        {/* WORLD — Priority 2: open agent onboarding surface */}
        <CategoryHeader label="World" subtitle="Enter · Connect" />
        <div className="rpg-sidebar-group">
          <SidebarRow
            icon="🗺"
            label="Locations"
            onClick={() => setLocationsOpen((v) => !v)}
            expandedIndicator={locationsOpen}
          />
          {locationsOpen && <LocationsSubmenu onPick={handleLocationPick} />}
          <SidebarRow
            icon="🔌"
            label="OpenClaw"
            onClick={runAction(() => setOpenclawModalOpen(true))}
            active={openclawConnected}
            badge={
              openclawConnected ? (
                <span
                  aria-label="Connected"
                  title="Bot training active"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: '#22c55e',
                    boxShadow: '0 0 6px rgba(34, 197, 94, 0.7)',
                    display: 'inline-block',
                  }}
                />
              ) : null
            }
          />
        </div>

        {/* AVATAR — Priority 1: Milady launch surface */}
        <CategoryHeader label="Avatar" subtitle="Configure · Forge" />
        <div className="rpg-sidebar-group">
          <SidebarRow
            icon="🐾"
            label="My Avatar"
            onClick={runAction(() => setSettingsModalOpen(true))}
          />
          <SidebarRow
            icon="🔧"
            label="Skill Forge"
            onClick={runAction(() => setSkillBuilderOpen(true))}
          />
        </div>

        {/* ECONOMY — Priority 3: skill marketplace */}
        <CategoryHeader label="Economy" subtitle="Trade · Buy · Sell" />
        <div className="rpg-sidebar-group">
          <SidebarRow
            icon="🛒"
            label="Marketplace"
            onClick={runAction(openMarketplace)}
          />
          <SidebarRow
            icon="⚖"
            label="Bazaar"
            onClick={runAction(openBazaar)}
            rarity="rare"
          />
          <SidebarRow
            icon="🔨"
            label="Auction House"
            onClick={runAction(openAuction)}
            rarity="epic"
          />
        </div>

        {/* QUESTS — Priority 4: gamified loop + bounties */}
        <CategoryHeader label="Quests" subtitle="Earn · Compete" />
        <div className="rpg-sidebar-group">
          <SidebarRow
            icon="📜"
            label="Quest Board"
            onClick={runAction(openQuestBoard)}
            rarity="legendary"
          />
          <SidebarRow
            icon="📌"
            label="Bounty Board"
            onClick={runAction(openBountyBoard)}
            rarity="uncommon"
          />
          <SidebarRow
            icon="📋"
            label="Activity Log"
            onClick={runAction(toggleActivityFeed)}
            active={activityFeedOpen}
          />
        </div>

        {/* SYSTEM — utility chrome */}
        <CategoryHeader label="System" subtitle="Help · Account" />
        <div className="rpg-sidebar-group">
          <SidebarRow
            icon="❓"
            label="How to Play"
            onClick={() => setHelpOpen((v) => !v)}
            expandedIndicator={helpOpen}
          />
          {helpOpen && <HelpSubmenu />}
          <SidebarRow
            icon="🚪"
            label={loggingOut ? 'Logging out…' : 'Logout'}
            onClick={handleLogout}
            danger
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level component — desktop column OR mobile gear FAB + RpgModal.
// ---------------------------------------------------------------------------

export default function SidebarMenu() {
  const isMobile = useIsMobile();
  const menuOpen = useGameStore((s: GameState) => s.menuOpen);
  const setMenuOpen = useGameStore((s: GameState) => s.setMenuOpen);

  // On desktop the sidebar is always visible, so we keep menuOpen in sync so
  // external code (e.g. modals) can still close it. On mobile menuOpen drives
  // the full-screen RpgModal.
  useEffect(() => {
    if (!isMobile) {
      setMenuOpen(true);
    } else {
      setMenuOpen(false);
    }
  }, [isMobile, setMenuOpen]);

  const closeMenuForMobile = useMemo(
    () => () => {
      if (isMobile) setMenuOpen(false);
    },
    [isMobile, setMenuOpen]
  );

  // Inject scoped CSS once — keeps the sidebar self-contained without adding
  // rules to the global stylesheet or touching Team 1's glow.css.
  useEffect(() => {
    const id = 'rpg-sidebar-menu-styles';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = SIDEBAR_CSS;
    document.head.appendChild(style);
  }, []);

  if (isMobile) {
    return (
      <>
        {/* Gear FAB */}
        <div
          style={{
            position: 'fixed',
            top: 12,
            right: 12,
            zIndex: 45,
          }}
        >
          <RpgTooltip content="Open menu" side="bottom">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Open game menu"
              className="rpg-sidebar-fab"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </RpgTooltip>
        </div>

        <RpgModal
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          title="ClawVille"
          subtitle="Menu"
          tier="rare"
          maxWidth={420}
          bodyClassName="rpg-sidebar-mobile-body"
        >
          <SidebarContent closeMenu={closeMenuForMobile} />
        </RpgModal>
      </>
    );
  }

  // Desktop: floating column pinned to the right edge below the perf-hud row.
  return (
    <aside
      className="rpg-sidebar-desktop"
      aria-label="ClawVille sidebar menu"
    >
      <RuneFrame
        tier="rare"
        glow="subtle"
        style={{
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 'calc(100vh - 72px)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 14px 10px',
            borderBottom: '1px solid rgba(56, 189, 248, 0.18)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: '0.06em',
                color: '#f1f5f9',
                textShadow: '0 0 14px rgba(56, 189, 248, 0.4)',
                lineHeight: 1.1,
              }}
            >
              ClawVille
            </div>
            <div
              style={{
                fontSize: 9,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: 'rgba(56, 189, 248, 0.65)',
                marginTop: 2,
              }}
            >
              The Depths
            </div>
          </div>
          <span aria-hidden style={{ fontSize: 18 }}>
            ⚓
          </span>
        </div>
        <SidebarContent closeMenu={closeMenuForMobile} />
      </RuneFrame>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Scoped CSS — injected once at mount. Kept here (not in glow.css) so this
// file is self-contained and Team 1's primitives are untouched.
// ---------------------------------------------------------------------------

const SIDEBAR_CSS = `
.rpg-sidebar-desktop {
  position: fixed;
  top: 56px;
  right: 16px;
  width: 224px;
  z-index: 45;
  pointer-events: auto;
}

@media (max-width: 1023px) and (min-width: 768px) {
  .rpg-sidebar-desktop {
    width: 208px;
  }
}

.rpg-sidebar-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(56, 189, 248, 0.35) transparent;
}

.rpg-sidebar-scroll::-webkit-scrollbar {
  width: 6px;
}

.rpg-sidebar-scroll::-webkit-scrollbar-thumb {
  background: rgba(56, 189, 248, 0.3);
  border-radius: 4px;
}

.rpg-sidebar-group {
  display: flex;
  flex-direction: column;
  padding: 2px 8px 4px;
  gap: 1px;
}

.rpg-sidebar-row {
  --rpg-row-accent: #38bdf8;
  --rpg-row-glow: rgba(56, 189, 248, 0.55);
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #cbd5e1;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-align: left;
  cursor: pointer;
  transition:
    background 160ms ease,
    border-color 180ms ease,
    color 160ms ease,
    box-shadow 200ms ease,
    transform 160ms ease;
}

.rpg-sidebar-row::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: 2px;
  background: var(--rpg-row-accent);
  opacity: 0;
  transition: opacity 180ms ease;
}

.rpg-sidebar-row:hover,
.rpg-sidebar-row:focus-visible {
  background: rgba(15, 31, 58, 0.72);
  border-color: color-mix(in srgb, var(--rpg-row-accent) 45%, transparent);
  color: #f1f5f9;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--rpg-row-accent) 25%, transparent),
    0 4px 14px color-mix(in srgb, var(--rpg-row-glow) 28%, transparent);
  outline: none;
}

.rpg-sidebar-row:hover::before,
.rpg-sidebar-row:focus-visible::before {
  opacity: 1;
}

.rpg-sidebar-row[data-active='true'] {
  background: rgba(15, 31, 58, 0.7);
  border-color: color-mix(in srgb, var(--rpg-row-accent) 55%, transparent);
  color: #f1f5f9;
  box-shadow: inset 0 0 14px color-mix(in srgb, var(--rpg-row-glow) 22%, transparent);
}

.rpg-sidebar-row[data-active='true']::before {
  opacity: 1;
  animation: rpg-sidebar-pulse 2.4s ease-in-out infinite;
}

.rpg-sidebar-row[data-danger='true'] {
  color: #fca5a5;
}

.rpg-sidebar-row[data-danger='true']:hover,
.rpg-sidebar-row[data-danger='true']:focus-visible {
  color: #fecaca;
  background: rgba(69, 10, 10, 0.45);
}

@keyframes rpg-sidebar-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

.rpg-sidebar-row__icon {
  width: 20px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  color: var(--rpg-row-accent);
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--rpg-row-glow) 35%, transparent));
}

.rpg-sidebar-row__label {
  flex: 1 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rpg-sidebar-row__badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.rpg-sidebar-row__trailing {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: rgba(148, 163, 184, 0.7);
}

.rpg-sidebar-row__chevron {
  flex-shrink: 0;
  font-size: 10px;
  color: rgba(148, 163, 184, 0.7);
  transition: transform 180ms ease;
  display: inline-block;
}

.rpg-sidebar-submenu {
  display: flex;
  flex-direction: column;
  margin: 2px 10px 6px 18px;
  padding: 4px 0;
  border-left: 1px solid rgba(56, 189, 248, 0.2);
  background: rgba(3, 10, 22, 0.4);
  border-radius: 0 6px 6px 0;
  max-height: 220px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(56, 189, 248, 0.35) transparent;
}

.rpg-sidebar-submenu::-webkit-scrollbar {
  width: 5px;
}

.rpg-sidebar-submenu::-webkit-scrollbar-thumb {
  background: rgba(56, 189, 248, 0.3);
  border-radius: 4px;
}

.rpg-sidebar-subrow {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 10px 6px 12px;
  background: transparent;
  border: none;
  color: #cbd5e1;
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease;
}

.rpg-sidebar-subrow:hover,
.rpg-sidebar-subrow:focus-visible {
  background: rgba(15, 31, 58, 0.7);
  color: #f1f5f9;
  outline: none;
}

.rpg-sidebar-subrow__icon {
  font-size: 13px;
  flex-shrink: 0;
}

.rpg-sidebar-subrow__label {
  flex: 1 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rpg-sidebar-fab {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: linear-gradient(160deg, rgba(15, 31, 58, 0.95) 0%, rgba(3, 10, 22, 0.95) 100%);
  border: 1px solid rgba(56, 189, 248, 0.45);
  color: #e0f2fe;
  box-shadow:
    0 0 0 1px rgba(56, 189, 248, 0.2),
    0 8px 22px rgba(0, 0, 0, 0.55),
    inset 0 0 18px rgba(56, 189, 248, 0.15);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    border-color 180ms ease,
    box-shadow 220ms ease,
    transform 140ms ease,
    filter 180ms ease;
}

.rpg-sidebar-fab:hover,
.rpg-sidebar-fab:focus-visible {
  border-color: rgba(56, 189, 248, 0.8);
  box-shadow:
    0 0 0 1px rgba(56, 189, 248, 0.35),
    0 10px 28px rgba(56, 189, 248, 0.35),
    inset 0 0 22px rgba(56, 189, 248, 0.22);
  transform: translateY(-1px);
  outline: none;
  filter: brightness(1.05);
}

.rpg-sidebar-fab:active {
  transform: translateY(0);
  filter: brightness(0.95);
}

.rpg-sidebar-mobile-body {
  padding: 0 !important;
}

/* Screen-reader-only utility — matches Tailwind's sr-only for status dots */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
`;
