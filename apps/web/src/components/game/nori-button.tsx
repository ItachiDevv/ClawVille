'use client';

/**
 * NoriButton — always-visible HUD shortcut for opening the Town Guide chat.
 *
 * Two visual states:
 *
 *   - **Far** (default): subtle pink pill, label "Ask Nori"
 *   - **Near** (player within NORI_TALK_RADIUS): stronger glow + pulse
 *     + label "Talk to Nori" — mirrors the proximity affordance the 10
 *     building characters get when you walk up to them.
 *
 * Click → openGuideChat() (same path the 3D click handler uses).
 *
 * Hidden when:
 *   - guide chat already open (no-op)
 *   - location chat open (mutually exclusive)
 *   - inside an activity room (gameplay surface owns the screen)
 */

import { useGameStore } from '@/stores/game';

export default function NoriButton() {
  const guideChatOpen   = useGameStore((s) => s.guideChatOpen);
  const chatOpen        = useGameStore((s) => s.chatOpen);
  const activityLobbyId = useGameStore((s) => s.activityLobbyId);
  const nearGuide       = useGameStore((s) => s.nearGuide);
  const openGuideChat   = useGameStore((s) => s.openGuideChat);

  if (guideChatOpen || chatOpen || activityLobbyId) return null;

  return (
    <button
      type="button"
      onClick={openGuideChat}
      title="Ask Nori — your Town Guide"
      aria-label={nearGuide ? 'Talk to Nori the Town Guide' : 'Ask Nori the Town Guide'}
      className={`fixed top-4 right-4 z-40 group flex items-center gap-2 rounded-full
                  border bg-black/70 backdrop-blur-md px-3 py-2 transition-all
                  ${nearGuide
                    ? 'border-pink-300/80 shadow-[0_0_36px_rgba(236,72,153,0.55)] scale-105 animate-pulse'
                    : 'border-pink-400/40 shadow-[0_0_24px_rgba(236,72,153,0.25)] hover:border-pink-300/70 hover:bg-black/85 hover:shadow-[0_0_32px_rgba(236,72,153,0.4)]'}
      `}
    >
      <span className="text-lg leading-none" aria-hidden>💗</span>
      <span
        className={`font-mono text-[10px] uppercase tracking-[0.2em] transition-colors ${
          nearGuide ? 'text-pink-100' : 'text-pink-200/85 group-hover:text-pink-100'
        }`}
      >
        {nearGuide ? 'Talk to Nori' : 'Ask Nori'}
      </span>
    </button>
  );
}
