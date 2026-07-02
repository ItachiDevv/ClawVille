'use client';

import { useCallback, useEffect, useState } from 'react';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { api } from '@/lib/api';

const STEPS = ['Customize', 'Select Knowledge', 'Preview', 'Export & Publish'] as const;

const inputClasses =
  'w-full px-3 py-2 rounded-lg border-2 border-yellow-600/30 bg-white/90 text-black text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-transparent';
const textareaClasses = `${inputClasses} resize-none`;

export default function SkillBuilderModal() {
  const { skillBuilderOpen, setSkillBuilderOpen, addToast, agentConnected } = useGameStore();
  const { data: avatar } = useAvatar();
  const skillFormat = agentConnected ? 'openclaw' as const : 'elizaos' as const;

  const [step, setStep] = useState(0);

  // Step 1: Customize
  const [customName, setCustomName] = useState('');
  const [customDescription, setCustomDescription] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');

  // Step 2: Select Knowledge
  const [allKnowledge, setAllKnowledge] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Step 3: Preview
  const [previewMd, setPreviewMd] = useState('');
  const [installPath, setInstallPath] = useState('');
  const [publishCommand, setPublishCommand] = useState('');
  const [generating, setGenerating] = useState(false);

  // Step 4: Export
  const [downloadingMemory, setDownloadingMemory] = useState(false);

  // Prefill from avatar data
  useEffect(() => {
    if (skillBuilderOpen && avatar) {
      const config = avatar.characterConfig as any;
      const knowledge: string[] = config?.knowledge ?? [];
      setCustomName(avatar.name ?? '');
      setCustomDescription(`OpenClaw knowledge from ${avatar.name}`);
      setCustomInstructions('');
      setAllKnowledge(knowledge);
      setSelected(new Set(knowledge));
      setPreviewMd('');
      setInstallPath('');
      setPublishCommand('');
      setStep(0);
    }
  }, [skillBuilderOpen, avatar]);

  // Group knowledge by source building
  const grouped = useCallback(() => {
    const groups: Record<string, string[]> = {};
    const ungrouped: string[] = [];
    for (const entry of allKnowledge) {
      const match = entry.match(/from\s+(.+)$/i);
      if (match) {
        const source = match[1].trim();
        if (!groups[source]) groups[source] = [];
        groups[source].push(entry);
      } else {
        ungrouped.push(entry);
      }
    }
    if (ungrouped.length > 0) groups['General'] = ungrouped;
    return groups;
  }, [allKnowledge]);

  const toggleKnowledge = (entry: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entry)) next.delete(entry);
      else next.add(entry);
      return next;
    });
  };

  const toggleGroup = (entries: string[]) => {
    const allSelected = entries.every((e) => selected.has(e));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of entries) {
        if (allSelected) next.delete(e);
        else next.add(e);
      }
      return next;
    });
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await api.openclawGenerateSkill({
        customName: customName || undefined,
        customDescription: customDescription || undefined,
        customInstructions: customInstructions || undefined,
        selectedKnowledge: [...selected],
        format: skillFormat,
      });
      setPreviewMd(res.skillMd);
      setInstallPath(res.installPath);
      setPublishCommand(res.publishCommand);
    } catch (err: any) {
      addToast('!', err.message || 'Failed to generate skill');
    } finally {
      setGenerating(false);
    }
  };

  const handleNext = async () => {
    if (step === 1) {
      // Moving to Preview — auto-generate
      setStep(2);
      setGenerating(true);
      try {
        const res = await api.openclawGenerateSkill({
          customName: customName || undefined,
          customDescription: customDescription || undefined,
          customInstructions: customInstructions || undefined,
          selectedKnowledge: [...selected],
          format: skillFormat,
        });
        setPreviewMd(res.skillMd);
        setInstallPath(res.installPath);
        setPublishCommand(res.publishCommand);
      } catch (err: any) {
        addToast('!', err.message || 'Failed to generate skill');
      } finally {
        setGenerating(false);
      }
    } else {
      setStep((s) => Math.min(s + 1, STEPS.length - 1));
    }
  };

  const handleCopySkillMd = () => {
    navigator.clipboard.writeText(previewMd);
    addToast('📋', 'Skill copied to clipboard!');
  };

  const handleDownloadSkillMd = () => {
    const slug = (customName || avatar?.name || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filename = skillFormat === 'openclaw' ? `${slug}-SKILL.md` : `${slug}.character.json`;
    const content = skillFormat === 'openclaw' ? previewMd : previewMd;
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    addToast('💾', `${filename} downloaded!`);
  };

  const handleDownloadMemory = async () => {
    if (!avatar?.id) return;
    setDownloadingMemory(true);
    try {
      const data = await api.exportMemory(avatar.id);
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      // Add MEMORY.md
      zip.file('MEMORY.md', data.longTermMemory);

      // Add daily logs
      for (const log of data.dailyLogs) {
        zip.file(log.filename, log.content);
      }

      // Add SKILL.md if generated
      if (previewMd) {
        zip.file('SKILL.md', previewMd);
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${avatar.name}-memory-pack.zip`;
      a.click();
      URL.revokeObjectURL(url);
      addToast('📦', `Memory pack downloaded (${data.totalMemories} memories, ${data.totalActivities} activities)`);
    } catch (err: any) {
      addToast('!', err.message || 'Failed to export memory');
    } finally {
      setDownloadingMemory(false);
    }
  };

  const handleCopyInstall = () => {
    navigator.clipboard.writeText(
      `mkdir -p $(dirname "${installPath}") && cp SKILL.md "${installPath}"`
    );
    addToast('📋', 'Install command copied!');
  };

  const handleCopyPublish = () => {
    navigator.clipboard.writeText(publishCommand);
    addToast('📋', 'Publish command copied!');
  };

  // Keyboard nav
  useEffect(() => {
    if (!skillBuilderOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSkillBuilderOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [skillBuilderOpen, setSkillBuilderOpen]);

  if (!skillBuilderOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSkillBuilderOpen(false)} />
      <div className="relative w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="claw-panel flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <h2 className="font-clawville text-xl text-white">
              Skill Builder
            </h2>
            <button
              onClick={() => setSkillBuilderOpen(false)}
              className="text-white/70 hover:text-white font-bold text-lg"
            >
              ×
            </button>
          </div>

          {/* Step indicator */}
          <div className="flex items-center justify-center gap-2 px-4 pb-3">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <button
                  onClick={() => i < step && setStep(i)}
                  className={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all ${
                    i === step
                      ? 'bg-purple-600 text-white shadow-[0_0_8px_rgba(147,51,234,0.5)]'
                      : i < step
                        ? 'bg-purple-300 text-purple-900 cursor-pointer hover:bg-purple-400'
                        : 'bg-gray-200 text-gray-500'
                  }`}
                >
                  {i + 1}
                </button>
                {i < STEPS.length - 1 && (
                  <div className={`w-6 h-0.5 ${i < step ? 'bg-purple-400' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>

          <div className="text-center text-sm font-bold text-white/80 pb-2">
            {STEPS[step]}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
            {/* Step 1: Customize */}
            {step === 0 && (
              <>
                <div>
                  <label className="block font-bold text-sm text-black mb-1">Skill Name</label>
                  <input
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    className={inputClasses}
                    placeholder="My Agent's Name"
                    maxLength={60}
                  />
                  <p className="text-gray-500 text-xs mt-1">
                    {skillFormat === 'openclaw'
                      ? `Published as: openclaw-${(customName || 'name').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
                      : `Character: ${(customName || 'name').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.character.json`}
                  </p>
                </div>
                <div>
                  <label className="block font-bold text-sm text-black mb-1">Description</label>
                  <textarea
                    value={customDescription}
                    onChange={(e) => setCustomDescription(e.target.value)}
                    className={textareaClasses}
                    rows={2}
                    maxLength={200}
                    placeholder="What this skill teaches..."
                  />
                  <p className="text-gray-500 text-xs mt-1">{customDescription.length}/200</p>
                </div>
                <div>
                  <label className="block font-bold text-sm text-black mb-1">Custom Instructions (optional)</label>
                  <textarea
                    value={customInstructions}
                    onChange={(e) => setCustomInstructions(e.target.value)}
                    className={textareaClasses}
                    rows={3}
                    maxLength={2000}
                    placeholder="Add special instructions for how the agent should use this knowledge..."
                  />
                  <p className="text-gray-500 text-xs mt-1">{customInstructions.length}/2000</p>
                </div>
              </>
            )}

            {/* Step 2: Select Knowledge */}
            {step === 1 && (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-white/80 font-bold">
                    {selected.size}/{allKnowledge.length} selected
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelected(new Set(allKnowledge))}
                      className="text-xs text-purple-700 font-bold hover:underline"
                    >
                      Select All
                    </button>
                    <button
                      onClick={() => setSelected(new Set())}
                      className="text-xs text-gray-500 font-bold hover:underline"
                    >
                      Deselect All
                    </button>
                  </div>
                </div>

                {allKnowledge.length === 0 ? (
                  <div className="bg-yellow-50 rounded-lg px-3 py-3 text-center">
                    <p className="text-yellow-800 text-sm font-bold">No knowledge yet</p>
                    <p className="text-yellow-700 text-xs mt-1">
                      Visit buildings and chat with their characters to learn OpenClaw knowledge.
                    </p>
                  </div>
                ) : (
                  Object.entries(grouped()).map(([source, entries]) => (
                    <div key={source} className="bg-white/60 rounded-lg border border-gray-200 overflow-hidden">
                      <button
                        onClick={() => toggleGroup(entries)}
                        className="w-full flex items-center justify-between px-3 py-2 bg-gray-100/80 hover:bg-gray-200/80 transition-colors"
                      >
                        <span className="text-sm font-bold text-white/90">{source}</span>
                        <span className="text-xs text-gray-500">
                          {entries.filter((e) => selected.has(e)).length}/{entries.length}
                        </span>
                      </button>
                      <div className="px-3 py-1.5">
                        {entries.map((entry) => (
                          <label
                            key={entry}
                            className="flex items-start gap-2 py-1 cursor-pointer hover:bg-yellow-50/50 rounded px-1"
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(entry)}
                              onChange={() => toggleKnowledge(entry)}
                              className="mt-0.5 accent-purple-600"
                            />
                            <span className="text-xs text-white/80 leading-relaxed">{entry}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </>
            )}

            {/* Step 3: Preview */}
            {step === 2 && (
              <>
                {generating ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin w-8 h-8 border-4 border-purple-300 border-t-purple-600 rounded-full" />
                    <span className="ml-3 text-sm text-white/80">Generating skill...</span>
                  </div>
                ) : previewMd ? (
                  <>
                    <div className="bg-gray-900 rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 bg-gray-800">
                        <span className="text-xs text-gray-400 font-mono">{skillFormat === 'openclaw' ? 'SKILL.md' : 'ElizaOS Skill'}</span>
                        <button
                          onClick={handleCopySkillMd}
                          className="text-xs text-purple-300 hover:text-white font-bold"
                        >
                          Copy
                        </button>
                      </div>
                      <pre className="px-3 py-2 text-xs text-green-300 font-mono overflow-x-auto max-h-60 whitespace-pre-wrap">
                        {previewMd}
                      </pre>
                    </div>
                    <button
                      onClick={handleGenerate}
                      className="text-sm text-purple-700 font-bold hover:underline"
                    >
                      Regenerate
                    </button>
                  </>
                ) : (
                  <div className="text-center py-8">
                    <p className="text-gray-500 text-sm">Failed to generate preview. Try again.</p>
                    <button
                      onClick={handleGenerate}
                      className="mt-2 color-btn bg-purple-500 hover:bg-purple-600 text-sm px-4 py-2"
                    >
                      Generate
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Step 4: Export & Publish */}
            {step === 3 && (
              <>
                {/* Action cards */}
                <div className="space-y-2">
                  <button
                    onClick={handleCopySkillMd}
                    disabled={!previewMd}
                    className="w-full flex items-center gap-3 px-3 py-3 bg-purple-50 rounded-lg border border-purple-200 hover:bg-purple-100 transition-colors text-left disabled:opacity-50"
                  >
                    <span className="text-2xl">📋</span>
                    <div>
                      <p className="text-sm font-bold text-purple-900">Copy Skill</p>
                      <p className="text-xs text-purple-700">Copy to clipboard for manual installation</p>
                    </div>
                  </button>

                  <button
                    onClick={handleDownloadSkillMd}
                    disabled={!previewMd}
                    className="w-full flex items-center gap-3 px-3 py-3 bg-blue-50 rounded-lg border border-blue-200 hover:bg-blue-100 transition-colors text-left disabled:opacity-50"
                  >
                    <span className="text-2xl">💾</span>
                    <div>
                      <p className="text-sm font-bold text-blue-900">Download Skill File</p>
                      <p className="text-xs text-blue-700">{skillFormat === 'openclaw' ? 'Save SKILL.md' : 'Save character JSON'}</p>
                    </div>
                  </button>

                  <button
                    onClick={handleDownloadMemory}
                    disabled={downloadingMemory || !avatar?.id}
                    className="w-full flex items-center gap-3 px-3 py-3 bg-green-50 rounded-lg border border-green-200 hover:bg-green-100 transition-colors text-left disabled:opacity-50"
                  >
                    <span className="text-2xl">📦</span>
                    <div>
                      <p className="text-sm font-bold text-green-900">
                        {downloadingMemory ? 'Packing memories...' : 'Download Memory Pack'}
                      </p>
                      <p className="text-xs text-green-700">
                        SKILL.md + MEMORY.md + daily logs as .zip
                      </p>
                    </div>
                  </button>
                </div>

                {/* Install instructions */}
                {installPath && (
                  <div className="bg-gray-900 rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-gray-800">
                      <span className="text-xs text-gray-400">Install path</span>
                      <button
                        onClick={handleCopyInstall}
                        className="text-xs text-purple-300 hover:text-white font-bold"
                      >
                        Copy
                      </button>
                    </div>
                    <pre className="px-3 py-2 text-xs text-green-300 font-mono overflow-x-auto">
                      {installPath}
                    </pre>
                  </div>
                )}

                {/* Publish command */}
                {publishCommand && (
                  <div className="bg-gray-900 rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-gray-800">
                      <span className="text-xs text-gray-400">{skillFormat === 'openclaw' ? 'Publish to ClawHub' : 'Publish to ElizaOS'}</span>
                      <button
                        onClick={handleCopyPublish}
                        className="text-xs text-purple-300 hover:text-white font-bold"
                      >
                        Copy
                      </button>
                    </div>
                    <pre className="px-3 py-2 text-xs text-green-300 font-mono overflow-x-auto whitespace-pre-wrap">
                      {publishCommand}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-yellow-600/20">
            <button
              onClick={() => step === 0 ? setSkillBuilderOpen(false) : setStep((s) => s - 1)}
              className="text-sm font-bold text-white/70 hover:text-white transition-colors"
            >
              {step === 0 ? 'Cancel' : 'Back'}
            </button>

            {step < STEPS.length - 1 ? (
              <button
                onClick={handleNext}
                className="color-btn bg-purple-600 hover:bg-purple-700 text-sm px-6 py-2"
              >
                Next
              </button>
            ) : (
              <button
                onClick={() => setSkillBuilderOpen(false)}
                className="color-btn bg-green-600 hover:bg-green-700 text-sm px-6 py-2"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
