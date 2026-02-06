'use client';

import { useState, useEffect } from 'react';
import { useGameStore } from '@/stores/game';
import { useLocationAgent, useSaveLocationAgent } from '@/hooks/use-locations';
import { MAP_LOCATIONS } from '@legacyapp/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';

const TONE_OPTIONS = [
  { value: 'casual', label: 'Casual' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'formal', label: 'Formal' },
  { value: 'professional', label: 'Professional' },
];

export default function LocationConfigModal() {
  const {
    locationConfigModalOpen,
    locationConfigTarget,
    closeLocationConfig,
  } = useGameStore();

  const location = MAP_LOCATIONS.find((l) => l.id === locationConfigTarget);
  const { data: existingAgent, isLoading } = useLocationAgent(
    locationConfigTarget
  );
  const saveMutation = useSaveLocationAgent();

  const [agentName, setAgentName] = useState('');
  const [personality, setPersonality] = useState('');
  const [bio, setBio] = useState('');
  const [greeting, setGreeting] = useState('');
  const [tone, setTone] = useState('friendly');
  const [topics, setTopics] = useState('');
  const [rules, setRules] = useState('');
  const [style, setStyle] = useState('');

  // Populate from existing agent when it loads
  useEffect(() => {
    if (existingAgent) {
      setAgentName(existingAgent.agentName);
      const config = existingAgent.characterConfig;
      setPersonality(config.personality || '');
      setBio(config.bio || '');
      setGreeting(config.greeting || '');
      setTone(config.tone || 'friendly');
      setTopics((config.topics || []).join(', '));
      setRules((config.rules || []).join('\n'));
      setStyle(
        Array.isArray(config.style) ? config.style.join('\n') : ''
      );
    } else if (!isLoading) {
      // Reset form for new agent
      setAgentName('');
      setPersonality('');
      setBio('');
      setGreeting('');
      setTone('friendly');
      setTopics('');
      setRules('');
      setStyle('');
    }
  }, [existingAgent, isLoading]);

  const handleSave = async () => {
    if (!locationConfigTarget) return;

    await saveMutation.mutateAsync({
      locationId: locationConfigTarget,
      data: {
        agentName,
        characterConfig: {
          name: agentName,
          personality,
          bio,
          greeting,
          tone: tone as 'formal' | 'casual' | 'friendly' | 'professional',
          topics: topics
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          rules: rules
            .split('\n')
            .map((r) => r.trim())
            .filter(Boolean),
          style: style
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      },
    });

    closeLocationConfig();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      closeLocationConfig();
    }
  };

  const inputClasses =
    'w-full px-3 py-2 rounded-lg border-2 border-yellow-600/30 bg-white/90 text-black text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-transparent';
  const textareaClasses = `${inputClasses} resize-none`;
  const labelClasses = 'block font-bold text-sm text-black mb-1';

  return (
    <Dialog open={locationConfigModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-lg flex items-center gap-2">
                {location?.icon} Configure: {location?.name ?? 'Location'}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {location?.description ?? 'Set up an AI agent for this location'}
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <button
                className="w-8 h-8 rounded-full bg-black/20 hover:bg-black/40 text-white flex items-center justify-center font-bold transition-colors"
                aria-label="Close"
              >
                X
              </button>
            </DialogClose>
          </div>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-black/60 text-sm animate-pulse">Loading...</p>
          </div>
        ) : (
          <div className="overflow-y-auto flex-1 p-6 space-y-4">
            {/* Agent Name */}
            <div>
              <label className={labelClasses}>Agent Name</label>
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="e.g. Kauvara the Potion Master"
                className={inputClasses}
              />
            </div>

            {/* Personality */}
            <div>
              <label className={labelClasses}>Personality</label>
              <textarea
                value={personality}
                onChange={(e) => setPersonality(e.target.value)}
                placeholder="Describe the agent's personality..."
                rows={3}
                className={textareaClasses}
              />
            </div>

            {/* Bio */}
            <div>
              <label className={labelClasses}>Bio</label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Background story and lore..."
                rows={3}
                className={textareaClasses}
              />
            </div>

            {/* Greeting */}
            <div>
              <label className={labelClasses}>Greeting</label>
              <input
                type="text"
                value={greeting}
                onChange={(e) => setGreeting(e.target.value)}
                placeholder="What does the agent say when you enter?"
                className={inputClasses}
              />
            </div>

            {/* Tone */}
            <div>
              <label className={labelClasses}>Tone</label>
              <select
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                className={inputClasses}
              >
                {TONE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Topics */}
            <div>
              <label className={labelClasses}>Topics (comma-separated)</label>
              <input
                type="text"
                value={topics}
                onChange={(e) => setTopics(e.target.value)}
                placeholder="potions, magic, ingredients"
                className={inputClasses}
              />
            </div>

            {/* Rules */}
            <div>
              <label className={labelClasses}>Rules (one per line)</label>
              <textarea
                value={rules}
                onChange={(e) => setRules(e.target.value)}
                placeholder={'Always stay in character\nNever break the fourth wall'}
                rows={3}
                className={textareaClasses}
              />
            </div>

            {/* Style */}
            <div>
              <label className={labelClasses}>
                Style guidelines (one per line)
              </label>
              <textarea
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                placeholder={'Use archaic language\nReference magical ingredients'}
                rows={3}
                className={textareaClasses}
              />
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                onClick={closeLocationConfig}
                className="flex-1 py-2.5 rounded-lg bg-black/10 text-black font-bold text-sm hover:bg-black/20 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={
                  !agentName || !personality || saveMutation.isPending
                }
                className="flex-1 py-2.5 rounded-lg bg-gradient-to-r from-green-500 to-green-600 text-white font-bold text-sm hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saveMutation.isPending
                  ? 'Saving...'
                  : existingAgent
                    ? 'Update Agent'
                    : 'Create Agent'}
              </button>
            </div>

            {saveMutation.error && (
              <div className="bg-red-100 text-red-700 text-sm rounded-lg px-3 py-2 text-center">
                {(saveMutation.error as Error).message}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
