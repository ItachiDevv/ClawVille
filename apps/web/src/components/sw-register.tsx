'use client';

import { useEffect } from 'react';

/**
 * Cold-load rung-4 slice B (2026-08-11): how long we wait for the world's
 * first-paint stamp before sending the SW precache signal anyway. Pages that
 * never boot the world (landing, /cove) have no stamp — the fallback keeps
 * their roster precache working, just deferred past their own critical load.
 */
const PRECACHE_SIGNAL_FALLBACK_MS = 30_000;
const PRECACHE_SIGNAL_POLL_MS = 1_000;
/**
 * ACK/retry handshake (Codex slice-B finding 4): during a v10→v11 upgrade
 * `serviceWorker.ready` can resolve with the OLD worker, which drops the
 * precache message. The page retries until a worker acks, and also resends
 * on controllerchange (the moment the new worker takes over). Bounded so a
 * permanently ack-less environment can't retry forever.
 */
const PRECACHE_ACK_TIMEOUT_MS = 10_000;
const PRECACHE_MAX_ATTEMPTS = 6;

/**
 * Registers the ClawVille service worker (`/sw.js`).
 * Mounts in layout.tsx — fires once after hydration.
 *
 * When the browser detects a new SW waiting to activate (i.e. after a deploy),
 * it calls skipWaiting automatically because the SW itself calls self.skipWaiting()
 * in its install handler. The page will use the new SW on next navigation.
 */
export function SWRegister() {
  useEffect(() => {
    // Breadcrumbs (kept deliberately — registration failures are SILENT and
    // cost days to diagnose; see the 2026-08-11 slice-B session where the
    // organic registration mysteriously never ran in a test browser).
    (window as unknown as { __SW_REGISTER?: string }).__SW_REGISTER = 'effect';
    if (!('serviceWorker' in navigator)) {
      (window as unknown as { __SW_REGISTER?: string }).__SW_REGISTER = 'unsupported';
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    // Slice B (2026-08-11): the SW's roster precache no longer runs at
    // install (it raced the boot's tier-1 fetches with cache bypass — see
    // sw.js v11). The page signals the SW to precache AFTER the world's
    // first paint (`__W3D_DECORATIVE_RELEASED_AT` stamp), or after a 30 s
    // fallback on pages that never boot the world. Repeat signals are cheap
    // (the SW skips already-cached entries), so firing once per page load
    // is fine.
    let acked = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const onAckMessage = (event: MessageEvent) => {
      // The ack must carry the acking worker's version string (S5 hygiene) —
      // an unversioned/malformed ack must not stop the retries. Listeners
      // stay attached for the component's lifetime: a LATER controllerchange
      // (the next SW upgrade in this tab) re-opens the handshake below.
      if (
        event.data?.type === 'clawville:precache-ack' &&
        typeof event.data.version === 'string' &&
        event.data.version.length > 0
      ) {
        acked = true;
        if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      }
    };
    const onControllerChange = () => {
      // A NEW worker just took over (e.g. v10→v11 mid-upgrade, possibly
      // minutes after the signal started — promotion can wait out a busy
      // active worker). The handshake starts OVER for the new worker: acked
      // state and the retry budget RESET (Codex slice-B round-2 finding 3 —
      // routing this through the exhausted budget made the resend a no-op).
      if (cancelled) return;
      acked = false;
      attempts = 0;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      void attemptPrecacheSignal();
    };

    const attemptPrecacheSignal = async () => {
      if (cancelled || acked || attempts >= PRECACHE_MAX_ATTEMPTS) return;
      attempts += 1;
      try {
        // `ready` resolves once an active SW controls this scope — covers
        // the first-visit case where registration is still installing when
        // the stamp lands. During an upgrade it may still be the OLD worker;
        // the ack/retry loop + controllerchange resend cover that.
        const readyReg = await navigator.serviceWorker.ready;
        readyReg.active?.postMessage({ type: 'clawville:precache' });
      } catch {
        // Fall through to the retry below — next page load also re-signals.
      }
      if (cancelled || acked) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void attemptPrecacheSignal();
      }, PRECACHE_ACK_TIMEOUT_MS);
    };

    const sendPrecacheSignal = async () => {
      if (cancelled) return;
      if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
      if (fallbackTimer !== null) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      navigator.serviceWorker.addEventListener('message', onAckMessage);
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      await attemptPrecacheSignal();
    };

    const armPrecacheSignal = () => {
      const released = () =>
        typeof (window as unknown as { __W3D_DECORATIVE_RELEASED_AT?: number })
          .__W3D_DECORATIVE_RELEASED_AT === 'number';
      if (released()) {
        void sendPrecacheSignal();
        return;
      }
      pollTimer = setInterval(() => {
        if (released()) void sendPrecacheSignal();
      }, PRECACHE_SIGNAL_POLL_MS);
      fallbackTimer = setTimeout(() => {
        void sendPrecacheSignal();
      }, PRECACHE_SIGNAL_FALLBACK_MS);
    };

    const register = async () => {
      (window as unknown as { __SW_REGISTER?: string }).__SW_REGISTER = 'registering';
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', {
          // Scope to entire origin — needs to cover /game and /models/**
          scope: '/',
          // Bypass HTTP cache when fetching the sw.js bytes themselves.
          // Default `'imports'` means Chrome HTTP-caches sw.js for the
          // server-set max-age, so a sw.js redeploy can take up to 24 h
          // (Chrome's default update-check interval) to roll out to all
          // existing clients even after the new bytes are on the origin.
          // 'none' makes EVERY registration/update check refetch sw.js
          // bypass-cache, so the moment we ship a new version it lands
          // on the next page load. Standard option, zero compat cost.
          updateViaCache: 'none',
        });

        // Belt-and-suspenders: explicitly poke the browser to recheck the
        // origin for a newer sw.js right now (within the 5 s post-load
        // budget). Without this, Chrome relies entirely on its built-in
        // 24 h heuristic, which means a hot user who hasn't closed their
        // tab in a day misses every same-day deploy.
        try { await reg.update(); } catch { /* non-fatal */ }

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (
              newWorker.state === 'activated' &&
              navigator.serviceWorker.controller
            ) {
              // A new SW just took over. Silent update — no reload prompt needed
              // because the SW uses stale-while-revalidate for JS chunks, so the
              // user won't be broken; they'll pick up new chunks on next nav.
              console.debug('[SW] Updated to new version');
            }
          });
        });
        // Slice B: arm the deferred precache signal only after a successful
        // registration — there is nothing to signal without a SW.
        armPrecacheSignal();
        (window as unknown as { __SW_REGISTER?: string }).__SW_REGISTER = 'registered';
      } catch (err) {
        // Non-fatal — site works fine without the SW
        (window as unknown as { __SW_REGISTER?: string }).__SW_REGISTER = `failed:${String(err).slice(0, 120)}`;
        console.debug('[SW] Registration failed:', err);
      }
    };

    // Defer registration until after the page is interactive to avoid
    // competing with initial resource fetches.
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }

    return () => {
      cancelled = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      navigator.serviceWorker.removeEventListener('message', onAckMessage);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      window.removeEventListener('load', register);
    };
  }, []);

  return null;
}
