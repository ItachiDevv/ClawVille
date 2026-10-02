'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { FLOOR_ARENA_TEMPLATES, type FloorArenaTemplate } from '@clawville/shared';

import { ApiError } from '@/lib/api';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useIsGuest } from '@/hooks/use-is-guest';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useFloorArenaMe } from '@/hooks/use-floor-arena';
import { useFloorArenaHouseBoard, type FloorArenaHouseBoardView } from '@/hooks/use-floor-arena-house-board';
import {
  ArenaPill,
  arenaButtonStyle,
  arenaCardStyle,
  arenaPrimaryButtonStyle,
} from '@/components/game/trading-floor/arena/arena-kit';
import { contestPhase, countLabel, exitTargets, pnlTone, signedUsd } from '@/components/game/trading-floor/arena/arena-format';
import { FLOOR_TEXT } from '@/components/game/trading-floor/tokens';
import { useFloorArenaUi } from '@/stores/floor-arena-ui';
import { useGameStore } from '@/stores/game';
import {
  chooseHouseAgentTemplate,
  clearPendingHouseAgentTemplate,
  dismissHouseAgentWalkup,
  houseAgentWalkupAnchor,
  readPendingHouseAgentTemplate,
  setHouseAgentWalkupViewer,
  useHouseAgentWalkup,
  useHouseAgentWalkupPanel,
  type HouseAgentWalkupViewer,
} from '@/stores/house-agent-walkup';
import {
  HOUSE_AGENT_WALKUP_LAYOUT,
  createHouseAgentWalkupPlacement,
  houseAgentWalkupMoved,
  placeHouseAgentWalkup,
  type HouseAgentWalkupPlacementInput,
} from './house-agent-walkup-placement';

/**
 * P15 walk-up pop-up (ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §3).
 *
 * The player walks up to a house agent in the Trading Floor; this DOM panel
 * beside it shows the agent's name, profile and strategy, and "Choose this
 * trading style" opens the EXISTING launch flow with that template preselected
 * (stores/house-agent-walkup.ts). A normal element in the page tree, not a
 * world label, because a world label cannot clamp to the viewport.
 *
 * - Detection is T4's: it writes the store on a transition and the anchor every
 *   frame. This file writes NO React state per frame: the placement loop below
 *   runs only while the panel is open and writes `transform` on a move of
 *   0.5 px or more.
 * - Keyboard E and the touch USE button reach the same primary action through
 *   the room's ONE interact ladder (`activateHouseAgentWalkup`, lowest rung).
 * - Hidden while the Exchange panel is open, and after the close button until
 *   the player leaves the radius and comes back.
 *
 * PARITY: the panel is a view on the same launch route an agent uses
 * (clawville_arena_templates + clawville_arena_launch -> POST /me/launch).
 */
export default function HouseAgentWalkup() {
  const index = useHouseAgentWalkup((state) => state.index);
  const eAvailable = useHouseAgentWalkup((state) => state.eAvailable);
  const dismissedIndex = useHouseAgentWalkupPanel((state) => state.dismissedIndex);
  const pendingTemplateId = useHouseAgentWalkupPanel((state) => state.pendingTemplateId);
  const exchangeOpen = useGameStore((state) => state.exchangeOpen);
  const myAgent = useFloorArenaUi((state) => state.myAgent);
  const touch = useIsMobile();
  const template = index >= 0 ? (FLOOR_ARENA_TEMPLATES[index] ?? null) : null;
  const visible = template !== null && dismissedIndex !== index && !exchangeOpen;

  // Who is looking. The same gates as the arena section: GET /me waits for a
  // resolved, non-guest auth-me (it can only answer a guest with 401), and it
  // runs only while the panel shows or a choice waits for after sign-up.
  const authResolved = useAuthMe().data !== undefined;
  const isGuest = useIsGuest();
  const me = useFloorArenaMe(authResolved && !isGuest && (visible || pendingTemplateId !== null));
  const refused = me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403);
  const cannotOwn = isGuest || refused;
  const canOwn = authResolved && !cannotOwn && me.data !== undefined;
  const viewer: HouseAgentWalkupViewer = cannotOwn ? 'cannot-own' : canOwn ? 'can-own' : 'unknown';
  const meData = me.data;

  useEffect(() => {
    setHouseAgentWalkupViewer(viewer);
  }, [viewer]);

  // A guest's choice survives sign-up in sessionStorage (resetIdentity clears
  // launchTemplateId). Load it once per page visit.
  useEffect(() => {
    readPendingHouseAgentTemplate();
  }, []);

  // Reopen the launch ONCE with the kept template when this viewer can own a
  // trader and has none. The key goes first, so no later answer reopens it.
  useEffect(() => {
    if (pendingTemplateId === null || !canOwn || !meData) return;
    const templateId = readPendingHouseAgentTemplate();
    clearPendingHouseAgentTemplate();
    if (templateId === null || meData.agent) return;
    useFloorArenaUi.getState().openArena('launch', { templateId });
  }, [canOwn, meData, pendingTemplateId]);

  if (!visible || template === null) return null;
  return (
    <HouseAgentWalkupPanel
      key={index}
      template={template}
      hasTrader={myAgent === 'present'}
      showEHint={!touch && eAvailable}
      touch={touch}
    />
  );
}

const textStyle: CSSProperties = { margin: 0, color: FLOOR_TEXT.primary, fontSize: 13, lineHeight: 1.4 };
const mutedStyle: CSSProperties = { margin: 0, color: FLOOR_TEXT.muted, fontSize: 12, lineHeight: 1.4 };
const headingStyle: CSSProperties = {
  margin: 0,
  color: FLOOR_TEXT.faint,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
};

const STATUS_LOOK = {
  active: { label: 'Active', colour: FLOOR_TEXT.positive },
  paused: { label: 'Paused', colour: FLOOR_TEXT.warning },
  stopped: { label: 'Stopped', colour: FLOOR_TEXT.muted },
} as const;

function LiveLine({ board, templateId }: { board: { data?: FloorArenaHouseBoardView; isError: boolean }; templateId: string }) {
  const agent = board.data?.agents.find((row) => row.templateId === templateId) ?? null;
  if (!board.data || !agent) {
    return (
      <p style={mutedStyle} data-testid="house-agent-walkup-live">
        {board.isError ? 'Live figures are not available now.' : 'Loading live figures.'}
      </p>
    );
  }
  // The big screen's window: the contest while it runs, else the last 24 hours.
  const { startsAt, endsAt } = board.data.contest;
  const contestLive = startsAt !== null && endsAt !== null && contestPhase(startsAt, endsAt, Date.now()) === 'live';
  const stats = contestLive ? agent.stats.contest : agent.stats.last24h;
  return (
    <p style={mutedStyle} data-testid="house-agent-walkup-live">
      {contestLive ? 'Contest' : 'Last 24 h'}:{' '}
      <span style={{ color: pnlTone(stats.realisedUsd), fontWeight: 700 }}>{signedUsd(stats.realisedUsd)}</span> realised
      P&amp;L · {countLabel(stats.wins, 'win')} · {countLabel(stats.losses, 'loss', 'losses')} ·{' '}
      {countLabel(agent.open.length, 'open trade')}
    </p>
  );
}

function HouseAgentWalkupPanel({
  template,
  hasTrader,
  showEHint,
  touch,
}: {
  template: FloorArenaTemplate;
  hasTrader: boolean;
  showEHint: boolean;
  touch: boolean;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < HOUSE_AGENT_WALKUP_LAYOUT.phoneMaxWidth,
  );
  const compactRef = useRef(compact);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const board = useFloorArenaHouseBoard(true);
  const agent = board.data?.agents.find((row) => row.templateId === template.id) ?? null;
  const name = agent?.name ?? template.displayName;
  const status = agent?.status ? STATUS_LOOK[agent.status] : null;
  const changedRules = agent?.paramsVersion !== null && agent?.paramsVersion !== undefined && agent.paramsVersion > 1;

  // Placement loop: only while this panel is mounted (= open). One reused
  // input and output record, no React state per frame; `transform` is written
  // only on a move of 0.5 px or more, width / max height only on a change.
  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element || typeof window === 'undefined') return;
    const input: HouseAgentWalkupPlacementInput = {
      viewportWidth: 0,
      viewportHeight: 0,
      anchorX: 0,
      anchorY: 0,
      anchorOnScreen: false,
      panelHeight: 0,
      touch,
      safeAreaBottom: 0,
    };
    const out = createHouseAgentWalkupPlacement();
    let lastLeft = Number.NaN;
    let lastTop = Number.NaN;
    let lastWidth = Number.NaN;
    let lastMaxHeight = Number.NaN;
    let safeArea = 0;
    let safeAreaForWidth = -1;
    let safeAreaForHeight = -1;
    let frame = 0;

    const step = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      // env(safe-area-inset-bottom) has no JS API: read the probe, but only when the viewport changes.
      if (touch && (width !== safeAreaForWidth || height !== safeAreaForHeight)) {
        safeArea = probeRef.current?.getBoundingClientRect().height ?? 0;
        safeAreaForWidth = width;
        safeAreaForHeight = height;
      }
      input.viewportWidth = width;
      input.viewportHeight = height;
      input.anchorX = houseAgentWalkupAnchor.x;
      input.anchorY = houseAgentWalkupAnchor.y;
      input.anchorOnScreen = houseAgentWalkupAnchor.onScreen;
      input.panelHeight = element.offsetHeight;
      input.safeAreaBottom = safeArea;
      placeHouseAgentWalkup(input, out);

      const nextWidth = Math.round(out.width);
      if (nextWidth !== lastWidth) {
        element.style.width = `${nextWidth}px`;
        lastWidth = nextWidth;
      }
      const nextMaxHeight = Math.floor(out.maxHeight);
      if (nextMaxHeight !== lastMaxHeight) {
        element.style.maxHeight = `${nextMaxHeight}px`;
        lastMaxHeight = nextMaxHeight;
      }
      if (houseAgentWalkupMoved(lastLeft, lastTop, out.left, out.top)) {
        element.style.transform = `translate3d(${Math.round(out.left)}px, ${Math.round(out.top)}px, 0px)`;
        lastLeft = out.left;
        lastTop = out.top;
      }
      const nextCompact = out.mode === 'compact';
      if (nextCompact !== compactRef.current) {
        compactRef.current = nextCompact;
        setCompact(nextCompact);
      }
    };
    const houseAgentWalkupFrame = () => {
      step();
      frame = window.requestAnimationFrame(houseAgentWalkupFrame);
    };

    // Twice before the first paint: the first pass sets the width, the second
    // measures the height that width gives.
    step();
    step();
    frame = window.requestAnimationFrame(houseAgentWalkupFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [touch]);

  const showDetails = !compact || detailsOpen;
  const exitRule = exitTargets(template.params.exits).join(' · ');
  const choose = () => {
    if (hasTrader) useFloorArenaUi.getState().openArena('desk');
    else chooseHouseAgentTemplate(template.id);
  };

  return (
    <>
      {touch ? (
        <div
          ref={probeRef}
          aria-hidden
          style={{
            position: 'fixed',
            left: 0,
            bottom: 0,
            width: 0,
            height: 'env(safe-area-inset-bottom, 0px)',
            visibility: 'hidden',
            pointerEvents: 'none',
          }}
        />
      ) : null}
      <section
        ref={panelRef}
        data-testid="house-agent-walkup"
        aria-label={`House agent ${name}`}
        style={{
          ...arenaCardStyle,
          position: 'fixed',
          left: 0,
          top: 0,
          zIndex: 45,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: 12,
          // Last resort on a very short screen: header and buttons scroll too.
          overflowY: 'auto',
          background: 'rgba(2,8,23,0.92)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
          pointerEvents: 'auto',
          willChange: 'transform',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, flex: 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={headingStyle}>House agent</span>
            <h2 style={{ margin: 0, color: FLOOR_TEXT.value, fontSize: 17, lineHeight: 1.2 }}>{name}</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              {agent?.mode === 'live' ? (
                <ArenaPill colour={FLOOR_TEXT.positive} testId="house-agent-walkup-mode">LIVE</ArenaPill>
              ) : agent?.mode === 'paper' ? (
                <ArenaPill colour={FLOOR_TEXT.warning} testId="house-agent-walkup-mode">PAPER</ArenaPill>
              ) : null}
              {status ? (
                <span style={{ color: status.colour, fontSize: 12, fontWeight: 700 }} data-testid="house-agent-walkup-status">
                  {status.label}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            data-testid="house-agent-walkup-close"
            onClick={dismissHouseAgentWalkup}
            style={{
              ...arenaButtonStyle,
              flex: 'none',
              width: 44,
              height: 44,
              minWidth: 44,
              minHeight: 44,
              padding: 0,
              fontSize: 20,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h3 style={headingStyle}>Profile</h3>
            <p style={textStyle}>{template.tagline}</p>
            <LiveLine board={board} templateId={template.id} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h3 style={headingStyle}>Trading strategy</h3>
            {showDetails ? (
              <>
                <p style={textStyle}>{template.thesis}</p>
                <p style={mutedStyle}>Risk: {template.risk}</p>
              </>
            ) : null}
            {compact ? (
              <button
                type="button"
                data-testid="house-agent-walkup-details"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((open) => !open)}
                style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}
              >
                {detailsOpen ? 'Hide details' : 'Details'}
              </button>
            ) : null}
            <p style={mutedStyle}>You start with this exit rule: {exitRule}</p>
            {changedRules ? (
              <p style={{ ...mutedStyle, color: FLOOR_TEXT.warning }} data-testid="house-agent-walkup-note">
                This house agent changed its rules since launch. You start from the template rules.
              </p>
            ) : null}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' }}>
          {hasTrader ? <p style={mutedStyle}>One trader per account.</p> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <button type="button" data-testid="house-agent-walkup-primary" onClick={choose} style={arenaPrimaryButtonStyle}>
              {hasTrader ? 'Open my trader' : 'Choose this trading style'}
            </button>
            {showEHint ? (
              <span style={{ color: FLOOR_TEXT.muted, fontSize: 12 }} data-testid="house-agent-walkup-hint">
                or press E
              </span>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="house-agent-walkup-watch"
            onClick={() => useFloorArenaUi.getState().openArena('profile', { agentId: template.houseAgentId })}
            style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}
          >
            Watch its trades
          </button>
        </div>
      </section>
    </>
  );
}
