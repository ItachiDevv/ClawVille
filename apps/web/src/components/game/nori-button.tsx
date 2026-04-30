'use client';

/**
 * NoriButton — always-visible HUD shortcut for opening the Town Guide chat.
 *
 * Background: Nori (the system-agent at slug `town-guide`) was reachable
 * only by clicking her 3D model in the world. New players couldn't find
 * her, and players who scrolled past her didn't have a way to summon
 * the chat without backtracking. This button mirrors the click-Nori
 * 3D handler — calls `openGuideChat()` from the game store, which the
 * existing `<ChatPanel>` already renders into a `<GuideChatBody>`.
 *
 * Mounted unconditionally on /game (not gated on agent connection) —
 * Nori is the orientation NPC for everyone, including unconnected
 * Players.
 *
 * Hidden when:
 *   - Guide chat already open (would be a no-op)
 *   - Location chat open (mutually exclusive — Nori never coexists
 *     with a building character chat)
 *   - Inside an activity room (gameplay surface owns the screen)
 */

import { useGameStore } from '@/stores/game';

export default function NoriButton() {
  const guideChatOpen   = useGameStore((s) => s.guideChatOpen);
  const chatOpen        = useGameStore((s) => s.chatOpen);
  const activityLobbyId = useGameStore((s) => s.activityLobbyId);
  const openGuideChat   = useGameStore((s) => s.openGuideChat);

  if (guideChatOpen || chatOpen || activityLobbyId) return null;

  return (
    <button
      type="button"
      onClick={openGuideChat}
      title="Ask Nori — your Town Guide"
      aria-label="Talk to Nori the Town Guide"
      className="fixed top-4 right-4 z-40 group flex items-center gap-2 rounded-full
                 border border-pink-400/40 bg-black/70 backdrop-blur-md px-3 py-2
                 shadow-[0_0_24px_rgba(236,72,153,0.25)]
                 hover:border-pink-300/70 hover:bg-black/85 hover:shadow-[0_0_32px_rgba(236,72,153,0.4)]
                 transition-all"
    >
      <span className="text-lg leading-none" aria-hidden>💗</span>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-pink-200/85
                       group-hover:text-pink-100">
        Ask Nori
      </span>
    </button>
  );
}
