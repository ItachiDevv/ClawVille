'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useCheckPetName } from '@/hooks/use-pet';

const SPECIES = [
  { id: 'cat', name: 'Cat', emoji: '\u{1F431}' },
  { id: 'dragon', name: 'Dragon', emoji: '\u{1F409}' },
  { id: 'fox', name: 'Fox', emoji: '\u{1F98A}' },
  { id: 'owl', name: 'Owl', emoji: '\u{1F989}' },
  { id: 'wolf', name: 'Wolf', emoji: '\u{1F43A}' },
  { id: 'bunny', name: 'Bunny', emoji: '\u{1F430}' },
  { id: 'phoenix', name: 'Phoenix', emoji: '\u{1F525}' },
  { id: 'turtle', name: 'Turtle', emoji: '\u{1F422}' },
] as const;

const COLORS = [
  { id: 'green', label: 'GREEN', bg: '#00E676' },
  { id: 'red', label: 'RED', bg: '#FF5252' },
  { id: 'blue', label: 'BLUE', bg: '#42A5F5' },
  { id: 'yellow', label: 'YELLOW', bg: '#FFD700' },
] as const;

export default function CreatePetPage() {
  const router = useRouter();
  const checkNameMutation = useCheckPetName();

  const [selectedSpecies, setSelectedSpecies] = useState<string>('cat');
  const [selectedColor, setSelectedColor] = useState<string>('green');
  const [petName, setPetName] = useState('');
  const [gender, setGender] = useState<string>('male');
  const [nameStatus, setNameStatus] = useState<{
    available: boolean;
    reason?: string;
  } | null>(null);

  useEffect(() => {
    if (!petName || petName.length < 3) {
      setNameStatus(null);
      return;
    }

    const timer = setTimeout(() => {
      checkNameMutation.mutate(petName, {
        onSuccess: (data) => setNameStatus(data),
        onError: () => setNameStatus(null),
      });
    }, 500);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [petName]);

  const handleNext = useCallback(() => {
    if (!petName || petName.length < 3) return;
    if (nameStatus && !nameStatus.available) return;

    sessionStorage.setItem(
      'createPetStep1',
      JSON.stringify({
        species: selectedSpecies,
        color: selectedColor,
        name: petName,
        gender,
      })
    );

    router.push('/create-pet/personality');
  }, [petName, nameStatus, selectedSpecies, selectedColor, gender, router]);

  const currentSpecies = SPECIES.find((s) => s.id === selectedSpecies)!;
  const currentColor = COLORS.find((c) => c.id === selectedColor)!;

  return (
    <div className="star-bg min-h-screen flex flex-col items-center px-4 py-8">
      {/* Title */}
      <h1 className="font-clawville text-3xl text-white drop-shadow-[0_0_16px_rgba(0,229,255,0.3)] mb-2">
        Create Your Agent
      </h1>
      <p className="text-white/40 text-xs font-mono uppercase tracking-widest mb-6">
        Choose species, color, and identity
      </p>

      {/* Species selector */}
      <div className="w-full max-w-xl overflow-x-auto pb-2">
        <div className="flex gap-3 min-w-max px-2">
          {SPECIES.map((species) => (
            <button
              key={species.id}
              onClick={() => setSelectedSpecies(species.id)}
              className={`species-card flex flex-col items-center min-w-[80px] ${
                selectedSpecies === species.id ? 'selected' : ''
              }`}
            >
              <span className="text-3xl">{species.emoji}</span>
              <span className="text-xs font-bold text-white/70 uppercase mt-1">
                {species.name}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Preview area */}
      <div
        className="w-full max-w-xl aspect-square max-h-[280px] rounded-xl border border-white/10 flex items-center justify-center my-4 transition-colors duration-300"
        style={{ backgroundColor: currentColor.bg + '15' }}
      >
        <span className="text-[120px] md:text-[160px] leading-none select-none drop-shadow-lg">
          {currentSpecies.emoji}
        </span>
      </div>

      {/* Color buttons */}
      <div className="flex gap-2 mb-5">
        {COLORS.map((color) => (
          <button
            key={color.id}
            onClick={() => setSelectedColor(color.id)}
            className={`color-btn text-sm ${
              selectedColor === color.id ? 'selected' : ''
            }`}
            style={{ backgroundColor: color.bg }}
          >
            {color.label}
          </button>
        ))}
      </div>

      {/* Config panel */}
      <div className="w-full max-w-xl bg-[#0a1628]/90 border border-cyan-500/20 rounded-2xl p-6 backdrop-blur-xl shadow-[0_0_30px_rgba(0,229,255,0.06)] space-y-4">
        {/* Species display */}
        <p className="text-center">
          <span className="text-white/40 text-xs font-mono uppercase tracking-wider">
            Species:{' '}
          </span>
          <span className="font-clawville text-2xl text-cyan-300">
            {currentSpecies.name}
          </span>
        </p>

        {/* Name + Gender row */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">
              Agent Name
            </label>
            <input
              type="text"
              value={petName}
              onChange={(e) => setPetName(e.target.value)}
              maxLength={20}
              className="w-full px-4 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 focus:shadow-[0_0_12px_rgba(0,229,255,0.1)] transition-all"
              placeholder="Enter a name..."
            />
            {petName.length >= 3 && nameStatus && (
              <p
                className={`text-xs mt-1.5 font-bold ${
                  nameStatus.available ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {nameStatus.available
                  ? `${petName} is available!`
                  : nameStatus.reason || 'That name is taken'}
              </p>
            )}
            {petName.length > 0 && petName.length < 3 && (
              <p className="text-xs mt-1.5 text-white/30 font-mono">
                Name must be at least 3 characters
              </p>
            )}
          </div>

          <div className="sm:w-40">
            <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">
              Gender
            </label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white focus:outline-none focus:border-cyan-500/50 transition-all"
            >
              <option value="male" className="bg-[#0a1628]">MALE</option>
              <option value="female" className="bg-[#0a1628]">FEMALE</option>
            </select>
          </div>
        </div>

        {/* Next button */}
        <button
          onClick={handleNext}
          disabled={
            !petName ||
            petName.length < 3 ||
            (nameStatus !== null && !nameStatus.available)
          }
          className="w-full py-3 rounded-lg font-clawville text-sm uppercase tracking-wider transition-all disabled:opacity-30 disabled:cursor-not-allowed bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white shadow-[0_0_20px_rgba(0,229,255,0.2)] hover:shadow-[0_0_28px_rgba(0,229,255,0.35)]"
        >
          Choose Personality
        </button>
      </div>
    </div>
  );
}
