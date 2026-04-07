'use client';

import { useCallback, useEffect, useState } from 'react';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { api } from '@/lib/api';

type Tab = 'browse' | 'my-skills' | 'purchases';
type SortMode = 'newest' | 'upvotes' | 'downloads';

interface SkillSummary {
  id: string;
  authorAvatarName: string;
  authorSpecies: string;
  name: string;
  description: string;
  upvoteCount: number;
  downloadCount: number;
  hasUpvoted: boolean;
  createdAt: string;
}

interface InventorySkill {
  id: string;
  itemId: string;
  skillId: string;
  quantity: number;
  name?: string;
}

/** Generate a ClawHub-style slug from a skill name */
function toSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default function MarketplaceModal() {
  const { marketplaceOpen, closeMarketplace, addToast } = useGameStore();
  const { data: avatar, refetch: refetchPet } = useAvatar();

  const [tab, setTab] = useState<Tab>('browse');
  const [sort, setSort] = useState<SortMode>('newest');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [mySkills, setMySkills] = useState<SkillSummary[]>([]);
  const [purchases, setPurchases] = useState<InventorySkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  // Detail view
  const [detailSkill, setDetailSkill] = useState<(SkillSummary & { skillMd?: string }) | null>(null);

  const loadBrowse = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getMarketplaceSkills(sort);
      setSkills(res.skills);
    } catch { /* ignore */ }
    setLoading(false);
  }, [sort]);

  const loadMySkills = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getMyPublishedSkills();
      setMySkills(res.skills);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const loadPurchases = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getInventory();
      const skillItems = res.inventory
        .filter((i) => i.itemId.startsWith('skill-'))
        .map((i) => ({
          id: i.id,
          itemId: i.itemId,
          skillId: i.itemId.replace('skill-', ''),
          quantity: i.quantity,
          name: i.name,
        }));
      setPurchases(skillItems);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!marketplaceOpen) return;
    if (tab === 'browse') loadBrowse();
    else if (tab === 'my-skills') loadMySkills();
    else if (tab === 'purchases') loadPurchases();
  }, [marketplaceOpen, tab, sort, loadBrowse, loadMySkills, loadPurchases]);

  useEffect(() => {
    if (!marketplaceOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (detailSkill) setDetailSkill(null);
        else closeMarketplace();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [marketplaceOpen, closeMarketplace, detailSkill]);

  const handleStar = async (skillId: string) => {
    try {
      const res = await api.upvoteSkill(skillId);
      const update = (list: SkillSummary[]) =>
        list.map((s) =>
          s.id === skillId ? { ...s, hasUpvoted: res.upvoted, upvoteCount: res.upvoteCount } : s
        );
      setSkills(update);
      setMySkills(update);
      if (detailSkill?.id === skillId) {
        setDetailSkill((d) => d ? { ...d, hasUpvoted: res.upvoted, upvoteCount: res.upvoteCount } : null);
      }
    } catch (err: any) {
      addToast('!', err.message || 'Failed to star');
    }
  };

  const handleBuy = async (skill: SkillSummary) => {
    setBuying(skill.id);
    try {
      const res = await api.buySkill(skill.id);
      addToast('🛒', `Added "${res.skill.name}" to your collection`);
      refetchPet();
      loadBrowse();
    } catch (err: any) {
      addToast('!', err.message || 'Purchase failed');
    }
    setBuying(null);
  };

  const handleInstall = async (skillId: string) => {
    setInstalling(skillId);
    try {
      const res = await api.installSkill(skillId);
      addToast('📚', `Installed "${res.skillName}" — ${res.newKnowledgeCount} new knowledge entries`);
      refetchPet();
      loadPurchases();
    } catch (err: any) {
      addToast('!', err.message || 'Install failed');
    }
    setInstalling(null);
  };

  const handleViewDetail = async (skill: SkillSummary) => {
    try {
      const res = await api.getMarketplaceSkill(skill.id);
      setDetailSkill(res.skill);
    } catch {
      setDetailSkill({ ...skill, skillMd: '' });
    }
  };

  const handleDownloadZip = (skill: SkillSummary & { skillMd?: string }) => {
    if (!skill.skillMd) return;
    const blob = new Blob([skill.skillMd], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${toSlug(skill.name)}-SKILL.md`;
    a.click();
    URL.revokeObjectURL(url);
    addToast('💾', 'SKILL.md downloaded');
  };

  const handleCopyInstallCommand = (skill: SkillSummary & { skillMd?: string }) => {
    const isElizaOs = skill.skillMd?.includes('format: elizaos-character');
    const cmd = isElizaOs
      ? `npx elizaos start --character ${toSlug(skill.name)}.character.json`
      : `clawhub install clawville/${toSlug(skill.authorAvatarName)}/${toSlug(skill.name)}`;
    navigator.clipboard.writeText(cmd);
    addToast('📋', 'Install command copied');
  };

  if (!marketplaceOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { if (detailSkill) setDetailSkill(null); else closeMarketplace(); }} />
      <div className="relative w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="claw-panel flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <h2 className="font-clawville text-xl text-gray-900">
              {detailSkill ? (
                <button onClick={() => setDetailSkill(null)} className="text-purple-700 hover:underline mr-2">
                  ← Back
                </button>
              ) : null}
              Skill Marketplace
            </h2>
            <button
              onClick={() => { setDetailSkill(null); closeMarketplace(); }}
              className="text-gray-600 hover:text-gray-900 font-bold text-lg"
            >
              ×
            </button>
          </div>

          {/* === Detail view (ClawHub-style skill page) === */}
          {detailSkill ? (
            <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
              {/* Title + author */}
              <div>
                <h3 className="font-bold text-lg text-gray-900">{detailSkill.name}</h3>
                <p className="text-sm text-gray-500">
                  {detailSkill.authorAvatarName}/{toSlug(detailSkill.name)}
                </p>
              </div>

              {/* Stats row — mirrors ClawHub: stars, installs, downloads */}
              <div className="flex items-center gap-4 text-sm">
                <button
                  onClick={() => handleStar(detailSkill.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold transition-colors ${
                    detailSkill.hasUpvoted
                      ? 'bg-yellow-100 text-yellow-700 border border-yellow-300'
                      : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-yellow-50'
                  }`}
                >
                  {detailSkill.hasUpvoted ? '★' : '☆'} {detailSkill.upvoteCount}
                </button>
                <span className="text-gray-500 text-xs flex items-center gap-1">
                  <span className="text-base">⬇</span> {detailSkill.downloadCount} installs
                </span>
                <span className="text-gray-400 text-xs">
                  {new Date(detailSkill.createdAt).toLocaleDateString()}
                </span>
              </div>

              <p className="text-sm text-gray-700">{detailSkill.description}</p>

              {/* Install command */}
              <div className="bg-gray-900 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-800">
                  <span className="text-xs text-gray-400 font-mono">Install</span>
                  <button
                    onClick={() => handleCopyInstallCommand(detailSkill)}
                    className="text-xs text-purple-300 hover:text-white font-bold"
                  >
                    Copy
                  </button>
                </div>
                <pre className="px-3 py-2 text-sm text-green-300 font-mono">
                  {detailSkill.skillMd?.includes('format: elizaos-character')
                    ? `npx elizaos start --character ${toSlug(detailSkill.name)}.character.json`
                    : `clawhub install clawville/${toSlug(detailSkill.authorAvatarName)}/${toSlug(detailSkill.name)}`}
                </pre>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => handleBuy(detailSkill)}
                  disabled={buying === detailSkill.id}
                  className="flex-1 color-btn bg-green-600 hover:bg-green-700 text-sm py-2 disabled:opacity-50"
                >
                  {buying === detailSkill.id ? 'Adding...' : 'Get (Free)'}
                </button>
                <button
                  onClick={() => handleDownloadZip(detailSkill)}
                  disabled={!detailSkill.skillMd}
                  className="color-btn bg-gray-600 hover:bg-gray-700 text-sm px-4 py-2 disabled:opacity-50"
                  title="Download SKILL.md"
                >
                  Download zip
                </button>
              </div>

              {/* SKILL.md preview */}
              {detailSkill.skillMd && (
                <div className="bg-gray-900 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-800">
                    <span className="text-xs text-gray-400 font-mono">
                      {detailSkill.skillMd?.includes('format: elizaos-character') ? 'ElizaOS Skill' : 'SKILL.md'}
                    </span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(detailSkill.skillMd || '');
                        addToast('📋', 'Copied to clipboard');
                      }}
                      className="text-xs text-purple-300 hover:text-white font-bold"
                    >
                      Copy
                    </button>
                  </div>
                  <pre className="px-3 py-2 text-xs text-green-300 font-mono overflow-x-auto max-h-60 whitespace-pre-wrap">
                    {detailSkill.skillMd}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* === Browse view === */}
              {/* Tabs */}
              <div className="flex border-b border-yellow-600/20 px-4">
                {(['browse', 'my-skills', 'purchases'] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-4 py-2 text-sm font-bold transition-colors border-b-2 ${
                      tab === t
                        ? 'text-purple-700 border-purple-600'
                        : 'text-gray-500 border-transparent hover:text-gray-700'
                    }`}
                  >
                    {t === 'browse' ? 'Browse' : t === 'my-skills' ? 'My Skills' : 'Purchases'}
                  </button>
                ))}
              </div>

              {/* Sort (browse only) */}
              {tab === 'browse' && (
                <div className="flex items-center gap-2 px-4 pt-2">
                  <span className="text-xs text-gray-500 font-bold">Sort:</span>
                  {(['newest', 'upvotes', 'downloads'] as SortMode[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSort(s)}
                      className={`text-xs px-2 py-1 rounded-md font-bold transition-colors ${
                        sort === s ? 'bg-purple-100 text-purple-700' : 'text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      {s === 'newest' ? 'Newest' : s === 'upvotes' ? 'Most Starred' : 'Most Installed'}
                    </button>
                  ))}
                </div>
              )}

              {/* Content */}
              <div className="flex-1 overflow-y-auto px-4 pb-4 pt-2 space-y-2 min-h-[200px] max-h-[55vh]">
                {loading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin w-6 h-6 border-3 border-purple-300 border-t-purple-600 rounded-full" />
                  </div>
                ) : tab === 'browse' ? (
                  skills.length === 0 ? (
                    <div className="text-center py-8 text-gray-500 text-sm">
                      No skills published yet. Be the first!
                    </div>
                  ) : (
                    skills.map((skill) => (
                      <SkillCard
                        key={skill.id}
                        skill={skill}
                        onStar={() => handleStar(skill.id)}
                        onBuy={() => handleBuy(skill)}
                        onView={() => handleViewDetail(skill)}
                        buying={buying === skill.id}
                      />
                    ))
                  )
                ) : tab === 'my-skills' ? (
                  mySkills.length === 0 ? (
                    <div className="text-center py-8 text-gray-500 text-sm">
                      You haven't published any skills yet. Use the Skill Builder to create one!
                    </div>
                  ) : (
                    mySkills.map((skill) => (
                      <SkillCard
                        key={skill.id}
                        skill={skill}
                        onStar={() => handleStar(skill.id)}
                        onView={() => handleViewDetail(skill)}
                        isOwn
                      />
                    ))
                  )
                ) : (
                  purchases.length === 0 ? (
                    <div className="text-center py-8 text-gray-500 text-sm">
                      No purchased skills. Browse the marketplace to find skills to buy!
                    </div>
                  ) : (
                    purchases.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between bg-white/60 rounded-lg border border-gray-200 px-3 py-2.5"
                      >
                        <div>
                          <p className="text-sm font-bold text-gray-900">{item.name || item.skillId}</p>
                          <p className="text-xs text-gray-500">Qty: {item.quantity}</p>
                        </div>
                        <button
                          onClick={() => handleInstall(item.skillId)}
                          disabled={installing === item.skillId}
                          className="color-btn bg-blue-600 hover:bg-blue-700 text-xs px-3 py-1.5 disabled:opacity-50"
                        >
                          {installing === item.skillId ? 'Installing...' : 'Install to Avatar'}
                        </button>
                      </div>
                    ))
                  )
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Skill card — ClawHub-style with stars, installs, author slug */
function SkillCard({
  skill,
  onStar,
  onBuy,
  onView,
  buying,
  isOwn,
}: {
  skill: SkillSummary;
  onStar: () => void;
  onBuy?: () => void;
  onView: () => void;
  buying?: boolean;
  isOwn?: boolean;
}) {
  return (
    <div className="bg-white/60 rounded-lg border border-gray-200 px-3 py-2.5 hover:border-purple-300 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <button
            onClick={onView}
            className="text-sm font-bold text-purple-800 hover:underline truncate block text-left"
          >
            {skill.name}
          </button>
          <p className="text-xs text-gray-400 mt-0.5 font-mono">
            {skill.authorAvatarName}/{toSlug(skill.name)}
          </p>
          <p className="text-xs text-gray-600 mt-1 line-clamp-2">{skill.description}</p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <button
            onClick={onStar}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-bold transition-colors ${
              skill.hasUpvoted
                ? 'bg-yellow-100 text-yellow-700 border border-yellow-300'
                : 'bg-gray-100 text-gray-500 hover:bg-yellow-50 border border-transparent'
            }`}
            title="Star skill"
          >
            {skill.hasUpvoted ? '★' : '☆'} {skill.upvoteCount}
          </button>
          {!isOwn && onBuy && (
            <button
              onClick={onBuy}
              disabled={buying}
              className="color-btn bg-green-600 hover:bg-green-700 text-xs px-2 py-1 disabled:opacity-50"
            >
              {buying ? '...' : 'Free'}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
        <span>⬇ {skill.downloadCount} installs</span>
        <span>{new Date(skill.createdAt).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
