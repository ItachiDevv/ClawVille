'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
  neoTokens: number;
  isActive: boolean;
  equippedSkills: string[];
  learnedBooks: string[];
  characterConfig?: any;
}

type Panel = 'details' | 'create' | 'import';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_AGENTS = 6;
const MAX_LOADOUT_SLOTS = 6;

const COLOR_HEX: Record<string, string> = Object.fromEntries(
  PET_COLORS.map((c) => [c.id, c.hex])
);

const SPECIES_NAME: Record<string, string> = Object.fromEntries(
  PET_SPECIES.map((s) => [s.id, s.name])
);

const ARCHETYPE_LABEL: Record<string, string> = Object.fromEntries(
  PET_ARCHETYPES.map((a) => [a.id, a.label])
);

// Group books by building for the talent tree
const BOOKS_BY_BUILDING: Record<string, typeof KNOWLEDGE_BOOKS> = {};
for (const book of KNOWLEDGE_BOOKS) {
  if (!BOOKS_BY_BUILDING[book.building]) BOOKS_BY_BUILDING[book.building] = [];
  BOOKS_BY_BUILDING[book.building].push(book);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <div className="animate-spin w-5 h-5 border-2 border-cyan-300 border-t-transparent rounded-full" />
  );
}

/** Single roster slot (filled or empty). */
function RosterSlot({
  agent,
  selected,
  onSelect,
}: {
  agent: Agent | null;
  selected: boolean;
  onSelect: () => void;
}) {
  if (!agent) {
    return (
      <button
        onClick={onSelect}
        className="w-full flex items-center gap-3 px-3 py-3 rounded-lg border border-dashed border-white/10 hover:border-cyan-500/30 transition-colors group"
      >
        <div className="w-10 h-10 rounded-full bg-white/[0.03] border border-white/10 flex items-center justify-center text-white/20 group-hover:text-cyan-500/50 transition-colors text-lg">
          +
        </div>
        <span className="text-white/20 text-xs font-mono uppercase tracking-wider group-hover:text-white/40 transition-colors">
          Empty Slot
        </span>
      </button>
    );
  }

  const colorHex = COLOR_HEX[agent.color] ?? '#888';

  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg border transition-all ${
        selected
          ? 'border-cyan-400/60 bg-cyan-500/10 shadow-[0_0_12px_rgba(0,229,255,0.12)]'
          : 'border-white/10 hover:border-white/20 bg-white/[0.02]'
      }`}
    >
      {/* Avatar circle */}
      <div
        className="relative w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0"
        style={{ backgroundColor: colorHex + '30', borderColor: colorHex, borderWidth: 2 }}
      >
        {agent.isActive && (
          <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-cyan-400 border-2 border-[#0a1628] shadow-[0_0_6px_rgba(0,229,255,0.6)]" />
        )}
        <span className="select-none">
          {PET_SPECIES.find((s) => s.id === agent.species)?.emoji ?? '?'}
        </span>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0 text-left">
        <p className="text-sm font-bold text-white truncate">{agent.name}</p>
        <p className="text-[10px] text-white/40 font-mono uppercase tracking-wider">
          {SPECIES_NAME[agent.species] ?? agent.species} &middot; Lv{agent.level}
        </p>
      </div>

      {/* XP chip */}
      <span className="text-[10px] font-bold text-cyan-400/60 bg-cyan-500/10 rounded-full px-2 py-0.5 shrink-0">
        {agent.xp} XP
      </span>
    </button>
  );
}

/** Talent tree row: one building with 2 book circles. */
function TalentRow({
  buildingId,
  buildingName,
  buildingIcon,
  books,
  learnedBooks,
}: {
  buildingId: string;
  buildingName: string;
  buildingIcon: string;
  books: typeof KNOWLEDGE_BOOKS;
  learnedBooks: string[];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-base shrink-0">{buildingIcon}</span>
      <span className="text-[11px] text-white/60 truncate flex-1 min-w-0">{buildingName}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        {books.map((book) => {
          const learned = learnedBooks.includes(book.id);
          return (
            <div
              key={book.id}
              title={book.name}
              className={`w-4 h-4 rounded-full border-2 transition-colors ${
                learned
                  ? 'bg-cyan-400 border-cyan-300 shadow-[0_0_6px_rgba(0,229,255,0.5)]'
                  : 'bg-transparent border-white/20'
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Loadout grid: 6 equippable skill slots. */
function LoadoutGrid({
  equippedSkills,
  learnedBooks,
  onToggle,
}: {
  equippedSkills: string[];
  learnedBooks: string[];
  onToggle: (bookId: string) => void;
}) {
  const slots = Array.from({ length: MAX_LOADOUT_SLOTS }, (_, i) => equippedSkills[i] ?? null);

  return (
    <div className="grid grid-cols-3 gap-2">
      {slots.map((bookId, i) => {
        const book = bookId ? KNOWLEDGE_BOOKS.find((b) => b.id === bookId) : null;

        return (
          <button
            key={i}
            onClick={() => {
              if (bookId) onToggle(bookId);
            }}
            className={`relative aspect-square rounded-lg border flex flex-col items-center justify-center gap-1 transition-all ${
              book
                ? 'border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20'
                : 'border-white/10 bg-white/[0.02]'
            }`}
            title={book ? `${book.name} (click to unequip)` : 'Empty slot'}
          >
            {book ? (
              <>
                <span className="text-base">{book.icon}</span>
                <span className="text-[9px] text-white/60 font-mono leading-tight text-center line-clamp-2 px-1">
                  {book.name}
                </span>
              </>
            ) : (
              <span className="text-white/10 text-lg">+</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Inline agent creation form. */
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
        archetype,
        personality: { habitat: 'deep-sea', hobby: 'exploring', greeting: `Hi, I'm ${name}!` },
        stats: { hp: 100, attack: 10, defense: 10, speed: 10 },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-roster'] });
      onCreated();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-bold text-white tracking-wide">Create Agent</h3>

      {/* Name */}
      <div>
        <label className="block text-white/50 text-[10px] font-mono uppercase tracking-wider mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={20}
          placeholder="Agent name..."
          className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 transition-all"
        />
      </div>

      {/* Species */}
      <div>
        <label className="block text-white/50 text-[10px] font-mono uppercase tracking-wider mb-1">Species</label>
        <select
          value={species}
          onChange={(e) => setSpecies(e.target.value as typeof species)}
          className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-cyan-500/50 transition-all"
        >
          {PET_SPECIES.map((s) => (
            <option key={s.id} value={s.id} className="bg-[#0a1628]">
              {s.emoji} {s.name}
            </option>
          ))}
        </select>
      </div>

      {/* Color */}
      <div>
        <label className="block text-white/50 text-[10px] font-mono uppercase tracking-wider mb-1">Color</label>
        <div className="flex gap-2">
          {PET_COLORS.map((c) => (
            <button
              key={c.id}
              onClick={() => setColor(c.id)}
              className={`w-8 h-8 rounded-full border-2 transition-all ${
                color === c.id
                  ? 'border-white shadow-[0_0_8px_rgba(255,255,255,0.3)] scale-110'
                  : 'border-transparent hover:border-white/30'
              }`}
              style={{ backgroundColor: c.hex }}
              title={c.name}
            />
          ))}
        </div>
      </div>

      {/* Gender */}
      <div>
        <label className="block text-white/50 text-[10px] font-mono uppercase tracking-wider mb-1">Gender</label>
        <div className="flex gap-2">
          {['male', 'female'].map((g) => (
            <button
              key={g}
              onClick={() => setGender(g)}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                gender === g
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                  : 'bg-white/[0.03] text-white/40 border border-white/10 hover:border-white/20'
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {/* Archetype */}
      <div>
        <label className="block text-white/50 text-[10px] font-mono uppercase tracking-wider mb-1">Archetype</label>
        <select
          value={archetype}
          onChange={(e) => setArchetype(e.target.value as typeof archetype)}
          className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-cyan-500/50 transition-all"
        >
          {PET_ARCHETYPES.map((a) => (
            <option key={a.id} value={a.id} className="bg-[#0a1628]">
              {a.label} - {a.description}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {/* Buttons */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => createMut.mutate()}
          disabled={!name || name.length < 3 || createMut.isPending}
          className="flex-1 py-2.5 rounded-lg font-bold text-xs uppercase tracking-wider transition-all disabled:opacity-30 disabled:cursor-not-allowed bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white shadow-[0_0_16px_rgba(0,229,255,0.15)]"
        >
          {createMut.isPending ? 'Creating...' : 'Create Agent'}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2.5 rounded-lg text-xs font-bold text-white/40 hover:text-white/60 bg-white/[0.03] border border-white/10 hover:border-white/20 transition-all"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function SelectAgentPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // State
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('details');
  const [importError, setImportError] = useState('');

  // Queries
  const { data: rosterData, isLoading: rosterLoading } = useQuery({
    queryKey: ['agent-roster'],
    queryFn: () => api.getAgentRoster(),
  });

  const agents: Agent[] = (rosterData?.agents as Agent[]) ?? [];
  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;
  const activeAgent = agents.find((a) => a.isActive) ?? null;

  // Auto-select the active agent or first agent on load
  useEffect(() => {
    if (agents.length > 0 && !selectedId) {
      const active = agents.find((a) => a.isActive);
      setSelectedId(active?.id ?? agents[0]!.id);
    }
  }, [agents, selectedId]);

  // Talent tree query for selected agent
  const { data: talentData } = useQuery({
    queryKey: ['agent-talent-tree', selectedId],
    queryFn: () => api.getAgentTalentTree(selectedId!),
    enabled: !!selectedId,
  });

  // Mutations
  const activateMut = useMutation({
    mutationFn: (id: string) => api.activateAgent(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-roster'] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-roster'] });
      setSelectedId(null);
    },
  });

  const loadoutMut = useMutation({
    mutationFn: ({ id, skills }: { id: string; skills: string[] }) => api.updateLoadout(id, skills),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-roster'] }),
  });

  const exportMut = useMutation({
    mutationFn: (id: string) => api.exportAgent(id),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data.config, null, 2)], { type: 'application/json' });
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

  // Handlers
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

  // Escape key handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && panel !== 'details') {
        setPanel('details');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [panel]);

  // Computed
  const learnedBooks = selectedAgent?.learnedBooks ?? [];
  const totalLearned = learnedBooks.length;
  const equippedSkills = selectedAgent?.equippedSkills ?? [];

  // =========================================================================
  // RENDER
  // =========================================================================

  if (rosterLoading) {
    return (
      <div className="fixed inset-0 bg-gradient-to-b from-[#060d1a] via-[#0a1628] to-[#0e1f3a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Spinner />
          <p className="font-clawville text-white text-xl animate-pulse">Loading roster...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-gradient-to-b from-[#060d1a] via-[#0a1628] to-[#0e1f3a] flex flex-col lg:flex-row overflow-hidden">
      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleImportFile}
      />

      {/* ====== LEFT: ROSTER SIDEBAR ====== */}
      <aside className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-white/[0.06] bg-[#080e1c]/80 flex flex-col overflow-hidden">
        {/* Sidebar header */}
        <div className="px-4 pt-5 pb-3">
          <h2 className="font-clawville text-lg text-white tracking-wide">Agent Roster</h2>
          <p className="text-[10px] text-cyan-400/50 font-mono uppercase tracking-widest mt-0.5">
            {agents.length} / {MAX_AGENTS} slots
          </p>
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5 lg:max-h-none max-h-44">
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

        {/* Sidebar footer actions */}
        <div className="px-3 pb-4 pt-2 space-y-1.5 border-t border-white/[0.04]">
          {agents.length < MAX_AGENTS && (
            <button
              onClick={() => setPanel('create')}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 hover:bg-cyan-500/20 hover:border-cyan-500/30 transition-all"
            >
              <span className="text-sm">+</span> New Agent
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold text-white/40 bg-white/[0.03] border border-white/10 hover:bg-white/[0.06] hover:border-white/20 transition-all"
          >
            Import Config
          </button>
          {importError && (
            <p className="text-red-400 text-[10px] text-center">{importError}</p>
          )}
        </div>
      </aside>

      {/* ====== CENTER: 3D PREVIEW ====== */}
      <main className="flex-1 flex flex-col items-center justify-center relative min-h-0">
        {/* Background glow */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] rounded-full bg-cyan-500/[0.04] blur-[100px]" />
        </div>

        {/* 3D Character Preview */}
        <div className="relative w-full max-w-lg aspect-square max-h-[55vh] mx-auto">
          <div className="w-full h-full rounded-2xl border border-white/[0.06] overflow-hidden">
            {selectedAgent ? (
              <SelectAgentCanvas
                modelKey="lobster"
                color={selectedAgent.color}
              />
            ) : (
              <div className="w-full h-full bg-[#070f1f]/60 backdrop-blur-sm flex flex-col items-center justify-center gap-4">
                <span className="text-5xl text-white/10">?</span>
                <p className="text-white/20 text-sm font-mono">Select or create an agent</p>
              </div>
            )}
          </div>
          {/* Agent name overlay */}
          {selectedAgent && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-center">
              <p className="font-clawville text-xl text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
                {selectedAgent.name}
              </p>
              <p className="text-[10px] text-cyan-400/60 font-mono uppercase tracking-widest mt-0.5">
                {SPECIES_NAME[selectedAgent.species] ?? selectedAgent.species}
                {selectedAgent.archetype && ` \u00B7 ${ARCHETYPE_LABEL[selectedAgent.archetype] ?? selectedAgent.archetype}`}
              </p>
            </div>
          )}
        </div>

        {/* Enter World button */}
        <div className="mt-6 mb-4 px-4">
          <button
            onClick={handleEnterWorld}
            disabled={!activeAgent}
            className="px-12 py-3.5 rounded-xl font-clawville text-base uppercase tracking-wider transition-all disabled:opacity-20 disabled:cursor-not-allowed bg-gradient-to-r from-cyan-600 to-cyan-400 hover:from-cyan-500 hover:to-cyan-300 text-white shadow-[0_0_28px_rgba(0,229,255,0.25)] hover:shadow-[0_0_40px_rgba(0,229,255,0.4)]"
          >
            Enter World
          </button>
          {!activeAgent && agents.length > 0 && (
            <p className="text-center text-white/30 text-[10px] font-mono mt-2">
              Activate an agent first
            </p>
          )}
        </div>
      </main>

      {/* ====== RIGHT: DETAILS PANEL ====== */}
      <aside className="w-full lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-white/[0.06] bg-[#080e1c]/80 overflow-y-auto">
        <div className="p-4 space-y-5">
          {/* ---------- CREATE PANEL ---------- */}
          {panel === 'create' && (
            <AgentCreationForm
              onCreated={() => {
                setPanel('details');
                // Auto-select the newest agent after a short delay for query refetch
                setTimeout(() => {
                  const latest = queryClient.getQueryData<{ agents: Agent[] }>(['agent-roster']);
                  if (latest?.agents?.length) {
                    setSelectedId(latest.agents[latest.agents.length - 1]!.id);
                  }
                }, 500);
              }}
              onCancel={() => setPanel('details')}
            />
          )}

          {/* ---------- DETAILS PANEL ---------- */}
          {panel === 'details' && selectedAgent && (
            <>
              {/* Agent info header */}
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="font-clawville text-lg text-white">{selectedAgent.name}</h3>
                  {selectedAgent.isActive ? (
                    <span className="text-[10px] font-bold text-cyan-300 bg-cyan-500/20 border border-cyan-500/30 rounded-full px-2.5 py-0.5">
                      ACTIVE
                    </span>
                  ) : (
                    <button
                      onClick={() => activateMut.mutate(selectedAgent.id)}
                      disabled={activateMut.isPending}
                      className="text-[10px] font-bold text-white/50 bg-white/[0.05] border border-white/10 rounded-full px-2.5 py-0.5 hover:bg-cyan-500/10 hover:text-cyan-300 hover:border-cyan-500/30 transition-all disabled:opacity-40"
                    >
                      {activateMut.isPending ? '...' : 'Activate'}
                    </button>
                  )}
                </div>

                {/* Stats grid */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-3">
                  <div>
                    <span className="text-[10px] text-white/30 font-mono uppercase">Species</span>
                    <p className="text-xs text-white/80">{SPECIES_NAME[selectedAgent.species] ?? selectedAgent.species}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-white/30 font-mono uppercase">Color</span>
                    <p className="text-xs text-white/80 flex items-center gap-1.5">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: COLOR_HEX[selectedAgent.color] ?? '#888' }}
                      />
                      {PET_COLORS.find((c) => c.id === selectedAgent.color)?.name ?? selectedAgent.color}
                    </p>
                  </div>
                  <div>
                    <span className="text-[10px] text-white/30 font-mono uppercase">Archetype</span>
                    <p className="text-xs text-white/80">{ARCHETYPE_LABEL[selectedAgent.archetype] ?? selectedAgent.archetype}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-white/30 font-mono uppercase">Level</span>
                    <p className="text-xs text-white/80">Lv {selectedAgent.level}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-white/30 font-mono uppercase">XP</span>
                    <p className="text-xs text-cyan-300">{selectedAgent.xp}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-white/30 font-mono uppercase">Tokens</span>
                    <p className="text-xs text-amber-300">{selectedAgent.neoTokens}</p>
                  </div>
                </div>
              </div>

              {/* Divider */}
              <div className="border-t border-white/[0.06]" />

              {/* Talent Tree */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-bold text-white/70 uppercase tracking-wider">Talent Tree</h4>
                  <span className="text-[10px] text-cyan-400/60 font-mono">
                    {totalLearned}/20 skills
                  </span>
                </div>

                {/* Progress bar */}
                <div className="w-full h-1.5 rounded-full bg-white/[0.06] mb-3 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-cyan-300 transition-all"
                    style={{ width: `${(totalLearned / 20) * 100}%` }}
                  />
                </div>

                <div className="space-y-2">
                  {MAP_LOCATIONS.map((loc) => {
                    const books = BOOKS_BY_BUILDING[loc.id] ?? [];
                    return (
                      <TalentRow
                        key={loc.id}
                        buildingId={loc.id}
                        buildingName={loc.name}
                        buildingIcon={loc.icon}
                        books={books}
                        learnedBooks={learnedBooks}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Divider */}
              <div className="border-t border-white/[0.06]" />

              {/* Loadout */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-bold text-white/70 uppercase tracking-wider">Loadout</h4>
                  <span className="text-[10px] text-white/30 font-mono">
                    {equippedSkills.length}/{MAX_LOADOUT_SLOTS} equipped
                  </span>
                </div>
                <LoadoutGrid
                  equippedSkills={equippedSkills}
                  learnedBooks={learnedBooks}
                  onToggle={handleToggleLoadout}
                />

                {/* Learned books that can be equipped */}
                {learnedBooks.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[10px] text-white/30 font-mono uppercase tracking-wider mb-1.5">
                      Available Skills (click to equip)
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {learnedBooks
                        .filter((id) => !equippedSkills.includes(id))
                        .map((bookId) => {
                          const book = KNOWLEDGE_BOOKS.find((b) => b.id === bookId);
                          if (!book) return null;
                          return (
                            <button
                              key={bookId}
                              onClick={() => handleToggleLoadout(bookId)}
                              disabled={equippedSkills.length >= MAX_LOADOUT_SLOTS}
                              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold bg-white/[0.04] border border-white/10 text-white/50 hover:bg-cyan-500/10 hover:text-cyan-300 hover:border-cyan-500/30 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              <span>{book.icon}</span>
                              <span className="truncate max-w-[80px]">{book.name}</span>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>

              {/* Divider */}
              <div className="border-t border-white/[0.06]" />

              {/* Actions */}
              <div className="space-y-2">
                <button
                  onClick={() => exportMut.mutate(selectedAgent.id)}
                  disabled={exportMut.isPending}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold text-white/50 bg-white/[0.03] border border-white/10 hover:bg-white/[0.06] hover:text-white/70 hover:border-white/20 transition-all disabled:opacity-40"
                >
                  {exportMut.isPending ? 'Exporting...' : 'Export Config'}
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete agent "${selectedAgent.name}"? This cannot be undone.`)) {
                      deleteMut.mutate(selectedAgent.id);
                    }
                  }}
                  disabled={deleteMut.isPending}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold text-red-400/60 bg-red-500/[0.05] border border-red-500/20 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 transition-all disabled:opacity-40"
                >
                  {deleteMut.isPending ? 'Deleting...' : 'Delete Agent'}
                </button>
              </div>
            </>
          )}

          {/* ---------- NO AGENT SELECTED ---------- */}
          {panel === 'details' && !selectedAgent && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <span className="text-4xl text-white/10 mb-3">?</span>
              <p className="text-white/30 text-sm">Select an agent to view details</p>
              <p className="text-white/15 text-xs mt-1 font-mono">
                Or create a new one from the sidebar
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
