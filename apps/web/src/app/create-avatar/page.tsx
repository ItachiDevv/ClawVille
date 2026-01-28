'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useCheckPetName } from '@/hooks/use-avatar';

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
  { id: 'green', label: 'GREEN', bg: '#4CAF50' },
  { id: 'red', label: 'RED', bg: '#F44336' },
  { id: 'blue', label: 'BLUE', bg: '#2196F3' },
  { id: 'yellow', label: 'YELLOW', bg: '#FFD700' },
] as const;

export default function CreatePetPage() {
  const router = useRouter();
  const checkNameMutation = useCheckPetName();

  const [selectedSpecies, setSelectedSpecies] = useState<string>('cat');
  const [selectedColor, setSelectedColor] = useState<string>('green');
  const [avatarName, setPetName] = useState('');
  const [gender, setGender] = useState<string>('male');
  const [nameStatus, setNameStatus] = useState<{
    available: boolean;
    reason?: string;
  } | null>(null);

  // Debounced name check
  useEffect(() => {
    if (!avatarName || avatarName.length < 3) {
      setNameStatus(null);
      return;
    }

    const timer = setTimeout(() => {
      checkNameMutation.mutate(avatarName, {
        onSuccess: (data) => setNameStatus(data),
        onError: () => setNameStatus(null),
      });
    }, 500);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarName]);

  const handleNext = useCallback(() => {
    if (!avatarName || avatarName.length < 3) return;
    if (nameStatus && !nameStatus.available) return;

    sessionStorage.setItem(
      'createPetStep1',
      JSON.stringify({
        species: selectedSpecies,
        color: selectedColor,
        name: avatarName,
        gender,
      })
    );

    router.push('/create-avatar/personality');
  }, [avatarName, nameStatus, selectedSpecies, selectedColor, gender, router]);

  const currentSpecies = SPECIES.find((s) => s.id === selectedSpecies)!;
  const currentColor = COLORS.find((c) => c.id === selectedColor)!;

  return (
    <div className="star-bg min-h-screen flex flex-col items-center px-4 py-6">
      {/* Title */}
      <h1 className="font-legacyapp text-3xl text-white drop-shadow-md mb-4">
        CREATE-A-AVATAR
      </h1>

      {/* Species selector - horizontal scrollable row */}
      <div className="w-full max-w-xl overflow-x-auto pb-2">
        <div className="flex gap-3 min-w-max px-2">
          {SPECIES.map((species) => (
            <button
              key={species.id}
              onClick={() => setSelectedSpecies(species.id)}
              className={`species-card flex flex-col items-center min-w-[80px] bg-white/10 ${
                selectedSpecies === species.id ? 'selected' : ''
              }`}
            >
              <span className="text-3xl">{species.emoji}</span>
              <span className="text-xs font-bold text-white uppercase mt-1">
                {species.name}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Large preview area */}
      <div
        className="w-full max-w-xl aspect-square max-h-[300px] rounded-xl cartoon-border flex items-center justify-center my-4 transition-colors duration-300"
        style={{ backgroundColor: currentColor.bg + '33' }}
      >
        <span className="text-[120px] md:text-[160px] leading-none select-none drop-shadow-lg">
          {currentSpecies.emoji}
        </span>
      </div>

      {/* Color buttons row */}
      <div className="flex gap-2 mb-4">
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

      {/* Bottom yellow panel */}
      <div className="legacytheme-panel w-full max-w-xl space-y-4">
        {/* Species display */}
        <p className="text-center">
          <span className="font-bold text-gray-800 uppercase tracking-wide">
            Species:{' '}
          </span>
          <span className="font-legacyapp text-2xl text-gray-900">
            {currentSpecies.name}
          </span>
        </p>

        {/* Name + Gender row */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label className="block font-bold text-gray-800 mb-1 uppercase text-sm">
              LegacyApp Name
            </label>
            <input
              type="text"
              value={avatarName}
              onChange={(e) => setPetName(e.target.value)}
              maxLength={20}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
              placeholder="Enter a name..."
            />
            {/* Name availability feedback */}
            {avatarName.length >= 3 && nameStatus && (
              <p
                className={`text-sm mt-1 font-bold ${
                  nameStatus.available ? 'text-green-700' : 'text-red-700'
                }`}
              >
                {nameStatus.available
                  ? `The name ${avatarName} is available!`
                  : nameStatus.reason || 'That name is taken'}
              </p>
            )}
            {avatarName.length > 0 && avatarName.length < 3 && (
              <p className="text-sm mt-1 text-gray-600">
                Name must be at least 3 characters
              </p>
            )}
          </div>

          <div className="sm:w-40">
            <label className="block font-bold text-gray-800 mb-1 uppercase text-sm">
              Gender
            </label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
            >
              <option value="male">MALE</option>
              <option value="female">FEMALE</option>
            </select>
          </div>
        </div>

        {/* Next button */}
        <button
          onClick={handleNext}
          disabled={
            !avatarName ||
            avatarName.length < 3 ||
            (nameStatus !== null && !nameStatus.available)
          }
          className="w-full color-btn bg-legacytheme-green hover:bg-legacytheme-green-dark text-xl disabled:opacity-50 disabled:cursor-not-allowed"
        >
          NEXT
        </button>
      </div>
    </div>
  );
}
