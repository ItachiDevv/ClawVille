'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useCreatePet } from '@/hooks/use-avatar';

const SPECIES_EMOJI: Record<string, string> = {
  cat: '\u{1F431}',
  dragon: '\u{1F409}',
  fox: '\u{1F98A}',
  owl: '\u{1F989}',
  wolf: '\u{1F43A}',
  bunny: '\u{1F430}',
  phoenix: '\u{1F525}',
  turtle: '\u{1F422}',
};

const COLOR_HEX: Record<string, string> = {
  green: '#4CAF50',
  red: '#F44336',
  blue: '#2196F3',
  yellow: '#FFD700',
};

const HABITAT_OPTIONS = [
  { value: 'forest', label: 'Forest' },
  { value: 'sea', label: 'Sea' },
  { value: 'mountain', label: 'Mountain' },
  { value: 'sky', label: 'Sky' },
  { value: 'desert', label: 'Desert' },
  { value: 'cave', label: 'Cave' },
];

const HOBBY_OPTIONS = [
  { value: 'reading-and-learning', label: 'Reading and Learning' },
  { value: 'exploring', label: 'Exploring' },
  { value: 'battling', label: 'Battling' },
  { value: 'collecting', label: 'Collecting' },
  { value: 'cooking', label: 'Cooking' },
  { value: 'art', label: 'Art' },
];

const GREETING_OPTIONS = [
  { value: 'run-away', label: 'Run Awaaaay!!!' },
  { value: 'wave-hello', label: 'Wave Hello' },
  { value: 'tackle-hug', label: 'Tackle Hug!' },
  { value: 'shy-peek', label: 'Shy Peek...' },
  { value: 'bow-politely', label: 'Bow Politely' },
  { value: 'roar', label: 'ROAR!!!' },
];

// Same stat calculation as the API
const HABITAT_STATS: Record<string, { s: number; d: number; m: number }> = {
  forest: { s: 3, d: 4, m: 3 },
  sea: { s: 2, d: 3, m: 5 },
  mountain: { s: 5, d: 4, m: 1 },
  sky: { s: 2, d: 2, m: 6 },
  desert: { s: 4, d: 3, m: 3 },
  cave: { s: 5, d: 5, m: 0 },
};

const HOBBY_STATS: Record<string, { s: number; d: number; m: number }> = {
  'reading-and-learning': { s: 0, d: 2, m: 3 },
  exploring: { s: 1, d: 1, m: 3 },
  battling: { s: 4, d: 1, m: 0 },
  collecting: { s: 1, d: 1, m: 3 },
  cooking: { s: 1, d: 3, m: 1 },
  art: { s: 0, d: 3, m: 2 },
};

const GREETING_STATS: Record<string, { s: number; d: number; m: number }> = {
  'run-away': { s: 0, d: 1, m: 4 },
  'wave-hello': { s: 1, d: 2, m: 2 },
  'tackle-hug': { s: 3, d: 0, m: 2 },
  'shy-peek': { s: 0, d: 4, m: 1 },
  'bow-politely': { s: 1, d: 3, m: 1 },
  roar: { s: 4, d: 1, m: 0 },
};

interface Step1Data {
  species: string;
  color: string;
  name: string;
  gender: string;
}

const TONE_OPTIONS = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'playful', label: 'Playful' },
  { value: 'casual', label: 'Casual' },
  { value: 'formal', label: 'Formal' },
];

const SUGGESTED_TOPICS = [
  'adventures', 'food', 'games', 'nature', 'magic', 'friendship',
  'exploring', 'treasure', 'stories', 'jokes', 'dreams', 'secrets'
];

const SUGGESTED_ADJECTIVES = [
  'friendly', 'curious', 'playful', 'brave', 'shy', 'clever',
  'loyal', 'mischievous', 'gentle', 'energetic', 'mysterious', 'wise'
];

export default function PersonalityPage() {
  const router = useRouter();
  const createPetMutation = useCreatePet();

  const [step1, setStep1] = useState<Step1Data | null>(null);
  const [habitat, setHabitat] = useState('forest');
  const [hobby, setHobby] = useState('reading-and-learning');
  const [greetingStyle, setGreetingStyle] = useState('run-away');
  const [error, setError] = useState('');

  // Character config fields (for ElizaOS agent)
  const [bio, setBio] = useState('');
  const [greetingMessage, setGreetingMessage] = useState('');
  const [personalityDesc, setPersonalityDesc] = useState('');
  const [tone, setTone] = useState('friendly');
  const [topics, setTopics] = useState<string[]>(['adventures', 'games']);
  const [adjectives, setAdjectives] = useState<string[]>(['friendly', 'curious']);
  const [topicInput, setTopicInput] = useState('');
  const [adjectiveInput, setAdjectiveInput] = useState('');

  // Load step 1 data from sessionStorage
  useEffect(() => {
    const raw = sessionStorage.getItem('createPetStep1');
    if (!raw) {
      router.push('/create-avatar');
      return;
    }
    try {
      setStep1(JSON.parse(raw));
    } catch {
      router.push('/create-avatar');
    }
  }, [router]);

  // Calculate stats from personality choices (mirrors API logic)
  const stats = useMemo(() => {
    const h = HABITAT_STATS[habitat] ?? { s: 0, d: 0, m: 0 };
    const ho = HOBBY_STATS[hobby] ?? { s: 0, d: 0, m: 0 };
    const g = GREETING_STATS[greetingStyle] ?? { s: 0, d: 0, m: 0 };

    return {
      strength: h.s + ho.s + g.s,
      defence: h.d + ho.d + g.d,
      movement: h.m + ho.m + g.m,
    };
  }, [habitat, hobby, greetingStyle]);

  const maxStat = 15; // theoretical max per stat (5+4+4 for strength via mountain+battling+roar)

  async function handleCreate() {
    if (!step1) return;
    setError('');

    // Validate required character config fields
    if (!bio || bio.length < 10) {
      setError('Please write a bio (at least 10 characters)');
      return;
    }
    if (!greetingMessage) {
      setError('Please write a greeting message');
      return;
    }
    if (!personalityDesc || personalityDesc.length < 10) {
      setError('Please describe your avatar\'s personality (at least 10 characters)');
      return;
    }
    if (topics.length === 0) {
      setError('Please select at least one topic');
      return;
    }
    if (adjectives.length === 0) {
      setError('Please select at least one adjective');
      return;
    }

    try {
      await createPetMutation.mutateAsync({
        name: step1.name,
        species: step1.species,
        color: step1.color,
        gender: step1.gender,
        personality: { habitat, hobby, greeting: greetingStyle },
        characterConfig: {
          bio,
          greeting: greetingMessage,
          personality: personalityDesc,
          tone: tone as 'formal' | 'casual' | 'friendly' | 'playful',
          topics,
          adjectives,
          rules: [],
          style: [],
        },
      });

      sessionStorage.removeItem('createPetStep1');
      router.push('/game');
    } catch (err: any) {
      setError(err.message || 'Failed to create avatar');
    }
  }

  function addTopic(topic: string) {
    const t = topic.trim().toLowerCase();
    if (t && !topics.includes(t) && topics.length < 10) {
      setTopics([...topics, t]);
    }
    setTopicInput('');
  }

  function removeTopic(topic: string) {
    setTopics(topics.filter((t) => t !== topic));
  }

  function addAdjective(adj: string) {
    const a = adj.trim().toLowerCase();
    if (a && !adjectives.includes(a) && adjectives.length < 10) {
      setAdjectives([...adjectives, a]);
    }
    setAdjectiveInput('');
  }

  function removeAdjective(adj: string) {
    setAdjectives(adjectives.filter((a) => a !== adj));
  }

  if (!step1) {
    return (
      <div className="star-bg min-h-screen flex items-center justify-center">
        <p className="text-white font-legacyapp text-xl">Loading...</p>
      </div>
    );
  }

  const emoji = SPECIES_EMOJI[step1.species] || '\u{2753}';
  const colorHex = COLOR_HEX[step1.color] || '#4CAF50';

  return (
    <div className="star-bg min-h-screen flex flex-col items-center px-4 py-6">
      {/* Avatar preview + info */}
      <div className="w-full max-w-xl flex flex-col sm:flex-row items-center gap-4 mb-6">
        {/* Large preview */}
        <div
          className="w-48 h-48 rounded-xl cartoon-border flex items-center justify-center shrink-0 transition-colors duration-300"
          style={{ backgroundColor: colorHex + '33' }}
        >
          <span className="text-[80px] leading-none select-none drop-shadow-lg">
            {emoji}
          </span>
        </div>

        {/* Info display */}
        <div className="text-white text-lg space-y-1 text-center sm:text-left">
          <p>
            <span className="font-bold">Name:</span> {step1.name}
          </p>
          <p>
            <span className="font-bold">Gender:</span> {step1.gender}
          </p>
          <p>
            <span className="font-bold">Species:</span>{' '}
            {step1.species.charAt(0).toUpperCase() + step1.species.slice(1)}
          </p>
          <p>
            <span className="font-bold">Colour:</span>{' '}
            {step1.color.charAt(0).toUpperCase() + step1.color.slice(1)}
          </p>
        </div>
      </div>

      {/* PERSONALITY section */}
      <div className="w-full max-w-xl mb-4">
        <div className="flex justify-end mb-1">
          <span className="legacytheme-panel px-4 py-1 font-bold text-gray-900 uppercase tracking-wide text-sm">
            Personality
          </span>
        </div>
        <div className="legacytheme-panel space-y-4">
          {/* Habitat */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">
              Where does your avatar like to live?
            </label>
            <select
              value={habitat}
              onChange={(e) => setHabitat(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
            >
              {HABITAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Hobby */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">
              What does your avatar like doing?
            </label>
            <select
              value={hobby}
              onChange={(e) => setHobby(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
            >
              {HOBBY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Greeting Style */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">
              How does your avatar greet others?
            </label>
            <select
              value={greetingStyle}
              onChange={(e) => setGreetingStyle(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
            >
              {GREETING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* AI PERSONALITY section */}
      <div className="w-full max-w-xl mb-4">
        <div className="flex justify-end mb-1">
          <span className="legacytheme-panel px-4 py-1 font-bold text-gray-900 uppercase tracking-wide text-sm">
            AI Personality
          </span>
        </div>
        <div className="legacytheme-panel space-y-4">
          {/* Bio */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">
              Tell us about your avatar (Bio)
            </label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green resize-none"
              placeholder={`${step1?.name || 'My avatar'} is a ${step1?.species || 'creature'} who loves...`}
            />
            <p className="text-xs text-gray-600 mt-1">{bio.length}/500</p>
          </div>

          {/* Greeting Message */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">
              How does your avatar say hello?
            </label>
            <input
              type="text"
              value={greetingMessage}
              onChange={(e) => setGreetingMessage(e.target.value)}
              maxLength={200}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
              placeholder="Hey there! Ready for an adventure?"
            />
          </div>

          {/* Personality Description */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">
              Describe your avatar's personality
            </label>
            <textarea
              value={personalityDesc}
              onChange={(e) => setPersonalityDesc(e.target.value)}
              maxLength={300}
              rows={2}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green resize-none"
              placeholder="Curious and adventurous, always looking for new friends..."
            />
          </div>

          {/* Tone */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">
              Communication style
            </label>
            <select
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
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
            <label className="block font-bold text-gray-800 mb-1">
              Topics your avatar loves to talk about
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {topics.map((topic) => (
                <span
                  key={topic}
                  className="bg-legacytheme-green text-white px-2 py-1 rounded-full text-sm flex items-center gap-1"
                >
                  {topic}
                  <button
                    type="button"
                    onClick={() => removeTopic(topic)}
                    className="hover:text-red-200"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTopic(topicInput))}
                className="flex-1 px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
                placeholder="Add a topic..."
              />
              <button
                type="button"
                onClick={() => addTopic(topicInput)}
                className="px-4 py-2 bg-legacytheme-blue text-white rounded-lg hover:bg-blue-700"
              >
                Add
              </button>
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              {SUGGESTED_TOPICS.filter((t) => !topics.includes(t)).slice(0, 6).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => addTopic(t)}
                  className="text-xs bg-gray-200 hover:bg-gray-300 px-2 py-1 rounded text-gray-700"
                >
                  + {t}
                </button>
              ))}
            </div>
          </div>

          {/* Adjectives */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">
              Personality traits
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {adjectives.map((adj) => (
                <span
                  key={adj}
                  className="bg-purple-500 text-white px-2 py-1 rounded-full text-sm flex items-center gap-1"
                >
                  {adj}
                  <button
                    type="button"
                    onClick={() => removeAdjective(adj)}
                    className="hover:text-red-200"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={adjectiveInput}
                onChange={(e) => setAdjectiveInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAdjective(adjectiveInput))}
                className="flex-1 px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
                placeholder="Add a trait..."
              />
              <button
                type="button"
                onClick={() => addAdjective(adjectiveInput)}
                className="px-4 py-2 bg-purple-500 text-white rounded-lg hover:bg-purple-600"
              >
                Add
              </button>
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              {SUGGESTED_ADJECTIVES.filter((a) => !adjectives.includes(a)).slice(0, 6).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => addAdjective(a)}
                  className="text-xs bg-gray-200 hover:bg-gray-300 px-2 py-1 rounded text-gray-700"
                >
                  + {a}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* STATS section */}
      <div className="w-full max-w-xl mb-6">
        <div className="flex justify-end mb-1">
          <span className="legacytheme-panel px-4 py-1 font-bold text-gray-900 uppercase tracking-wide text-sm">
            Stats
          </span>
        </div>
        <div className="legacytheme-panel">
          {/* Stat bars */}
          <div className="space-y-3">
            {/* Strength */}
            <div className="flex items-center gap-3">
              <span className="font-bold text-gray-800 w-6 text-right">S:</span>
              <div className="flex-1 bg-gray-200 rounded-full h-5 overflow-hidden border-2 border-gray-400">
                <div
                  className="h-full bg-purple-500 rounded-full transition-all duration-500"
                  style={{ width: `${(stats.strength / maxStat) * 100}%` }}
                />
              </div>
              <span className="font-bold text-gray-700 w-8 text-sm">
                {stats.strength}
              </span>
            </div>

            {/* Defence */}
            <div className="flex items-center gap-3">
              <span className="font-bold text-gray-800 w-6 text-right">D:</span>
              <div className="flex-1 bg-gray-200 rounded-full h-5 overflow-hidden border-2 border-gray-400">
                <div
                  className="h-full bg-purple-500 rounded-full transition-all duration-500"
                  style={{ width: `${(stats.defence / maxStat) * 100}%` }}
                />
              </div>
              <span className="font-bold text-gray-700 w-8 text-sm">
                {stats.defence}
              </span>
            </div>

            {/* Movement */}
            <div className="flex items-center gap-3">
              <span className="font-bold text-gray-800 w-6 text-right">M:</span>
              <div className="flex-1 bg-gray-200 rounded-full h-5 overflow-hidden border-2 border-gray-400">
                <div
                  className="h-full bg-purple-500 rounded-full transition-all duration-500"
                  style={{ width: `${(stats.movement / maxStat) * 100}%` }}
                />
              </div>
              <span className="font-bold text-gray-700 w-8 text-sm">
                {stats.movement}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <p className="text-red-300 font-bold text-sm mb-4 text-center">
          {error}
        </p>
      )}

      {/* Create button */}
      <button
        onClick={handleCreate}
        disabled={createPetMutation.isPending}
        className="w-full max-w-xl color-btn bg-legacytheme-green hover:bg-legacytheme-green-dark text-xl disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {createPetMutation.isPending ? 'Creating...' : 'CREATE'}
      </button>
    </div>
  );
}
