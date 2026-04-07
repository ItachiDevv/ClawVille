'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { MAP_LOCATIONS } from '@legacyapp/shared';
import { useLocationAgent, useSaveLocationAgent } from '@/hooks/use-locations';

const TONE_OPTIONS = [
  { value: 'casual', label: 'Casual' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'formal', label: 'Formal' },
  { value: 'professional', label: 'Professional' },
];

export default function ConfigureLocationPage() {
  const params = useParams();
  const router = useRouter();
  const locationId = params.id as string;
  const location = MAP_LOCATIONS.find((l) => l.id === locationId);

  const { data: existingAgent, isLoading } = useLocationAgent(locationId);
  const saveMutation = useSaveLocationAgent();

  const [agentName, setAgentName] = useState('');
  const [personality, setPersonality] = useState('');
  const [bio, setBio] = useState('');
  const [greeting, setGreeting] = useState('');
  const [tone, setTone] = useState('friendly');
  const [topics, setTopics] = useState('');
  const [rules, setRules] = useState('');
  const [style, setStyle] = useState('');

  // Populate from existing agent
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
      setStyle((config.style || []).join('\n'));
    }
  }, [existingAgent]);

  if (!location) {
    return (
      <div className="star-bg min-h-screen flex items-center justify-center">
        <div className="claw-panel text-center">
          <p className="text-lg font-bold">Location not found</p>
        </div>
      </div>
    );
  }

  const handleSave = async () => {
    await saveMutation.mutateAsync({
      locationId,
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
    router.push('/game');
  };

  if (isLoading) {
    return (
      <div className="star-bg min-h-screen flex items-center justify-center">
        <div className="claw-panel">Loading...</div>
      </div>
    );
  }

  return (
    <div className="star-bg min-h-screen py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="claw-panel mb-6 text-center">
          <h1 className="text-2xl font-bold mb-1">
            {location.icon} Configure Agent: {location.name}
          </h1>
          <p className="text-sm opacity-80">{location.description}</p>
        </div>

        {/* Form */}
        <div className="space-y-4">
          {/* Agent Name */}
          <div className="claw-panel">
            <label className="block font-bold mb-1">Agent Name</label>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="e.g. Kauvara the Potion Master"
              className="w-full px-3 py-2 rounded-lg border-2 border-claw-panel-border bg-white/90 focus:outline-none focus:ring-2 focus:ring-claw-accent"
            />
          </div>

          {/* Personality */}
          <div className="claw-panel">
            <label className="block font-bold mb-1">Personality</label>
            <textarea
              value={personality}
              onChange={(e) => setPersonality(e.target.value)}
              placeholder="Describe the agent's personality..."
              rows={3}
              className="w-full px-3 py-2 rounded-lg border-2 border-claw-panel-border bg-white/90 focus:outline-none focus:ring-2 focus:ring-claw-accent resize-none"
            />
          </div>

          {/* Bio */}
          <div className="claw-panel">
            <label className="block font-bold mb-1">Bio</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Background story and lore..."
              rows={3}
              className="w-full px-3 py-2 rounded-lg border-2 border-claw-panel-border bg-white/90 focus:outline-none focus:ring-2 focus:ring-claw-accent resize-none"
            />
          </div>

          {/* Greeting */}
          <div className="claw-panel">
            <label className="block font-bold mb-1">Greeting</label>
            <input
              type="text"
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              placeholder="What does the agent say when you enter?"
              className="w-full px-3 py-2 rounded-lg border-2 border-claw-panel-border bg-white/90 focus:outline-none focus:ring-2 focus:ring-claw-accent"
            />
          </div>

          {/* Tone */}
          <div className="claw-panel">
            <label className="block font-bold mb-1">Tone</label>
            <select
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-2 border-claw-panel-border bg-white/90 focus:outline-none focus:ring-2 focus:ring-claw-accent"
            >
              {TONE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Topics */}
          <div className="claw-panel">
            <label className="block font-bold mb-1">Topics (comma-separated)</label>
            <input
              type="text"
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              placeholder="potions, magic, ingredients"
              className="w-full px-3 py-2 rounded-lg border-2 border-claw-panel-border bg-white/90 focus:outline-none focus:ring-2 focus:ring-claw-accent"
            />
          </div>

          {/* Rules */}
          <div className="claw-panel">
            <label className="block font-bold mb-1">Rules (one per line)</label>
            <textarea
              value={rules}
              onChange={(e) => setRules(e.target.value)}
              placeholder="Always stay in character&#10;Never break the fourth wall"
              rows={3}
              className="w-full px-3 py-2 rounded-lg border-2 border-claw-panel-border bg-white/90 focus:outline-none focus:ring-2 focus:ring-claw-accent resize-none"
            />
          </div>

          {/* Style */}
          <div className="claw-panel">
            <label className="block font-bold mb-1">Style guidelines (one per line)</label>
            <textarea
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              placeholder="Use archaic language&#10;Reference magical ingredients"
              rows={3}
              className="w-full px-3 py-2 rounded-lg border-2 border-claw-panel-border bg-white/90 focus:outline-none focus:ring-2 focus:ring-claw-accent resize-none"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-4">
            <button
              onClick={() => router.push('/game')}
              className="color-btn flex-1"
              style={{ background: '#666' }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!agentName || !personality || saveMutation.isPending}
              className="color-btn flex-1"
              style={{ background: '#4CAF50' }}
            >
              {saveMutation.isPending ? 'Saving...' : existingAgent ? 'Update Agent' : 'Create Agent'}
            </button>
          </div>

          {saveMutation.error && (
            <div className="claw-panel bg-red-100 text-red-700 text-center">
              {(saveMutation.error as Error).message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
