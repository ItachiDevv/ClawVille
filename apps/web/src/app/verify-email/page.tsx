'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

const LandingScene = dynamic(() => import('@/components/three/LandingScene'), { ssr: false });

// Tiny client shell — its only job is to read `?token=` and hand it
// to the API endpoint which does the work and 302s. We use the API
// origin directly (not the Next.js rewrite) so the server-side
// redirect lands the browser on /game?verified=1 with the cookie
// preserved. The token URL hits a same-eTLD+1 API in prod
// (api.clawville.world ↔ clawville.world) so credentials carry.
function VerifyEmailRedirector() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const t = searchParams.get('token');
    if (!t || t.length < 16) {
      window.location.replace('/?error=verify-failed');
      return;
    }
    // Build the API URL the same way `api.ts` does. We use a full
    // navigation (not fetch) so the API's 302 + Referrer-Policy
    // headers drive the next page load — the API sets users
    // .emailVerified and 302s straight to /game?verified=1.
    const apiBase = process.env.NEXT_PUBLIC_API_URL || '';
    const verifyUrl = `${apiBase}/api/auth/verify-email?t=${encodeURIComponent(t)}`;
    window.location.replace(verifyUrl);
  }, [searchParams]);

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="relative bg-[#0a1628]/95 border border-cyan-500/20 rounded-2xl p-8 backdrop-blur-xl shadow-[0_0_40px_rgba(0,229,255,0.08)] text-center">
        <h1 className="font-clawville text-2xl text-cyan-300 mb-3 animate-pulse">
          Confirming your email…
        </h1>
        <p className="text-white/60 text-sm font-mono">One second.</p>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-12 bg-[#061520]">
      <LandingScene />
      <div className="relative z-10 w-full">
        <Suspense fallback={
          <div className="bg-[#0a1628]/90 border border-cyan-500/20 rounded-2xl max-w-md w-full mx-auto p-8 text-center backdrop-blur-xl">
            <p className="font-clawville text-xl text-cyan-400/60 animate-pulse">Loading...</p>
          </div>
        }>
          <VerifyEmailRedirector />
        </Suspense>
      </div>
    </div>
  );
}
