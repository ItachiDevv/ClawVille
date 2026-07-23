'use client';

/**
 * activity-audio.ts — shared SFX bus for Q2 Activity Portals (chunk #12).
 *
 * One module-singleton AudioContext (lazy-allocated on first user-gesture
 * `prime()` call so iOS Safari / Chrome autoplay policies don't reject our
 * playback). Sounds are decoded once, cached as `AudioBuffer`s, and played
 * through transient `BufferSource`s — no `<audio>` element pool, no DOM
 * thrash, no `play()` race conditions.
 *
 * Spec: `.claude/plans/q2-research/frontend-spec.md` §12.2.
 *
 * API:
 *   preloadActivitySounds(names?)  — eager-decode a subset before playback
 *   primeActivitySounds()          — call inside a user-gesture handler to
 *                                    unlock the AudioContext (iOS / autoplay)
 *   playActivitySound(name, opts?) — best-effort fire-and-forget; silent
 *                                    no-op when reduced-motion is set, the
 *                                    asset 404'd, the context is suspended,
 *                                    or the user muted via `setMuted(true)`
 *   playActivitySynthCue(name)      — event-edge oscillator cue through the
 *                                    same context/master/mute policy
 *   setMuted(b)                    — global mute toggle
 *   getMuted()                     — current mute state
 *   isReducedMotion()              — true when user prefers reduced motion
 *
 * Asset gap: chunk #12 ships placeholder silent WAV files at
 * /public/sounds/activity/<name>.wav so audio elements don't 404 in
 * production. Real CC0 assets need a separate licensing pass before launch.
 */

export type ActivitySoundName =
  | 'countdown-tick'
  | 'round-start'
  | 'knockout'
  | 'lap-chime'
  | 'pb-chime'
  | 'item-pickup'
  | 'item-use'
  | 'defeat'
  | 'victory-fanfare'
  | 'placement-silver'
  | 'placement-bronze';

export type ActivitySynthCueName = 'item-hit' | 'swap-warning' | 'wrong-way';

const ALL_SOUND_NAMES: readonly ActivitySoundName[] = Object.freeze([
  'countdown-tick',
  'round-start',
  'knockout',
  'lap-chime',
  'pb-chime',
  'item-pickup',
  'item-use',
  'defeat',
  'victory-fanfare',
  'placement-silver',
  'placement-bronze',
]);

/** Per-sound output level (0–1). Tuned so quieter SFX don't drown out music. */
const SOUND_VOLUME: Record<ActivitySoundName, number> = {
  'countdown-tick': 0.4,
  'round-start': 0.55,
  'knockout': 0.6,
  'lap-chime': 0.5,
  'pb-chime': 0.6,
  'item-pickup': 0.45,
  'item-use': 0.5,
  'defeat': 0.55,
  'victory-fanfare': 0.7,
  'placement-silver': 0.6,
  'placement-bronze': 0.55,
};

interface AudioState {
  ctx: AudioContext | null;
  master: GainNode | null;
  buffers: Map<ActivitySoundName, AudioBuffer | null>;
  loading: Map<ActivitySoundName, Promise<AudioBuffer | null>>;
  muted: boolean;
}

const state: AudioState = {
  ctx: null,
  master: null,
  buffers: new Map(),
  loading: new Map(),
  muted: false,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (state.ctx) return state.ctx;
  // Webkit prefix only matters on older Safari; modern iOS supports the
  // standard constructor as of iOS 14.5.
  const Ctor: typeof AudioContext | undefined =
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    state.ctx = new Ctor();
    state.master = state.ctx.createGain();
    state.master.gain.value = 0.85;
    state.master.connect(state.ctx.destination);
  } catch {
    state.ctx = null;
    state.master = null;
  }
  return state.ctx;
}

export function isReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

async function loadBuffer(name: ActivitySoundName): Promise<AudioBuffer | null> {
  const cached = state.buffers.get(name);
  if (cached !== undefined) return cached;

  const inflight = state.loading.get(name);
  if (inflight) return inflight;

  const ctx = getCtx();
  if (!ctx) return null;

  const url = `/sounds/activity/${name}.wav`;
  const promise = (async () => {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) {
        // 404 / network error — cache the miss so we don't retry on every play.
        state.buffers.set(name, null);
        return null;
      }
      const arr = await res.arrayBuffer();
      // Some browsers (older Safari) require the callback form. The promise
      // form is standard since 2018; we wrap defensively just in case.
      const buf = await new Promise<AudioBuffer>((resolve, reject) => {
        try {
          const ret = ctx.decodeAudioData(arr.slice(0), resolve, reject);
          if (ret && typeof (ret as Promise<AudioBuffer>).then === 'function') {
            (ret as Promise<AudioBuffer>).then(resolve, reject);
          }
        } catch (err) {
          reject(err);
        }
      });
      state.buffers.set(name, buf);
      return buf;
    } catch {
      state.buffers.set(name, null);
      return null;
    } finally {
      state.loading.delete(name);
    }
  })();

  state.loading.set(name, promise);
  return promise;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Eagerly preload a subset (or all) of the activity SFX. Returns immediately
 * if called server-side or in a reduced-motion environment.
 */
export function preloadActivitySounds(names?: readonly ActivitySoundName[]): void {
  if (typeof window === 'undefined') return;
  if (isReducedMotion()) return;
  // Don't actually create the AudioContext here — that requires a user
  // gesture on iOS. We just kick off the fetch+decode lazily once `prime`
  // has run. If `prime` hasn't been called yet, decoding will fail until
  // a gesture happens, which is fine.
  if (!state.ctx) return;
  const list = names ?? ALL_SOUND_NAMES;
  for (const name of list) {
    void loadBuffer(name);
  }
}

/**
 * MUST be called from a user-gesture handler (click, touchstart, keydown)
 * the first time the user interacts with the activity surface. Creates the
 * AudioContext if needed and resumes it (iOS / autoplay-policy unlock).
 */
export function primeActivitySounds(): void {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {
      /* user denied — silent */
    });
  }
  // Now the context is alive, eagerly fetch all the SFX so the first play
  // doesn't pay decode latency.
  preloadActivitySounds();
}

export function setMuted(next: boolean): void {
  state.muted = !!next;
  if (state.master) {
    state.master.gain.value = state.muted ? 0 : 0.85;
  }
}

export function getMuted(): boolean {
  return state.muted;
}

export interface PlayActivitySoundOptions {
  /** Multiplied with per-sound default volume; clamped to [0, 1]. */
  volume?: number;
  /** Playback rate multiplier (pitch + speed). Default 1.0. */
  rate?: number;
}

/**
 * Best-effort fire-and-forget playback. Never throws. Silently no-ops when:
 *   - SSR / no AudioContext available
 *   - prefers-reduced-motion is set
 *   - global mute is on
 *   - the buffer 404'd or failed to decode
 *   - the AudioContext is still suspended (caller forgot `primeActivitySounds`)
 */
export function playActivitySound(
  name: ActivitySoundName,
  opts: PlayActivitySoundOptions = {},
): void {
  if (typeof window === 'undefined') return;
  if (state.muted) return;
  if (isReducedMotion()) return;

  const ctx = state.ctx;
  if (!ctx || ctx.state === 'suspended') return;

  // Kick off async decode if missing — this play won't sound, but the next
  // call will. Acceptable for an SFX bus.
  const buf = state.buffers.get(name);
  if (!buf) {
    void loadBuffer(name);
    return;
  }

  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = clamp(opts.rate ?? 1, 0.25, 4);
    const gain = ctx.createGain();
    const baseVol = SOUND_VOLUME[name] ?? 0.5;
    const userVol = clamp(opts.volume ?? 1, 0, 1);
    gain.gain.value = baseVol * userVol;
    src.connect(gain);
    gain.connect(state.master ?? ctx.destination);
    src.start(0);
    // Best-effort GC: drop nodes ~50ms after expected end. Older buffers may
    // not have `duration` (Safari quirks); fall back to 1.5s.
    const dur = (buf.duration || 1.5) * 1000 + 80;
    setTimeout(() => {
      try {
        src.disconnect();
        gain.disconnect();
      } catch {
        /* already collected */
      }
    }, dur);
  } catch {
    /* swallow — SFX must never break the game */
  }
}

/**
 * Audible fallback cues for mechanics whose packaged WAV slots are still
 * silent placeholders. This is part of the existing activity-audio bus: it
 * reuses the primed AudioContext + master gain and obeys the same mute and
 * reduced-motion policy. Each call owns one oscillator/gain pair and releases
 * both from `onended`; callers must invoke it only on an event edge.
 */
export function playActivitySynthCue(name: ActivitySynthCueName): void {
  if (typeof window === 'undefined') return;
  if (state.muted || isReducedMotion()) return;

  const ctx = state.ctx;
  if (!ctx || ctx.state === 'suspended') return;

  try {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const startAt = ctx.currentTime;
    const isSwapWarning = name === 'swap-warning';
    const isWrongWay = name === 'wrong-way';
    const durationSeconds = isSwapWarning ? .72 : isWrongWay ? .36 : .16;
    const peakGain = isSwapWarning ? .78 : isWrongWay ? .18 : .42;

    oscillator.type = isSwapWarning ? 'sawtooth' : isWrongWay ? 'sine' : 'triangle';
    oscillator.frequency.setValueAtTime(
      isSwapWarning ? 220 : isWrongWay ? 196 : 920,
      startAt,
    );
    if (isWrongWay) {
      oscillator.frequency.setValueAtTime(196, startAt + .15);
      oscillator.frequency.setValueAtTime(147, startAt + .18);
    } else {
      oscillator.frequency.exponentialRampToValueAtTime(
        isSwapWarning ? 72 : 310,
        startAt + durationSeconds,
      );
    }
    gain.gain.setValueAtTime(.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peakGain, startAt + .018);
    if (isWrongWay) {
      gain.gain.exponentialRampToValueAtTime(.0001, startAt + .15);
      gain.gain.exponentialRampToValueAtTime(peakGain * .82, startAt + .19);
    }
    gain.gain.exponentialRampToValueAtTime(.0001, startAt + durationSeconds);

    oscillator.connect(gain);
    gain.connect(state.master ?? ctx.destination);
    oscillator.onended = () => {
      try {
        oscillator.disconnect();
        gain.disconnect();
      } catch {
        /* already collected */
      }
    };
    oscillator.start(startAt);
    oscillator.stop(startAt + durationSeconds + .02);
  } catch {
    /* synthesized SFX must never break the game */
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
