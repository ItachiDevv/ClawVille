'use client';

/**
 * Select Agent — WoW-style character select screen.
 *
 * Full visual re-skin built on the shared RPG primitives from
 * `@/components/rpg`. Data flow is identical to the previous
 * implementation: every useQuery / useMutation / router push is preserved,
 * only the presentation layer changed.
 *
 * Layout
 * ------
 *   ┌────────── Roster ──────────┐┌──────── 3D Preview ────────┐┌──────── Details ────────┐
 *   │  6 rune-framed slots       ││  SelectAgentCanvas +       ││  Stats · Talent Tree ·   │
 *   │  (filled or empty)          ││  dramatic spotlight         ││  Loadout · Enter World  │
 *   └────────────────────────────┘└────────────────────────────┘└──────────────────────────┘
 *
 * Backend truth
 * -------------
 * Knowledge books don't carry a rarity field in `packages/shared`, so rarity
 * is derived client-side via `deriveRarityFromKnowledgeCount(book.knowledgeEntries.length)`.
 * When the agent-setup API grows a per-book rarity column we'll swap the
 * derivation for the backend value.
 *
 * NOTE: `components/three/SelectAgentCanvas.tsx` has a pre-existing React 19
 * ReactNode vs ReactPortal typecheck error at line 105 that Team 4 / 3da owns.
 * Do NOT patch that file from here.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { CSSProperties, DragEvent, ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  PET_SPECIES,
  PET_COLORS,
  PET_ARCHETYPES,
  MAP_LOCATIONS,
  KNOWLEDGE_BOOKS,
} from '@clawville/shared';
import {
  RuneFrame,
  RpgButton,
  RuneSpinner,
  RarityBadge,
  RpgTooltip,
  getRarity,
  deriveRarityFromKnowledgeCount,
  type RarityId,
} from '@/components/rpg';

const SelectAgentCanvas = dynamic(
  () => import('@/components/three/SelectAgentCanvas'),
  { ssr: false }
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Agent {
  id: string;
  name: string;
  species: string;
  color: string;
  gender: string;
  archetype: string;
  level: number;
  xp: number;
  clawTokens: number;
  isActive: boolean;
  equippedSkills: string[];
  learnedBooks: string[];
  characterConfig?: any;
}

type Panel = 'details' | 'create' | 'import' | 'connect-external';

// ---------------------------------------------------------------------------
// Constants & lookups
// ---------------------------------------------------------------------------

const MAX_AGENTS = 1;
const MAX_LOADOUT_SLOTS = 6;

const COLOR_HEX: Record<string, string> = Object.fromEntries(
  PET_COLORS.map((c) => [c.id, c.hex])
);

const SPECIES_NAME: Record<string, string> = Object.fromEntries(
  PET_SPECIES.map((s) => [s.id, s.name])
);

const SPECIES_EMOJI: Record<string, string> = Object.fromEntries(
  PET_SPECIES.map((s) => [s.id, s.emoji])
);

const ARCHETYPE_LABEL: Record<string, string> = Object.fromEntries(
  PET_ARCHETYPES.map((a) => [a.id, a.label])
);

// Group books by building for the talent tree
const BOOKS_BY_BUILDING: Record<string, typeof KNOWLEDGE_BOOKS> = {};
for (const book of KNOWLEDGE_BOOKS) {
  if (!BOOKS_BY_BUILDING[book.building]) BOOKS_BY_BUILDING[book.building] = [];
  BOOKS_BY_BUILDING[book.building]!.push(book);
}

// Derive per-book rarity once — backend doesn't ship a rarity column for
// knowledge books today, so we fall back to the shared derivation helper.
const BOOK_RARITY: Record<string, RarityId> = Object.fromEntries(
  KNOWLEDGE_BOOKS.map((b) => [
    b.id,
    deriveRarityFromKnowledgeCount(b.knowledgeEntries.length),
  ])
);

const BOOK_BY_ID: Record<string, (typeof KNOWLEDGE_BOOKS)[number]> =
  Object.fromEntries(KNOWLEDGE_BOOKS.map((b) => [b.id, b]));

// ---------------------------------------------------------------------------
// Background — dramatic character-select hall
// ---------------------------------------------------------------------------

function StageBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {/* Deep navy base + subtle vignette */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 35%, #0f2140 0%, #08132a 45%, #020713 100%)',
        }}
      />
      {/* Soft spotlight beams — pure CSS, no framer */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'conic-gradient(from 260deg at 50% 0%, transparent 0deg, rgba(56,189,248,0.10) 18deg, transparent 36deg, transparent 324deg, rgba(250,204,21,0.08) 342deg, transparent 360deg)',
          filter: 'blur(42px)',
          mixBlendMode: 'screen',
        }}
      />
      {/* Rising cyan spotlight behind the 3D stage */}
      <div
        className="absolute left-1/2 top-[8%] h-[620px] w-[620px] -translate-x-1/2 rounded-full"
        style={{
          background:
            'radial-gradient(circle, rgba(56,189,248,0.18) 0%, rgba(56,189,248,0.06) 40%, transparent 70%)',
          filter: 'blur(40px)',
        }}
      />
      {/* Warm rim near the bottom (the "gold dais" spill) */}
      <div
        className="absolute left-1/2 bottom-[-10%] h-[520px] w-[720px] -translate-x-1/2 rounded-full"
        style={{
          background:
            'radial-gradient(ellipse, rgba(249,115,22,0.18) 0%, rgba(249,115,22,0.05) 45%, transparent 75%)',
          filter: 'blur(70px)',
        }}
      />
      {/* Starfield — CSS radial-gradient trick, cheap on Intel Iris Xe */}
      <div
        className="absolute inset-0 opacity-[0.45]"
        style={{
          backgroundImage: [
            'radial-gradient(circle at 12% 18%, rgba(255,255,255,0.8) 0, transparent 1.2px)',
            'radial-gradient(circle at 72% 12%, rgba(255,255,255,0.55) 0, transparent 1px)',
            'radial-gradient(circle at 23% 78%, rgba(255,255,255,0.5) 0, transparent 1.1px)',
            'radial-gradient(circle at 91% 62%, rgba(255,255,255,0.7) 0, transparent 1px)',
            'radial-gradient(circle at 44% 42%, rgba(255,255,255,0.4) 0, transparent 0.9px)',
            'radial-gradient(circle at 60% 82%, rgba(255,255,255,0.6) 0, transparent 1px)',
            'radial-gradient(circle at 7% 52%, rgba(255,255,255,0.45) 0, transparent 1px)',
            'radial-gradient(circle at 85% 30%, rgba(255,255,255,0.55) 0, transparent 1px)',
          ].join(','),
          backgroundSize: '320px 320px',
        }}
      />
      {/* Top + bottom horizon bars (gives "indoor hall" depth) */}
      <div
        className="absolute inset-x-0 top-0 h-24"
        style={{
          background:
            'linear-gradient(180deg, rgba(3,8,18,0.95) 0%, rgba(3,8,18,0) 100%)',
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-36"
        style={{
          background:
            'linear-gradient(0deg, rgba(3,8,18,0.92) 0%, rgba(3,8,18,0) 100%)',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster slot — rune-framed, rarity keyed to state
// ---------------------------------------------------------------------------

function RosterSlot({
  agent,
  selected,
  onSelect,
}: {
  agent: Agent | null;
  selected: boolean;
  onSelect: () => void;
}) {
  // Empty slot — common tier, dashed feel via opacity
  if (!agent) {
    return (
      <RuneFrame
        tier="common"
        interactive
        onClick={onSelect}
        glow={false}
        style={{ cursor: 'pointer', opacity: 0.55 }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 14px',
            minHeight: 62,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px dashed rgba(148,163,184,0.45)',
              color: 'rgba(148,163,184,0.7)',
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 20,
            }}
          >
            +
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontSize: 11,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: '#cbd5e1',
              }}
            >
              Empty Slot
            </div>
            <div
              style={{
                fontSize: 10,
                color: '#64748b',
                marginTop: 2,
              }}
            >
              Forge a new agent
            </div>
          </div>
        </div>
      </RuneFrame>
    );
  }

  // Filled slot — rarity escalates with state
  //   active         → legendary + strong glow (the gold pulse)
  //   selected only  → epic + subtle glow
  //   default        → rare cyan baseline
  const tier: RarityId = agent.isActive
    ? 'legendary'
    : selected
      ? 'epic'
      : 'rare';

  const colorHex = COLOR_HEX[agent.color] ?? '#38bdf8';
  const speciesEmoji = SPECIES_EMOJI[agent.species] ?? '🦞';

  return (
    <RuneFrame
      tier={tier}
      interactive
      onClick={onSelect}
      glow={agent.isActive ? 'strong' : selected ? 'subtle' : false}
      style={{ cursor: 'pointer' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
          minHeight: 62,
        }}
      >
        {/* Portrait */}
        <div
          style={{
            position: 'relative',
            width: 44,
            height: 44,
            flexShrink: 0,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            background: `radial-gradient(circle at 30% 30%, ${colorHex}33 0%, rgba(10,22,40,0.9) 75%)`,
            border: `1px solid ${colorHex}80`,
            boxShadow: `inset 0 0 12px ${colorHex}33`,
          }}
        >
          <span style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.6))' }}>
            {speciesEmoji}
          </span>
          {agent.isActive && (
            <span
              style={{
                position: 'absolute',
                top: -3,
                right: -3,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#fb923c',
                border: '2px solid #0a1628',
                boxShadow: '0 0 8px #fb923c',
              }}
              aria-label="Active agent"
            />
          )}
        </div>
        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 13,
              fontWeight: 700,
              color: '#f1f5f9',
              textShadow: `0 0 10px ${getRarity(tier).glow}44`,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {agent.name}
          </div>
          <div
            style={{
              fontSize: 10,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: '#64748b',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              marginTop: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Lv {agent.level} · {SPECIES_NAME[agent.species] ?? agent.species}
          </div>
        </div>
        {/* XP chip */}
        <div
          style={{
            fontSize: 9,
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontWeight: 700,
            letterSpacing: '0.1em',
            padding: '3px 7px',
            borderRadius: 999,
            background: 'rgba(56,189,248,0.12)',
            border: '1px solid rgba(56,189,248,0.3)',
            color: '#7dd3fc',
            flexShrink: 0,
          }}
        >
          {agent.xp} XP
        </div>
      </div>
    </RuneFrame>
  );
}

// ---------------------------------------------------------------------------
// Stat card — tiny rune-framed readout
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  tier = 'common',
  icon,
}: {
  label: string;
  value: ReactNode;
  tier?: RarityId;
  icon?: ReactNode;
}) {
  return (
    <RuneFrame tier={tier} glow={false}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '10px 12px',
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: '#64748b',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {icon && <span style={{ fontSize: 11 }}>{icon}</span>}
          {label}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 14,
            fontWeight: 700,
            color: getRarity(tier).base,
            textShadow: `0 0 10px ${getRarity(tier).glow}55`,
            lineHeight: 1.15,
          }}
        >
          {value}
        </div>
      </div>
    </RuneFrame>
  );
}

// ---------------------------------------------------------------------------
// Talent tree row — one building, two book cells
// ---------------------------------------------------------------------------

function TalentBookCell({
  book,
  learned,
}: {
  book: (typeof KNOWLEDGE_BOOKS)[number];
  learned: boolean;
}) {
  const rarityId = BOOK_RARITY[book.id] ?? 'common';
  const rarity = getRarity(rarityId);

  return (
    <RpgTooltip
      content={
        <div>
          <div
            style={{
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontWeight: 700,
              color: rarity.base,
              marginBottom: 4,
            }}
          >
            {book.name}
          </div>
          <div style={{ color: '#cbd5e1', marginBottom: 6 }}>
            {book.description}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              fontSize: 10,
            }}
          >
            <RarityBadge tier={rarityId} />
            {!learned && (
              <span style={{ color: '#facc15', fontWeight: 700 }}>
                {book.price} NT
              </span>
            )}
            {learned && (
              <span
                style={{
                  color: '#4ade80',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                }}
              >
                LEARNED
              </span>
            )}
          </div>
        </div>
      }
      side="top"
    >
      <span style={{ display: 'inline-flex', flex: 1, minWidth: 0 }}>
        <RuneFrame
          tier={rarityId}
          interactive
          glow={learned && rarity.pulse ? 'strong' : learned ? 'subtle' : false}
          style={{
            flex: 1,
            cursor: 'help',
            opacity: learned ? 1 : 0.42,
            filter: learned ? 'none' : 'grayscale(0.7)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 9px',
              minHeight: 38,
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>
              {book.icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  fontFamily:
                    'var(--font-orbitron, ui-sans-serif), sans-serif',
                  fontWeight: 700,
                  color: learned ? rarity.base : '#64748b',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  letterSpacing: '0.02em',
                }}
              >
                {book.name}
              </div>
              <div
                style={{
                  fontSize: 9,
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: learned ? '#94a3b8' : '#475569',
                  marginTop: 1,
                }}
              >
                {learned ? 'Learned' : `${book.price} NT`}
              </div>
            </div>
          </div>
        </RuneFrame>
      </span>
    </RpgTooltip>
  );
}

function TalentRow({
  buildingName,
  buildingIcon,
  books,
  learnedBooks,
}: {
  buildingName: string;
  buildingIcon: string;
  books: typeof KNOWLEDGE_BOOKS;
  learnedBooks: string[];
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
      {/* Building label column */}
      <div
        style={{
          flexShrink: 0,
          width: 96,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingRight: 4,
          borderRight: '1px solid rgba(56,189,248,0.14)',
        }}
      >
        <span style={{ fontSize: 16 }}>{buildingIcon}</span>
        <span
          style={{
            fontSize: 10,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: '#94a3b8',
            lineHeight: 1.2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {buildingName}
        </span>
      </div>
      {/* Two book cells */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          gap: 6,
          minWidth: 0,
        }}
      >
        {books.map((book) => (
          <TalentBookCell
            key={book.id}
            book={book}
            learned={learnedBooks.includes(book.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loadout bar — 6 draggable skill slots
// ---------------------------------------------------------------------------

function LoadoutBar({
  equippedSkills,
  onSlotDrop,
  onSlotClear,
  onDragStartEquipped,
}: {
  equippedSkills: string[];
  onSlotDrop: (bookId: string, slotIndex: number) => void;
  onSlotClear: (bookId: string) => void;
  onDragStartEquipped: (bookId: string) => void;
}) {
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const slots = Array.from(
    { length: MAX_LOADOUT_SLOTS },
    (_, i) => equippedSkills[i] ?? null
  );

  const handleDragOver = (e: DragEvent<HTMLDivElement>, slot: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setHoverSlot(slot);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, slot: number) => {
    e.preventDefault();
    const bookId = e.dataTransfer.getData('text/clawville-book');
    setHoverSlot(null);
    if (bookId) onSlotDrop(bookId, slot);
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(6, 1fr)',
        gap: 6,
      }}
    >
      {slots.map((bookId, i) => {
        const book = bookId ? BOOK_BY_ID[bookId] : null;
        const rarityId: RarityId = book
          ? (BOOK_RARITY[book.id] ?? 'common')
          : 'common';
        const filled = !!book;
        const hovering = hoverSlot === i;

        return (
          <div
            key={i}
            onDragOver={(e) => handleDragOver(e, i)}
            onDragLeave={() => setHoverSlot((s) => (s === i ? null : s))}
            onDrop={(e) => handleDrop(e, i)}
            draggable={filled}
            onDragStart={(e) => {
              if (!book) return;
              e.dataTransfer.setData('text/clawville-book', book.id);
              e.dataTransfer.effectAllowed = 'move';
              onDragStartEquipped(book.id);
            }}
            onClick={() => {
              if (book) onSlotClear(book.id);
            }}
            title={
              book
                ? `${book.name} (click to unequip, drag to reorder)`
                : 'Drop a skill here'
            }
            style={{ cursor: filled ? 'grab' : 'default' }}
          >
            <RuneFrame
              tier={filled ? rarityId : 'common'}
              glow={filled && getRarity(rarityId).pulse ? 'subtle' : false}
              interactive={filled}
              style={{
                aspectRatio: '1 / 1',
                opacity: filled ? 1 : 0.55,
                transform: hovering ? 'scale(1.04)' : undefined,
                transition: 'transform 140ms ease',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  gap: 2,
                  padding: 4,
                  textAlign: 'center',
                }}
              >
                {book ? (
                  <>
                    <span style={{ fontSize: 20 }}>{book.icon}</span>
                    <span
                      style={{
                        fontSize: 8,
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, monospace',
                        color: getRarity(rarityId).base,
                        lineHeight: 1.15,
                        maxWidth: '100%',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {book.name}
                    </span>
                  </>
                ) : (
                  <span
                    style={{
                      fontFamily:
                        'var(--font-orbitron, ui-sans-serif), sans-serif',
                      fontSize: 18,
                      color: 'rgba(148,163,184,0.35)',
                    }}
                  >
                    {i + 1}
                  </span>
                )}
              </div>
            </RuneFrame>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Available skills tray — learned-but-not-equipped, draggable source
// ---------------------------------------------------------------------------

function AvailableSkillsTray({
  learnedBooks,
  equippedSkills,
  onEquip,
}: {
  learnedBooks: string[];
  equippedSkills: string[];
  onEquip: (bookId: string) => void;
}) {
  const unequipped = learnedBooks.filter((id) => !equippedSkills.includes(id));

  if (unequipped.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontSize: 9,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: '#64748b',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        Drag to equip · Click to auto-slot
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {unequipped.map((bookId) => {
          const book = BOOK_BY_ID[bookId];
          if (!book) return null;
          const rarityId: RarityId = BOOK_RARITY[book.id] ?? 'common';
          return (
            <button
              key={bookId}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/clawville-book', book.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onEquip(bookId)}
              disabled={equippedSkills.length >= MAX_LOADOUT_SLOTS}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 8px',
                borderRadius: 6,
                background: `color-mix(in srgb, ${getRarity(rarityId).base} 12%, rgba(10,22,40,0.7))`,
                border: `1px solid ${getRarity(rarityId).base}55`,
                color: getRarity(rarityId).base,
                fontSize: 10,
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontWeight: 700,
                letterSpacing: '0.02em',
                cursor: 'grab',
                maxWidth: 160,
                opacity:
                  equippedSkills.length >= MAX_LOADOUT_SLOTS ? 0.4 : 1,
              }}
            >
              <span>{book.icon}</span>
              <span
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 120,
                }}
              >
                {book.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Import panels (inline)
// ---------------------------------------------------------------------------

function AgentCreationForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [species, setSpecies] = useState(PET_SPECIES[0]!.id);
  const [color, setColor] = useState(PET_COLORS[0]!.id);
  const [gender, setGender] = useState('male');
  const [archetype, setArchetype] = useState(PET_ARCHETYPES[0]!.id);
  const [error, setError] = useState('');

  const createMut = useMutation({
    mutationFn: () =>
      api.createAgent({
        name,
        species,
        color,
        gender,
        archetypeId: archetype,
        personality: {
          habitat: 'sea',
          hobby: 'exploring',
          greeting: 'wave-hello',
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-roster'] });
      onCreated();
    },
    onError: (err: Error) => setError(err.message),
  });

  const inputStyle: CSSProperties = {
    width: '100%',
    padding: '9px 11px',
    borderRadius: 6,
    background: 'rgba(10,22,40,0.7)',
    border: '1px solid rgba(56,189,248,0.25)',
    color: '#e2e8f0',
    fontSize: 12,
    outline: 'none',
  };
  const labelStyle: CSSProperties = {
    display: 'block',
    fontSize: 9,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: '#64748b',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    marginBottom: 5,
  };

  return (
    <RuneFrame tier="epic" glow="subtle">
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '16px 18px',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 15,
              fontWeight: 700,
              color: '#c084fc',
              textShadow: '0 0 12px rgba(192,132,252,0.4)',
              letterSpacing: '0.04em',
            }}
          >
            Forge New Agent
          </div>
          <div
            style={{
              fontSize: 9,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: '#94a3b8',
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              marginTop: 3,
            }}
          >
            Character Creation · Choose Your Path
          </div>
        </div>

        <div>
          <label style={labelStyle}>True Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={20}
            placeholder="Name your agent…"
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelStyle}>Species</label>
          <select
            value={species}
            onChange={(e) => setSpecies(e.target.value as typeof species)}
            style={inputStyle}
          >
            {PET_SPECIES.map((s) => (
              <option key={s.id} value={s.id} style={{ background: '#0a1628' }}>
                {s.emoji} {s.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={labelStyle}>Shell Color</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {PET_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setColor(c.id)}
                title={c.name}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  backgroundColor: c.hex,
                  border:
                    color === c.id
                      ? `2px solid #f1f5f9`
                      : '2px solid transparent',
                  boxShadow:
                    color === c.id
                      ? `0 0 10px ${c.hex}, 0 0 0 1px rgba(255,255,255,0.3)`
                      : 'none',
                  cursor: 'pointer',
                  transform: color === c.id ? 'scale(1.08)' : 'scale(1)',
                  transition: 'transform 140ms ease, box-shadow 220ms ease',
                }}
              />
            ))}
          </div>
        </div>

        <div>
          <label style={labelStyle}>Gender</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['male', 'female'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGender(g)}
                style={{
                  flex: 1,
                  padding: '6px 12px',
                  borderRadius: 6,
                  background:
                    gender === g
                      ? 'rgba(168,85,247,0.18)'
                      : 'rgba(10,22,40,0.6)',
                  border:
                    gender === g
                      ? '1px solid rgba(168,85,247,0.5)'
                      : '1px solid rgba(148,163,184,0.2)',
                  color: gender === g ? '#c084fc' : '#94a3b8',
                  fontSize: 10,
                  fontFamily:
                    'var(--font-orbitron, ui-sans-serif), sans-serif',
                  fontWeight: 700,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  transition: 'all 160ms ease',
                }}
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={labelStyle}>Archetype</label>
          <select
            value={archetype}
            onChange={(e) =>
              setArchetype(e.target.value as typeof archetype)
            }
            style={inputStyle}
          >
            {PET_ARCHETYPES.map((a) => (
              <option key={a.id} value={a.id} style={{ background: '#0a1628' }}>
                {a.label} — {a.description}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              background: 'rgba(220,38,38,0.12)',
              border: '1px solid rgba(220,38,38,0.35)',
              color: '#fca5a5',
              fontSize: 11,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, paddingTop: 2 }}>
          <RpgButton
            variant="primary"
            size="md"
            style={{ flex: 1 }}
            onClick={() => createMut.mutate()}
            disabled={!name || name.length < 3}
            loading={createMut.isPending}
          >
            Forge Agent
          </RpgButton>
          <RpgButton variant="ghost" size="md" onClick={onCancel}>
            Cancel
          </RpgButton>
        </div>
      </div>
    </RuneFrame>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SelectAgentPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('details');
  const [importError, setImportError] = useState('');

  // -------------- Queries --------------
  const { data: rosterData, isLoading: rosterLoading } = useQuery({
    queryKey: ['agent-roster'],
    queryFn: () => api.getAgentRoster(),
  });

  const agents: Agent[] = useMemo(
    () => (rosterData?.agents as Agent[]) ?? [],
    [rosterData]
  );
  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;
  const activeAgent = agents.find((a) => a.isActive) ?? null;

  useEffect(() => {
    if (agents.length > 0 && !selectedId) {
      const active = agents.find((a) => a.isActive);
      setSelectedId(active?.id ?? agents[0]!.id);
    }
  }, [agents, selectedId]);

  // Talent tree query (intentionally preserved — future server-side talent data)
  useQuery({
    queryKey: ['agent-talent-tree', selectedId],
    queryFn: () => api.getAgentTalentTree(selectedId!),
    enabled: !!selectedId,
  });

  // -------------- Mutations --------------
  const activateMut = useMutation({
    mutationFn: (id: string) => api.activateAgent(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['agent-roster'] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-roster'] });
      setSelectedId(null);
    },
  });

  const loadoutMut = useMutation({
    mutationFn: ({ id, skills }: { id: string; skills: string[] }) =>
      api.updateLoadout(id, skills),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['agent-roster'] }),
  });

  const exportMut = useMutation({
    mutationFn: (id: string) => api.exportAgent(id),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data.config, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agent-${selectedAgent?.name ?? 'export'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  const importMut = useMutation({
    mutationFn: (configData: any) => api.importAgent(configData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-roster'] });
      setPanel('details');
      setImportError('');
    },
    onError: (err: Error) => setImportError(err.message),
  });

  // -------------- Handlers --------------
  const handleToggleLoadout = useCallback(
    (bookId: string) => {
      if (!selectedAgent) return;
      const current = selectedAgent.equippedSkills ?? [];
      const next = current.includes(bookId)
        ? current.filter((id) => id !== bookId)
        : current.length < MAX_LOADOUT_SLOTS
          ? [...current, bookId]
          : current;
      loadoutMut.mutate({ id: selectedAgent.id, skills: next });
    },
    [selectedAgent, loadoutMut]
  );

  const handleSlotDrop = useCallback(
    (bookId: string, slotIndex: number) => {
      if (!selectedAgent) return;
      const current = [...(selectedAgent.equippedSkills ?? [])];
      // Remove the book from wherever it currently sits, then insert at target slot
      const withoutBook = current.filter((id) => id !== bookId);
      // Pad with nulls so slotIndex is reachable, then drop the book in
      const padded: (string | null)[] = [...withoutBook];
      while (padded.length < slotIndex) padded.push(null);
      padded[slotIndex] = bookId;
      const next = padded
        .filter((id): id is string => !!id)
        .slice(0, MAX_LOADOUT_SLOTS);
      loadoutMut.mutate({ id: selectedAgent.id, skills: next });
    },
    [selectedAgent, loadoutMut]
  );

  const handleImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const configData = JSON.parse(reader.result as string);
          importMut.mutate(configData);
        } catch {
          setImportError('Invalid JSON file');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    },
    [importMut]
  );

  const handleEnterWorld = useCallback(() => {
    if (activeAgent) {
      router.push('/game');
    }
  }, [activeAgent, router]);

  // Escape key → close subpanels
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && panel !== 'details') {
        setPanel('details');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [panel]);

  // -------------- Computed --------------
  const learnedBooks = selectedAgent?.learnedBooks ?? [];
  const totalLearned = learnedBooks.length;
  const equippedSkills = selectedAgent?.equippedSkills ?? [];

  const totalBooks = KNOWLEDGE_BOOKS.length;
  const progressPct = totalBooks > 0 ? (totalLearned / totalBooks) * 100 : 0;

  // =========================================================================
  // RENDER — loading
  // =========================================================================

  if (rosterLoading) {
    return (
      <div
        className="fixed inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 30%, #0f2140 0%, #020713 100%)',
        }}
      >
        <StageBackdrop />
        <div
          className="relative h-full w-full flex flex-col items-center justify-center"
          style={{ gap: 24 }}
        >
          <RuneSpinner tier="legendary" size={80} />
          <div
            style={{
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 14,
              letterSpacing: '0.32em',
              textTransform: 'uppercase',
              color: '#fb923c',
              textShadow: '0 0 18px rgba(251,146,60,0.6)',
            }}
          >
            Summoning Roster…
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // RENDER — main
  // =========================================================================

  return (
    <div
      className="fixed inset-0 flex flex-col lg:flex-row overflow-hidden"
      style={{ color: '#e2e8f0' }}
    >
      <StageBackdrop />

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleImportFile}
      />

      {/* ====== LEFT · ROSTER SIDEBAR ====== */}
      <aside
        className="relative shrink-0 overflow-hidden flex flex-col"
        style={{
          width: '100%',
          maxWidth: 320,
          borderRight: '1px solid rgba(56,189,248,0.12)',
          background:
            'linear-gradient(180deg, rgba(5,12,28,0.85) 0%, rgba(2,7,19,0.95) 100%)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 20px 14px',
            borderBottom: '1px solid rgba(56,189,248,0.12)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: '#f1f5f9',
              textShadow: '0 0 14px rgba(56,189,248,0.4)',
            }}
          >
            Agent Roster
          </div>
          <div
            style={{
              fontSize: 9,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              letterSpacing: '0.26em',
              textTransform: 'uppercase',
              color: '#7dd3fc',
              marginTop: 4,
            }}
          >
            {agents.length} / {MAX_AGENTS} Champions
          </div>
        </div>

        {/* Roster slots */}
        <div
          className="flex-1"
          style={{
            overflowY: 'auto',
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(56,189,248,0.35) transparent',
          }}
        >
          {Array.from({ length: MAX_AGENTS }, (_, i) => {
            const agent = agents[i] ?? null;
            return (
              <RosterSlot
                key={agent?.id ?? `empty-${i}`}
                agent={agent}
                selected={agent?.id === selectedId}
                onSelect={() => {
                  if (agent) {
                    setSelectedId(agent.id);
                    setPanel('details');
                  } else if (agents.length < MAX_AGENTS) {
                    setPanel('create');
                  }
                }}
              />
            );
          })}
        </div>

        {/* Footer actions */}
        <div
          style={{
            padding: '12px 16px 18px',
            borderTop: '1px solid rgba(56,189,248,0.12)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {agents.length < MAX_AGENTS && (
            <RpgButton
              variant="ghost"
              size="sm"
              onClick={() => setPanel('create')}
              style={{ width: '100%' }}
            >
              + New Agent
            </RpgButton>
          )}
          <RpgButton
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            style={{ width: '100%' }}
          >
            Import Config
          </RpgButton>
          <RpgButton
            variant="ghost"
            size="sm"
            onClick={() => setPanel('connect-external')}
            style={{ width: '100%' }}
          >
            Connect External Agent
          </RpgButton>
          <RpgButton
            variant="secondary"
            size="sm"
            onClick={() => {
              localStorage.setItem('clawville-spectate-mode', '1');
              router.push('/game?spectate=1');
            }}
            style={{ width: '100%', marginTop: 4 }}
          >
            Explore as Spectator
          </RpgButton>
          {importError && (
            <div
              style={{
                fontSize: 10,
                color: '#fca5a5',
                textAlign: 'center',
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
            >
              {importError}
            </div>
          )}
        </div>
      </aside>

      {/* ====== CENTER · 3D PREVIEW ====== */}
      <main
        className="relative flex-1 flex flex-col items-center justify-between"
        style={{
          minHeight: 0,
          padding: '24px 28px',
        }}
      >
        {/* Title banner */}
        <div
          style={{
            textAlign: 'center',
            position: 'relative',
            zIndex: 2,
          }}
        >
          <div
            style={{
              fontFamily:
                'var(--font-clawville, var(--font-orbitron, ui-sans-serif)), sans-serif',
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: '#f1f5f9',
              textShadow:
                '0 0 24px rgba(56,189,248,0.55), 0 2px 6px rgba(0,0,0,0.8)',
              lineHeight: 1,
            }}
          >
            Choose Your Agent
          </div>
          <div
            style={{
              marginTop: 8,
              display: 'inline-block',
              height: 2,
              width: 180,
              background:
                'linear-gradient(90deg, transparent 0%, #fb923c 50%, transparent 100%)',
              boxShadow: '0 0 12px rgba(251,146,60,0.6)',
            }}
          />
          <div
            style={{
              marginTop: 8,
              fontSize: 10,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              letterSpacing: '0.32em',
              textTransform: 'uppercase',
              color: '#fb923c',
            }}
          >
            ClawVille · Sea-Floor Chronicles
          </div>
        </div>

        {/* Stage vignette + 3D canvas */}
        <div
          style={{
            position: 'relative',
            width: '100%',
            maxWidth: 620,
            aspectRatio: '1 / 1',
            maxHeight: '58vh',
            zIndex: 2,
          }}
        >
          {/* Spotlight halo behind the stage */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: '-12% -6% 0 -6%',
              background:
                'radial-gradient(ellipse at 50% 50%, rgba(56,189,248,0.22) 0%, rgba(56,189,248,0.05) 35%, transparent 70%)',
              filter: 'blur(28px)',
              pointerEvents: 'none',
            }}
          />
          {/* Rune-framed canvas shell */}
          <RuneFrame
            tier={
              selectedAgent?.isActive
                ? 'legendary'
                : selectedAgent
                  ? 'epic'
                  : 'rare'
            }
            glow={selectedAgent?.isActive ? 'strong' : 'subtle'}
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'hidden',
            }}
          >
            {selectedAgent ? (
              <SelectAgentCanvas modelKey="lobster" color={selectedAgent.color} />
            ) : (
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 14,
                  background: 'rgba(3,13,26,0.6)',
                }}
              >
                <div style={{ fontSize: 64, opacity: 0.2 }}>⚓</div>
                <div
                  style={{
                    fontSize: 11,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, monospace',
                    color: '#64748b',
                    letterSpacing: '0.2em',
                    textTransform: 'uppercase',
                  }}
                >
                  No Agent Selected
                </div>
              </div>
            )}

            {/* Name banner overlay inside vignette */}
            {selectedAgent && (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: 18,
                  transform: 'translateX(-50%)',
                  textAlign: 'center',
                  padding: '6px 14px',
                  borderRadius: 8,
                  background: 'rgba(3,13,26,0.78)',
                  border: '1px solid rgba(56,189,248,0.3)',
                  backdropFilter: 'blur(4px)',
                  WebkitBackdropFilter: 'blur(4px)',
                  minWidth: 220,
                  maxWidth: '80%',
                }}
              >
                <div
                  style={{
                    fontFamily:
                      'var(--font-clawville, var(--font-orbitron, ui-sans-serif)), sans-serif',
                    fontSize: 20,
                    fontWeight: 700,
                    color: '#f1f5f9',
                    textShadow: '0 2px 10px rgba(0,0,0,0.9)',
                    letterSpacing: '0.06em',
                  }}
                >
                  {selectedAgent.name}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, monospace',
                    color: '#7dd3fc',
                    letterSpacing: '0.2em',
                    textTransform: 'uppercase',
                    marginTop: 2,
                  }}
                >
                  {SPECIES_NAME[selectedAgent.species] ?? selectedAgent.species}
                  {' · '}
                  {ARCHETYPE_LABEL[selectedAgent.archetype] ??
                    selectedAgent.archetype}
                </div>
              </div>
            )}
          </RuneFrame>
        </div>

        {/* Enter World CTA */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            zIndex: 2,
          }}
        >
          <RpgButton
            variant="primary"
            rarity="legendary"
            size="lg"
            onClick={handleEnterWorld}
            disabled={!activeAgent}
          >
            Enter World
          </RpgButton>
          {!activeAgent && agents.length > 0 && (
            <div
              style={{
                fontSize: 10,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: '#64748b',
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
              }}
            >
              Activate an agent to continue
            </div>
          )}
          {agents.length === 0 && (
            <div
              style={{
                fontSize: 10,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: '#64748b',
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
              }}
            >
              Forge your first agent to begin
            </div>
          )}
        </div>
      </main>

      {/* ====== RIGHT · DETAILS PANEL ====== */}
      <aside
        className="relative shrink-0 overflow-hidden flex flex-col"
        style={{
          width: '100%',
          maxWidth: 400,
          borderLeft: '1px solid rgba(56,189,248,0.12)',
          background:
            'linear-gradient(180deg, rgba(5,12,28,0.85) 0%, rgba(2,7,19,0.95) 100%)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
        }}
      >
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '18px 18px 20px',
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(56,189,248,0.35) transparent',
          }}
        >
          {panel === 'create' && (
            <AgentCreationForm
              onCreated={() => {
                setPanel('details');
                setTimeout(() => {
                  const latest = queryClient.getQueryData<{
                    agents: Agent[];
                  }>(['agent-roster']);
                  if (latest?.agents?.length) {
                    setSelectedId(
                      latest.agents[latest.agents.length - 1]!.id
                    );
                  }
                }, 500);
              }}
              onCancel={() => setPanel('details')}
            />
          )}

          {panel === 'connect-external' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '8px 0' }}>
              <div>
                <div style={{
                  fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                  fontSize: 18, fontWeight: 700, color: '#f1f5f9',
                  textShadow: '0 0 14px rgba(56,189,248,0.4)',
                  marginBottom: 8,
                }}>
                  Connect External Agent
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.6 }}>
                  Already running an agent elsewhere? Connect it to ClawVille without creating a new one.
                </div>
              </div>

              <RuneFrame tier="rare" glow="subtle" style={{ padding: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#7dd3fc', marginBottom: 6 }}>OpenClaw / Hermes Agent</div>
                <div style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.6, marginBottom: 10 }}>
                  Run your agent with a gateway URL pointing at ClawVille. Your agent connects via POST /api/agent/connect with its agentId + gatewayUrl.
                </div>
                <div style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 9, color: '#7fe6ff', background: 'rgba(0,0,0,0.3)',
                  padding: '8px 10px', borderRadius: 6, wordBreak: 'break-all',
                }}>
                  curl -X POST https://api.clawville.world/api/agent/connect \<br/>
                  &nbsp;&nbsp;-H &apos;Content-Type: application/json&apos; \<br/>
                  &nbsp;&nbsp;-d &apos;&#123;&quot;agentId&quot;:&quot;my-agent&quot;, &quot;name&quot;:&quot;MyBot&quot;, &quot;species&quot;:&quot;cat&quot;&#125;&apos;
                </div>
              </RuneFrame>

              <RuneFrame tier="epic" glow="subtle" style={{ padding: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#c084fc', marginBottom: 6 }}>Milady AI Agent</div>
                <div style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.6, marginBottom: 10 }}>
                  Install the ClawVille plugin in your Milady Desktop, then type &quot;open clawville&quot; in any chat.
                </div>
                <div style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 9, color: '#c084fc', background: 'rgba(0,0,0,0.3)',
                  padding: '8px 10px', borderRadius: 6, wordBreak: 'break-all',
                }}>
                  curl -X POST http://localhost:2138/api/plugins/install \<br/>
                  &nbsp;&nbsp;-H &apos;Content-Type: application/json&apos; \<br/>
                  &nbsp;&nbsp;-d &apos;&#123;&quot;name&quot;:&quot;@clawville/app-clawville&quot;&#125;&apos;
                </div>
                <div style={{ fontSize: 9, color: '#64748b', marginTop: 6 }}>
                  npm: <a href="https://www.npmjs.com/package/@clawville/app-clawville" target="_blank" rel="noopener" style={{ color: '#7dd3fc', textDecoration: 'underline' }}>@clawville/app-clawville</a>
                </div>
              </RuneFrame>

              <RuneFrame tier="uncommon" glow="subtle" style={{ padding: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#4ade80', marginBottom: 6 }}>Browser Claw (No Setup)</div>
                <div style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.6 }}>
                  Just enter the game as a spectator and click &quot;Connect Bot&quot; in the top bar. Your browser becomes the agent — no external tools needed.
                </div>
              </RuneFrame>

              <RpgButton variant="ghost" size="sm" onClick={() => setPanel('details')}>
                Back
              </RpgButton>
            </div>
          )}

          {panel === 'details' && selectedAgent && (
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
            >
              {/* Header with name + active toggle */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily:
                          'var(--font-clawville, var(--font-orbitron, ui-sans-serif)), sans-serif',
                        fontSize: 20,
                        fontWeight: 700,
                        color: '#f1f5f9',
                        textShadow: '0 0 14px rgba(56,189,248,0.4)',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {selectedAgent.name}
                    </div>
                    <div
                      style={{
                        fontSize: 9,
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, monospace',
                        color: '#7dd3fc',
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        marginTop: 3,
                      }}
                    >
                      Champion Dossier
                    </div>
                  </div>
                  {selectedAgent.isActive ? (
                    <RarityBadge
                      tier="legendary"
                      showDot
                      size="md"
                      label="Active"
                    />
                  ) : (
                    <RpgButton
                      variant="secondary"
                      size="sm"
                      onClick={() => activateMut.mutate(selectedAgent.id)}
                      loading={activateMut.isPending}
                    >
                      Activate
                    </RpgButton>
                  )}
                </div>
              </div>

              {/* Stats grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: 8,
                }}
              >
                <StatCard
                  label="Level"
                  value={`Lv ${selectedAgent.level}`}
                  tier="rare"
                  icon="⚔"
                />
                <StatCard
                  label="Experience"
                  value={`${selectedAgent.xp} XP`}
                  tier="epic"
                  icon="✦"
                />
                <StatCard
                  label="Neo Tokens"
                  value={selectedAgent.clawTokens}
                  tier="legendary"
                  icon="◈"
                />
                <StatCard
                  label="Knowledge"
                  value={`${totalLearned}/${totalBooks}`}
                  tier={totalLearned === totalBooks ? 'legendary' : 'uncommon'}
                  icon="✧"
                />
                <StatCard
                  label="Species"
                  value={
                    SPECIES_NAME[selectedAgent.species] ??
                    selectedAgent.species
                  }
                  tier="common"
                  icon="◆"
                />
                <StatCard
                  label="Archetype"
                  value={
                    ARCHETYPE_LABEL[selectedAgent.archetype] ??
                    selectedAgent.archetype
                  }
                  tier="rare"
                  icon="◇"
                />
              </div>

              {/* Talent tree */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      fontFamily:
                        'var(--font-orbitron, ui-sans-serif), sans-serif',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.24em',
                      textTransform: 'uppercase',
                      color: '#cbd5e1',
                    }}
                  >
                    Talent Tree
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, monospace',
                      color: '#7dd3fc',
                    }}
                  >
                    {totalLearned}/{totalBooks}
                  </div>
                </div>

                {/* Progress bar */}
                <div
                  style={{
                    height: 4,
                    borderRadius: 999,
                    background: 'rgba(56,189,248,0.1)',
                    border: '1px solid rgba(56,189,248,0.15)',
                    overflow: 'hidden',
                    marginBottom: 12,
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${progressPct}%`,
                      background:
                        'linear-gradient(90deg, #38bdf8 0%, #fb923c 100%)',
                      boxShadow: '0 0 12px rgba(251,146,60,0.5)',
                      transition: 'width 260ms ease',
                    }}
                  />
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  {MAP_LOCATIONS.map((loc) => {
                    const books = BOOKS_BY_BUILDING[loc.id] ?? [];
                    return (
                      <TalentRow
                        key={loc.id}
                        buildingName={loc.name}
                        buildingIcon={loc.icon}
                        books={books}
                        learnedBooks={learnedBooks}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Loadout */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      fontFamily:
                        'var(--font-orbitron, ui-sans-serif), sans-serif',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.24em',
                      textTransform: 'uppercase',
                      color: '#cbd5e1',
                    }}
                  >
                    Loadout
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, monospace',
                      color: '#64748b',
                    }}
                  >
                    {equippedSkills.length}/{MAX_LOADOUT_SLOTS} equipped
                  </div>
                </div>

                <LoadoutBar
                  equippedSkills={equippedSkills}
                  onSlotDrop={handleSlotDrop}
                  onSlotClear={handleToggleLoadout}
                  onDragStartEquipped={() => {
                    /* no-op for now — drag preview supplied by browser */
                  }}
                />

                <div style={{ marginTop: 12 }}>
                  <AvailableSkillsTray
                    learnedBooks={learnedBooks}
                    equippedSkills={equippedSkills}
                    onEquip={handleToggleLoadout}
                  />
                </div>
              </div>

              {/* Config actions */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  paddingTop: 6,
                  borderTop: '1px solid rgba(56,189,248,0.12)',
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, monospace',
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: '#64748b',
                    marginBottom: 4,
                  }}
                >
                  Tome Management
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <RpgButton
                    variant="secondary"
                    size="sm"
                    onClick={() => exportMut.mutate(selectedAgent.id)}
                    loading={exportMut.isPending}
                    style={{ flex: 1 }}
                  >
                    Export
                  </RpgButton>
                  <RpgButton
                    variant="secondary"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    style={{ flex: 1 }}
                  >
                    Import
                  </RpgButton>
                </div>
                <RpgButton
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    if (
                      confirm(
                        `Delete agent "${selectedAgent.name}"? This cannot be undone.`
                      )
                    ) {
                      deleteMut.mutate(selectedAgent.id);
                    }
                  }}
                  loading={deleteMut.isPending}
                  style={{ width: '100%' }}
                >
                  Delete Agent
                </RpgButton>
              </div>
            </div>
          )}

          {panel === 'details' && !selectedAgent && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '48px 16px',
                gap: 12,
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 42, opacity: 0.25 }}>⚓</div>
              <div
                style={{
                  fontFamily:
                    'var(--font-orbitron, ui-sans-serif), sans-serif',
                  fontSize: 12,
                  letterSpacing: '0.22em',
                  textTransform: 'uppercase',
                  color: '#94a3b8',
                }}
              >
                No Agent Selected
              </div>
              <div
                style={{
                  fontSize: 10,
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: '#64748b',
                }}
              >
                Choose a champion from the roster or forge a new one.
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
