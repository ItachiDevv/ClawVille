'use client';

import { useGameStore } from '@/stores/game';

export default function ToastNotifications() {
  const toasts = useGameStore((s) => s.toasts);
  const removeToast = useGameStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto claw-panel flex items-center gap-3 px-4 py-2 animate-in fade-in slide-in-from-top-2 duration-300 cursor-pointer hover:brightness-105"
          onClick={() => removeToast(toast.id)}
        >
          <span className="text-xl">{toast.icon}</span>
          {/* text-cyan-50 (#ecfeff) on .claw-panel (rgba(10,22,40,0.92) → rgba(6,13,23,0.96)) gives
              ~14:1 contrast ratio — well above WCAG AAA 7:1 for normal text. NEVER use text-gray-700/
              800/900 inside .claw-panel — those tokens are <2:1 contrast = unreadable on the dark navy
              background. See [[feedback_no_dark_text_on_dark_panel]] memory. */}
          <span className="text-sm font-bold text-cyan-50">{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
