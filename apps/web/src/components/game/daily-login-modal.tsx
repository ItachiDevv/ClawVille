'use client';

import { useEffect, useState } from 'react';
import { useGameStore, type GameState } from '@/stores/game';
import { api } from '@/lib/api';

export default function DailyLoginModal() {
  const dailyLoginClaimed = useGameStore((s: GameState) => s.dailyLoginClaimed);
  const setDailyLoginClaimed = useGameStore((s: GameState) => s.setDailyLoginClaimed);
  const [show, setShow] = useState(false);
  const [streak, setStreak] = useState(0);
  const [tokensEarned, setTokensEarned] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (dailyLoginClaimed) return;

    api.claimDailyLogin()
      .then((res) => {
        setStreak(res.streak);
        setTokensEarned(res.tokensEarned);
        setTotalTokens(res.totalTokens);
        setDemo(!!res.demo);
        setDailyLoginClaimed(true, res.streak);

        // A2 (2026-07-07): the daily-login CT reward was retired (founder killed
        // the biggest faucet). When the server reports `retired`, suppress the
        // reward modal entirely — no phantom "+0" popup on every game load.
        if (!res.alreadyClaimed && !res.retired) {
          setShow(true);
        }
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [dailyLoginClaimed, setDailyLoginClaimed]);

  if (!show || loading) return null;

  // Milestones
  const milestones = [
    { day: 7, label: '7-Day Bonus', bonus: '+50 vCLAW' },
    { day: 14, label: '2-Week Bonus', bonus: '+100 vCLAW' },
    { day: 30, label: '30-Day Bonus', bonus: '+250 vCLAW' },
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="claw-panel w-80 max-w-[90vw] text-center">
        {/* Header */}
        <div className="text-2xl mb-1">&#x1f381;</div>
        <h2 className="text-lg font-bold text-white mb-1">
          Day {streak} Reward!
        </h2>
        <p className="text-sm text-white/70 mb-3">
          Login streak: {streak} {streak === 1 ? 'day' : 'days'}
        </p>

        {/* Reward */}
        <div className="bg-cyan-500/10 rounded-lg px-4 py-3 mb-3 border-2 border-cyan-400/40 shadow-[0_0_20px_rgba(0,229,255,0.15)]">
          {demo ? (
            // Guests run an all-demo economy — no real CT is credited, so show a
            // sign-up prompt INSTEAD of a phantom "+N" reward (tokensEarned is 0).
            <div className="text-base font-bold text-amber-200">
              Sign up to earn real vCLAW
            </div>
          ) : (
            <>
              <div className="text-3xl font-bold text-cyan-200">
                +{tokensEarned} &#x1fa99;
              </div>
              <div className="text-xs text-cyan-300/70 mt-1">
                vCLAW earned! Total: {totalTokens}
              </div>
            </>
          )}
        </div>

        {/* Streak milestones */}
        <div className="space-y-1.5 mb-4">
          {milestones.map((m) => (
            <div
              key={m.day}
              className={`flex items-center justify-between text-xs px-3 py-1.5 rounded ${
                streak >= m.day
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-400/25'
                  : 'bg-white/[0.04] text-white/40 border border-white/[0.06]'
              }`}
            >
              <span className="font-bold">{m.label}</span>
              <span>{streak >= m.day ? '\u2713' : m.bonus}</span>
            </div>
          ))}
        </div>

        {/* Dismiss */}
        <button
          onClick={() => setShow(false)}
          className="w-full py-2 rounded-lg bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white font-bold text-sm transition-colors shadow-[0_0_20px_rgba(0,229,255,0.25)]"
        >
          Collect & Continue
        </button>
      </div>
    </div>
  );
}
