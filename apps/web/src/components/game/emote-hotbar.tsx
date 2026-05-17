'use client';

/**
 * Emote hotbar — Fortnite-style 4-slot emote bar.
 *
 * Reads the player's owned cosmetics with category='emote' && equipped=true,
 * shows up to 4 in horizontal slots, and fires `fireEmote(animationKey)` on
 * click. Hotkeys 1-4 trigger the corresponding slot.
 *
 * `animationKey` lives in the variant's assetMeta:
 *   { animationKey: 'flip' | 'dance_breaking' | ... }
 * The key must match an entry in EMOTE_ANIM_NAMES inside vrm-character-animator.ts.
 *
 * Visibility: hidden when no emotes are equipped. Sits above the chat input
 * so it doesn't fight other game HUD.
 *
 * Mobile: the hotbar still works on touch — hotkeys are desktop-only.
 */

import { useEffect, useMemo } from 'react';
import { useOwnedCosmetics, type OwnedCosmetic } from '@/hooks/use-cosmetics';
import { fireEmote } from '@/lib/three/emote-bus';
import {
  isEmoteAnimName,
  preloadClips,
  type AnimName,
} from '@/lib/three/vrm-character-animator';

const SLOT_COUNT = 4;

const EMOTE_ICONS: Record<string, string> = {
  flip: '🤸',
  dance_happy: '🕺',
  dance_breaking: '🪩',
  dance_hiphop: '💃',
  dance_popping: '🎶',
  kiss: '💋',
  fishing: '🎣',
  jump: '🦘',
  spell_cast: '🪄',
  victory: '🏆',
  waving: '👋',
  looking_around: '🧐',
  squat: '🏋️',
  talk: '🗣️',
  rude_gesture: '😤',
  crying: '😭',
  sorrow: '😞',
  fall: '🤕',
  crawling: '🐛',
  wipeout: '💥',
  float: '🧘',
};

interface EquippedEmote {
  avatarSkinId: string;
  displayName: string;
  animationKey: string;
}

function pickAnimationKey(o: OwnedCosmetic): string | null {
  // Prefer the milady-vrm variant; fall back to universal.
  const variant =
    o.variants.find((v) => v.rigType === 'milady-vrm') ??
    o.variants.find((v) => v.rigType === 'universal') ??
    o.variants[0];
  if (!variant) return null;
  const meta = variant.assetMeta ?? {};
  const key = (meta as Record<string, unknown>).animationKey;
  return typeof key === 'string' ? key : null;
}

export default function EmoteHotbar() {
  const { data } = useOwnedCosmetics();

  const equipped: EquippedEmote[] = useMemo(() => {
    const owned = data?.owned ?? [];
    const list: EquippedEmote[] = [];
    for (const o of owned) {
      if (o.sku.category !== 'emote') continue;
      if (!o.equipped) continue;
      const key = pickAnimationKey(o);
      if (!key || !isEmoteAnimName(key)) continue;
      list.push({
        avatarSkinId: o.id,
        displayName: o.sku.displayName,
        animationKey: key,
      });
      if (list.length >= SLOT_COUNT) break;
    }
    return list;
  }, [data]);

  // Warm the GLB cache for the player's equipped emotes the moment we
  // know which ones they are. We no longer eager-preload all 22 emote
  // clips at mount (see vrm-character-animator.ts preloadMixamoClips),
  // so this is the targeted prefetch for the ≤4 the player can actually
  // trigger from the hotbar. Cache is keyed by path, so repeat invocations
  // are free.
  useEffect(() => {
    if (equipped.length === 0) return;
    const names = equipped
      .map((e) => e.animationKey)
      .filter(isEmoteAnimName) as AnimName[];
    if (names.length > 0) preloadClips(names);
  }, [equipped]);

  // Hotkeys 1-4 — fire the corresponding slot. Skip if user is typing
  // (chat input focused) or any other input/textarea/contenteditable owns focus.
  useEffect(() => {
    if (equipped.length === 0) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) {
          return;
        }
      }
      const idx = parseInt(ev.key, 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= equipped.length) return;
      ev.preventDefault();
      fireEmote(equipped[idx].animationKey);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [equipped]);

  if (equipped.length === 0) return null;

  return (
    <div
      className="pointer-events-auto fixed bottom-24 left-1/2 z-[110] -translate-x-1/2 select-none"
      role="toolbar"
      aria-label="Emote hotbar"
    >
      <div className="flex items-center gap-2 rounded-2xl border border-cyan-400/25 bg-[#06152099] px-3 py-2 shadow-[0_4px_16px_rgba(0,229,255,0.15)] backdrop-blur-sm">
        {equipped.map((e, i) => {
          const icon = EMOTE_ICONS[e.animationKey] ?? '✨';
          return (
            <button
              key={e.avatarSkinId}
              type="button"
              onClick={() => fireEmote(e.animationKey)}
              className="group relative flex h-12 w-12 items-center justify-center rounded-xl border border-cyan-400/25 bg-black/40 text-2xl transition-all hover:border-cyan-300/60 hover:bg-cyan-500/15 active:scale-95"
              title={`${e.displayName} (${i + 1})`}
              aria-label={`Play ${e.displayName} emote`}
            >
              <span aria-hidden>{icon}</span>
              <span className="absolute right-0.5 top-0.5 font-mono text-[8px] text-cyan-200/60">
                {i + 1}
              </span>
            </button>
          );
        })}
        {/* Empty slots (visual placeholder) */}
        {Array.from({ length: SLOT_COUNT - equipped.length }).map((_, i) => (
          <div
            key={`empty-${i}`}
            className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-cyan-400/15 bg-black/20 text-cyan-300/20"
            aria-hidden
          >
            <span className="font-mono text-[10px]">{equipped.length + i + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
