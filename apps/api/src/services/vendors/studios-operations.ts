/**
 * Studios operation registry (MCP hub phase 3b). ONE table says, per
 * operation: the modes it allows, how its input is checked, how the request
 * is built, where the price comes from, which per-day count bounds it, how
 * much media it may store, and how its reply is read.
 *
 *   image            wallet (x402) + key. The phase 2b behaviour, unchanged.
 *   video            wallet (x402) + key. Studios holds the call open up to
 *                    5 minutes, so it runs in the background runner.
 *   character_shots  key only (Studios takes no x402 on /images/characters).
 *   recast           key only; asynchronous (start, then poll the job).
 *
 * Price source: in wallet mode the x402 quote, checked against the human's
 * per-call cap, the signed amount and the operation's hard ceiling below. In
 * key mode Studios bills the human's own credits; ClawVille moves no money and
 * the human's per-day count for the class bounds it.
 *
 * Every reader returns OUR fields only. Vendor text (names, descriptions,
 * notes, error messages) never leaves this module: ids are kept only when
 * they match a strict pattern, and numbers only when finite.
 */

import { z } from 'zod';
import {
  STUDIOS_CHARACTER_SHOTS_PER_DAY_DEFAULT,
  STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT,
  STUDIOS_RECASTS_PER_DAY_DEFAULT,
  STUDIOS_VIDEOS_PER_DAY_DEFAULT,
  type SpendPolicyView,
  type StudiosOperationId,
} from '@clawville/shared';
import {
  STUDIOS_API_BASE,
  STUDIOS_IMAGE_MODELS,
  STUDIOS_MAX_CALL_ATOMIC,
  STUDIOS_PROMPT_MAX,
  buildStudiosImageRequest,
  parseStudiosImage,
} from './studios';

export type StudiosMode = 'wallet' | 'account';

/** The only host ClawVille downloads Studios results from (docs.md names no other). */
export const STUDIOS_ORIGIN = 'https://mystudios.fun';
export const STUDIOS_HOST = 'mystudios.fun';
/** Where video results live (docs.md, POST /videos/generations: "prepend https://mystudios.fun"). */
export const STUDIOS_ARTIFACT_PREFIX = '/api/v1/media/artifacts/';

const MB = 1024 * 1024;
export const IMAGE_MAX_BYTES = 8 * MB;
export const VIDEO_MAX_BYTES = 50 * MB;

/** Hard ceiling for one x402 video call ($3.00). The human's per-call cap applies first. */
export const STUDIOS_VIDEO_MAX_CALL_ATOMIC = 3_000_000n;
/** The cheapest video model on the menu (2026-11-06: $0.20 list per 5 s render). */
export const STUDIOS_VIDEO_DEFAULT_MODEL = 'minimax-h3-max-turbo';
/** Character shot models (docs.md, POST /images/characters `model`). */
export const STUDIOS_CHARACTER_MODELS = [
  'gpt-image-2',
  'nano-banana-2-1',
  'gpt-image-2-6-flare',
  'gpt-image-2-6-sunburst',
  'gpt-image-2-5-flare',
  'gpt-image-2-5-sunburst',
  'nano-banana-pro',
  'seedream-5-pro',
  'seedream-5-flash',
] as const;
export const STUDIOS_CHARACTER_SHOTS = ['sheet', 'headshot', 'full_body'] as const;
export type StudiosCharacterShot = (typeof STUDIOS_CHARACTER_SHOTS)[number];

// ---------------------------------------------------------------------------
// Input URLs from an agent or a human (Studios fetches them; we never do)
// ---------------------------------------------------------------------------

export const MEDIA_URL_MAX = 2048;
const BLOCKED_SUFFIXES = [
  'localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'home.arpa', 'onion', 'test', 'invalid', 'example',
  // Wildcard-DNS services: any name under them resolves to the IP written in
  // the name (127.0.0.1.nip.io) or to loopback (localtest.me, lvh.me).
  'nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me',
];

/**
 * A strict https URL for an input image or clip, or null. Our server never
 * fetches it (Studios does), but it must still not point at a private host:
 * https only, port 443, no user info, a DNS name (no IP literal of any form,
 * v4 or v6), at least two labels, no private-use suffix, no wildcard-DNS
 * service, a letter TLD, and at most 2048 characters. Returns the normalized
 * URL.
 *
 * Limit: this is a check of the text only. What the name resolves to when
 * Studios fetches it, and any redirect Studios follows, cannot be fully
 * checked from our side. So the Studios operations accept only the narrower
 * `validateStudiosInputUrl` below.
 */
export function validateMediaInputUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length < 12 || value.length > MEDIA_URL_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.length > 253 || host.includes(':') || host.startsWith('[')) return null;
  // The URL parser turns every IPv4 form (0x7f.1, 2130706433) into dotted digits.
  if (/^[0-9.]+$/.test(host)) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  const tld = labels[labels.length - 1]!;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return null;
  if (BLOCKED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  if (url.href.length > MEDIA_URL_MAX) return null;
  return url.href;
}

/** Our public API hosts; an input on them must be one stored item of ours. */
export const OWN_MEDIA_HOSTS = ['api.clawville.world', 'api-staging.clawville.world'] as const;
const OWN_MEDIA_PATH_RE = /^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The only input URLs a Studios operation takes (REST route, MCP tool and
 * hosted verb all use the same schemas; Codex review 2026-11-06): a URL that
 * passes `validateMediaInputUrl` AND is either one of our own stored items
 * (`https://<our API host>/api/media/<uuid>`, no query or fragment) or on the
 * Studios host itself. No third-party host, so no name we cannot vouch for
 * reaches Studios' fetcher. Returns the normalized URL or null.
 */
export function validateStudiosInputUrl(raw: unknown): string | null {
  const href = validateMediaInputUrl(raw);
  if (!href) return null;
  const url = new URL(href);
  const host = url.hostname.toLowerCase();
  if (host === STUDIOS_HOST) return href;
  if ((OWN_MEDIA_HOSTS as readonly string[]).includes(host) && OWN_MEDIA_PATH_RE.test(url.pathname) && !url.search && !url.hash) {
    return href;
  }
  return null;
}

const mediaUrl = z.string().max(MEDIA_URL_MAX).transform((value, ctx) => {
  const ok = validateStudiosInputUrl(value);
  if (!ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'media_url_invalid' });
    return z.NEVER;
  }
  return ok;
});

const menuId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const prompt = z.string().trim().min(1).max(STUDIOS_PROMPT_MAX);

// ---------------------------------------------------------------------------
// Input schemas (REST bodies, MCP tool inputs and hosted verbs all use these)
// ---------------------------------------------------------------------------

export const imageParamsSchema = z.object({
  prompt,
  model: z.enum(STUDIOS_IMAGE_MODELS).optional(),
}).strict();

export const videoParamsSchema = z.object({
  prompt,
  /** A video model id from GET /options/media-models; Studios answers 400 (uncharged) for an unknown one. */
  model: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/).optional(),
  /** Start frame (image_to_video). */
  imageUrl: mediaUrl.optional(),
  durationSeconds: z.number().int().min(1).max(30).optional(),
  resolution: z.enum(['480p', '720p', '768p', '1080p']).optional(),
  aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/).optional(),
  audio: z.boolean().optional(),
}).strict();

export const characterParamsSchema = z.object({
  shots: z.array(z.enum(STUDIOS_CHARACTER_SHOTS)).min(1).max(3).optional()
    .transform((shots) => (shots ? [...new Set(shots)] : undefined)),
  /** Builder picks: section id -> option id or a list of them. */
  picks: z.record(menuId, z.union([menuId, z.array(menuId).min(1).max(8)]))
    .refine((picks) => Object.keys(picks).length <= 24, { message: 'too_many_picks' })
    .optional(),
  random: z.boolean().optional(),
  prompt: prompt.optional(),
  imageUrl: mediaUrl.optional(),
  imageKind: z.enum(['photo', 'headshot', 'full_body', 'sheet']).optional(),
  style: menuId.optional(),
  model: z.enum(STUDIOS_CHARACTER_MODELS).optional(),
  quality: z.enum(['low', 'medium', 'high']).optional(),
  // 4K is left out: a 4K shot can pass the 8 MB image limit after the key paid.
  resolution: z.enum(['1K', '2K']).optional(),
}).strict().refine(
  (p) => p.picks !== undefined || p.random === true || p.prompt !== undefined || p.imageUrl !== undefined,
  { message: 'describe_the_character' },
);

export const recastParamsSchema = z.object({
  preset: menuId.optional(),
  /** Your own clip instead of a preset (mp4, mov or webm, at most 15 s are used). */
  videoUrl: mediaUrl.optional(),
  imageUrls: z.array(mediaUrl).min(1).max(4),
  direction: z.string().trim().min(1).max(500).optional(),
  resolution: z.enum(['480p', '720p', '1080p']).optional(),
}).strict().refine((p) => (p.preset === undefined) !== (p.videoUrl === undefined), { message: 'preset_or_video_url' });

export type ImageParams = z.infer<typeof imageParamsSchema>;
export type VideoParams = z.infer<typeof videoParamsSchema>;
export type CharacterParams = z.infer<typeof characterParamsSchema>;
export type RecastParams = z.infer<typeof recastParamsSchema>;
export type StudiosParams = ImageParams | VideoParams | CharacterParams | RecastParams;

export interface StudiosRequestSpec {
  method: 'POST';
  url: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** One media item in a vendor reply, before it is checked and stored. */
export type MediaSource = { slot: string; base64: string } | { slot: string; url: string };

/** The per-day count field of the human's spend rules for one operation. */
export type LimitField = 'studiosKeyImagesPerDay' | 'studiosVideosPerDay' | 'studiosCharacterShotsPerDay' | 'studiosRecastsPerDay';

export interface StudiosOperationDef {
  id: StudiosOperationId;
  /** The word the approval message and the result lines use. */
  label: string;
  modes: readonly StudiosMode[];
  /** Runs in the background runner (the route answers 202 'running'). */
  long: boolean;
  schema: z.ZodType<StudiosParams, z.ZodTypeDef, unknown>;
  /** wallet = the x402 quote (with `maxCallAtomic` as the ceiling); account = the human's Studios credits. */
  priceSource: { wallet: 'x402_quote' | null; account: 'studios_credits' };
  /** Hard ceiling for one x402 call; null when the operation has no wallet mode. */
  maxCallAtomic: bigint | null;
  limit: { field: LimitField; defaultPerDay: number; modes: readonly StudiosMode[] };
  /** Fixed per-avatar daily cap for the hosted [ACTION:] verb (every autonomous money verb has one). Null = none (image keeps its phase 2b rules). */
  hostedPerDay: number | null;
  /** Most media bytes one call may store (the quota reserve). */
  reserveBytes: (params: StudiosParams) => number;
  /** Largest vendor JSON reply we read. */
  replyMaxBytes: number;
  /** Time limit for the call that makes the media. */
  callTimeoutMs: number;
  /**
   * Key mode: true only for an HTTP status that docs.md marks as NOT charged
   * for this endpoint (the reply is then `vendor_refused`, nothing paid).
   * 401/403 (key) and 402 (credits) are refusals for every endpoint. Every
   * other status, a timeout, a network error and an unreadable 2xx is
   * `outcome_unknown` (the key may have paid; never retried).
   */
  unchargedStatus: (status: number) => boolean;
  /** The text kept in `vendor_call_requests.prompt` ('' when the operation has none). */
  promptOf: (params: StudiosParams) => string;
  modelOf: (params: StudiosParams) => string | null;
  build: (params: StudiosParams, ctx: { requestId: string }) => StudiosRequestSpec;
  /** Media sources of a finished reply (sync operations and video). */
  readMedia: (json: unknown) => MediaSource[];
}

const REPLY_12_MB = 12 * MB;

function str(value: unknown, re: RegExp): string | null {
  return typeof value === 'string' && re.test(value) ? value : null;
}

const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;
const MAX_BASE64_CHARS = 12 * MB;

function base64Of(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE64_CHARS) return null;
  return BASE64_RE.test(value) ? value.replace(/\s+/g, '') : null;
}

/** A result URL we may download: an artifact path or an absolute https URL (the host check runs at download). */
function urlOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MEDIA_URL_MAX) return null;
  return value;
}

export const STUDIOS_OPERATIONS: Record<StudiosOperationId, StudiosOperationDef> = {
  image: {
    id: 'image',
    label: 'image',
    modes: ['wallet', 'account'],
    long: false,
    schema: imageParamsSchema,
    priceSource: { wallet: 'x402_quote', account: 'studios_credits' },
    maxCallAtomic: STUDIOS_MAX_CALL_ATOMIC,
    // Images keep the phase 2b rule: the count bounds the human's own key only.
    limit: { field: 'studiosKeyImagesPerDay', defaultPerDay: STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT, modes: ['account'] },
    hostedPerDay: null,
    reserveBytes: () => IMAGE_MAX_BYTES,
    replyMaxBytes: REPLY_12_MB,
    callTimeoutMs: 120_000,
    // docs.md, POST /api/v1/images/generations: "A request that fails
    // moderation (422), is invalid (4xx), or fails upstream (502) is not charged."
    unchargedStatus: (status) => (status >= 400 && status < 500) || status === 502,
    promptOf: (p) => (p as ImageParams).prompt,
    modelOf: (p) => (p as ImageParams).model ?? null,
    build: (p) => ({ method: 'POST', ...buildStudiosImageRequest(p as ImageParams) }),
    // Phase 2b: base64 only; a reply with only a link is image_missing.
    readMedia: (json) => {
      const image = parseStudiosImage(json);
      return image ? [{ slot: 'image', base64: image.imageBase64 }] : [];
    },
  },
  video: {
    id: 'video',
    label: 'video',
    modes: ['wallet', 'account'],
    long: true,
    schema: videoParamsSchema,
    priceSource: { wallet: 'x402_quote', account: 'studios_credits' },
    maxCallAtomic: STUDIOS_VIDEO_MAX_CALL_ATOMIC,
    limit: { field: 'studiosVideosPerDay', defaultPerDay: STUDIOS_VIDEOS_PER_DAY_DEFAULT, modes: ['wallet', 'account'] },
    hostedPerDay: 2,
    reserveBytes: () => VIDEO_MAX_BYTES,
    replyMaxBytes: 1 * MB,
    // Studios waits up to 5 minutes for the render.
    callTimeoutMs: 330_000,
    // docs.md, POST /api/v1/videos/generations: "A render that fails or times
    // out returns 502 and is not charged; so is a request that fails
    // moderation (422) or is invalid (4xx)."
    unchargedStatus: (status) => (status >= 400 && status < 500) || status === 502,
    promptOf: (p) => (p as VideoParams).prompt,
    modelOf: (p) => (p as VideoParams).model ?? STUDIOS_VIDEO_DEFAULT_MODEL,
    build: (raw) => {
      const p = raw as VideoParams;
      const body: Record<string, unknown> = { model: p.model ?? STUDIOS_VIDEO_DEFAULT_MODEL, prompt: p.prompt };
      if (p.imageUrl) body.image_url = p.imageUrl;
      if (p.durationSeconds !== undefined) body.duration_seconds = p.durationSeconds;
      if (p.resolution) body.resolution = p.resolution;
      if (p.aspectRatio) body.aspect_ratio = p.aspectRatio;
      if (p.audio !== undefined) body.audio = p.audio;
      return { method: 'POST', url: `${STUDIOS_API_BASE}/videos/generations`, body };
    },
    readMedia: (json) => {
      const results = (json as { results?: unknown } | null)?.results;
      const first = Array.isArray(results) ? (results[0] as { url?: unknown } | undefined) : undefined;
      const url = first && typeof first === 'object' ? urlOf(first.url) : null;
      return url ? [{ slot: 'video', url }] : [];
    },
  },
  character_shots: {
    id: 'character_shots',
    label: 'character shots',
    modes: ['account'],
    long: false,
    schema: characterParamsSchema,
    priceSource: { wallet: null, account: 'studios_credits' },
    maxCallAtomic: null,
    limit: { field: 'studiosCharacterShotsPerDay', defaultPerDay: STUDIOS_CHARACTER_SHOTS_PER_DAY_DEFAULT, modes: ['wallet', 'account'] },
    hostedPerDay: 3,
    // The shots asked for, plus the sheet Studios renders as the anchor.
    reserveBytes: (p) => IMAGE_MAX_BYTES * (((p as CharacterParams).shots?.length ?? 1) + 1),
    // Up to four base64 images of at most 8 MB each.
    replyMaxBytes: 48 * MB,
    callTimeoutMs: 180_000,
    // docs.md, POST /api/v1/images/characters names no uncharged status
    // ("If the sheet fails, the call fails and is not charged" gives no status
    // code), so only the key and credit refusals are clear.
    unchargedStatus: () => false,
    promptOf: (p) => (p as CharacterParams).prompt ?? '',
    modelOf: (p) => (p as CharacterParams).model ?? null,
    build: (raw) => {
      const p = raw as CharacterParams;
      const body: Record<string, unknown> = { shots: p.shots ?? ['sheet'] };
      if (p.picks) body.picks = p.picks;
      if (p.random !== undefined) body.random = p.random;
      if (p.prompt) body.prompt = p.prompt;
      if (p.imageUrl) body.image_url = p.imageUrl;
      if (p.imageKind) body.image_kind = p.imageKind;
      if (p.style) body.style = p.style;
      if (p.model) body.model = p.model;
      if (p.quality) body.quality = p.quality;
      body.resolution = p.resolution ?? '1K';
      return { method: 'POST', url: `${STUDIOS_API_BASE}/images/characters`, body };
    },
    readMedia: (json) => {
      const shots = (json as { shots?: unknown } | null)?.shots;
      if (!shots || typeof shots !== 'object' || Array.isArray(shots)) return [];
      const out: MediaSource[] = [];
      for (const slot of STUDIOS_CHARACTER_SHOTS) {
        const shot = (shots as Record<string, unknown>)[slot] as { b64_json?: unknown; url?: unknown } | undefined;
        if (!shot || typeof shot !== 'object') continue;
        const b64 = base64Of(shot.b64_json);
        const url = b64 ? null : urlOf(shot.url);
        if (b64) out.push({ slot, base64: b64 });
        else if (url) out.push({ slot, url });
      }
      return out;
    },
  },
  recast: {
    id: 'recast',
    label: 'recast',
    modes: ['account'],
    long: true,
    schema: recastParamsSchema,
    priceSource: { wallet: null, account: 'studios_credits' },
    maxCallAtomic: null,
    limit: { field: 'studiosRecastsPerDay', defaultPerDay: STUDIOS_RECASTS_PER_DAY_DEFAULT, modes: ['wallet', 'account'] },
    hostedPerDay: 1,
    reserveBytes: () => VIDEO_MAX_BYTES,
    replyMaxBytes: 1 * MB,
    callTimeoutMs: 60_000,
    // docs.md, POST /api/v1/videos/recast: "The clip is checked before
    // anything is charged." Only the input-check refusals (400, 422) are clear.
    unchargedStatus: (status) => status === 400 || status === 422,
    promptOf: (p) => (p as RecastParams).direction ?? '',
    modelOf: (p) => (p as RecastParams).preset ?? null,
    build: (raw, ctx) => {
      const p = raw as RecastParams;
      const body: Record<string, unknown> = { image_urls: p.imageUrls };
      if (p.preset) body.preset = p.preset;
      if (p.videoUrl) body.video_url = p.videoUrl;
      if (p.direction) body.direction = p.direction;
      if (p.resolution) body.resolution = p.resolution;
      // docs.md: on a preset, an Idempotency-Key makes a retried start return
      // the first job. ClawVille never re-sends a start; this is a backstop.
      const headers = p.preset ? { 'Idempotency-Key': `clawville-${ctx.requestId}` } : undefined;
      return { method: 'POST', url: `${STUDIOS_API_BASE}/videos/recast`, body, headers };
    },
    // Recast media comes from the poll reply (readRecastPoll).
    readMedia: () => [],
  },
};

export function studiosOperation(id: string): StudiosOperationDef | null {
  return Object.prototype.hasOwnProperty.call(STUDIOS_OPERATIONS, id) ? STUDIOS_OPERATIONS[id as StudiosOperationId] : null;
}

/** The human's per-day count for this operation, or null when the mode is not counted (images in wallet mode). */
export function perDayLimit(op: StudiosOperationDef, mode: StudiosMode, policy: SpendPolicyView): number | null {
  if (!op.limit.modes.includes(mode)) return null;
  const value = policy[op.limit.field];
  return typeof value === 'number' ? value : op.limit.defaultPerDay;
}

/** JSON with sorted keys, so the same params always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------------------
// Recast job (asynchronous, key mode only)
// ---------------------------------------------------------------------------

const JOB_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const MEDIA_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

/** The job id from the start reply (HTTP 202 `{ id, status, poll }`), or null. */
export function readRecastStart(json: unknown): string | null {
  return str((json as { id?: unknown } | null)?.id, JOB_ID_RE);
}

export function recastPollUrl(jobId: string): string | null {
  return JOB_ID_RE.test(jobId) ? `${STUDIOS_API_BASE}/videos/recast/${jobId}` : null;
}

export type RecastPoll =
  | { state: 'running' }
  | { state: 'failed' }
  | { state: 'succeeded'; sources: MediaSource[]; vendorMediaId: string | null };

/** Our own reading of a poll reply. The vendor's `error` text is dropped. */
export function readRecastPoll(json: unknown): RecastPoll | null {
  if (!json || typeof json !== 'object') return null;
  const reply = json as { status?: unknown; video_url?: unknown; preview_url?: unknown; media_id?: unknown };
  if (reply.status === 'running') return { state: 'running' };
  if (reply.status === 'failed') return { state: 'failed' };
  if (reply.status !== 'succeeded') return null;
  const sources: MediaSource[] = [];
  const full = urlOf(reply.video_url);
  const preview = urlOf(reply.preview_url);
  if (full) sources.push({ slot: 'video', url: full });
  // The lighter copy (at most 1080p) is the fallback when the full clip is too big.
  if (preview) sources.push({ slot: 'video', url: preview });
  return { state: 'succeeded', sources, vendorMediaId: str(reply.media_id, MEDIA_ID_RE) };
}

// ---------------------------------------------------------------------------
// Free menus (no auth to Studios; cached; our fields only)
// ---------------------------------------------------------------------------

export const STUDIOS_MENU_IDS = ['media-models', 'image-styles', 'builder', 'character-presets', 'recast-presets'] as const;
export type StudiosMenuId = (typeof STUDIOS_MENU_IDS)[number];

export const STUDIOS_MENU_PATHS: Record<StudiosMenuId, string> = {
  'media-models': '/media/models',
  'image-styles': '/images/styles',
  builder: '/images/builder',
  'character-presets': '/images/characters/presets',
  'recast-presets': '/videos/recast/presets',
};

const ID_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9:._-]{1,24}$/;

function arr(value: unknown, max = 500): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tokens(value: unknown): string[] {
  return arr(value, 32).filter((v): v is string => typeof v === 'string' && TOKEN_RE.test(v));
}

function withoutNulls<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined)) as T;
}

/**
 * Our own view of one free menu: ids, kinds, prices and option values. Names,
 * descriptions, notes and example images are vendor text and are dropped.
 */
export function mapStudiosMenu(menu: StudiosMenuId, json: unknown): Record<string, unknown> {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  switch (menu) {
    case 'media-models':
      return {
        models: arr(j.models).flatMap((raw) => {
          const m = raw as Record<string, unknown>;
          const id = str(m?.id, ID_RE);
          const kind = m?.kind === 'image' || m?.kind === 'video' ? m.kind : null;
          if (!id || !kind) return [];
          const operations: Record<string, unknown> = {};
          const ops = m.operations && typeof m.operations === 'object' ? m.operations as Record<string, unknown> : {};
          for (const [name, value] of Object.entries(ops).slice(0, 8)) {
            if (!TOKEN_RE.test(name) || !value || typeof value !== 'object') continue;
            const v = value as Record<string, unknown>;
            operations[name] = withoutNulls({ usdPerUnit: num(v.usd_per_unit), listUsdPerUnit: num(v.list_usd_per_unit), audio: v.audio === true ? true : null });
          }
          const o = m.options && typeof m.options === 'object' ? m.options as Record<string, unknown> : {};
          const d = o.duration_seconds && typeof o.duration_seconds === 'object' ? o.duration_seconds as Record<string, unknown> : null;
          return [withoutNulls({
            id,
            kind,
            operations,
            maxReferences: num(m.max_references),
            aspectRatios: tokens(o.aspect_ratio),
            resolutions: tokens(o.resolution),
            qualities: tokens(o.quality),
            durationSeconds: d ? withoutNulls({ min: num(d.min), max: num(d.max), step: num(d.step), default: num(d.default) }) : null,
          })];
        }),
      };
    case 'image-styles':
      return {
        styles: arr(j.styles).flatMap((raw) => {
          const s = raw as Record<string, unknown>;
          const id = str(s?.id, ID_RE);
          const type = s?.type === 'style' || s?.type === 'template' ? s.type : null;
          return id && type ? [{ id, type }] : [];
        }),
      };
    case 'builder':
      return {
        sections: arr(j.sections).flatMap((raw) => {
          const s = raw as Record<string, unknown>;
          const id = str(s?.id, ID_RE);
          if (!id) return [];
          return [withoutNulls({
            id,
            multi: s.multi === true,
            default: str(s.default, ID_RE),
            options: arr(s.options).flatMap((o) => {
              const oid = str((o as Record<string, unknown>)?.id, ID_RE);
              return oid ? [oid] : [];
            }),
          })];
        }),
      };
    case 'character-presets':
      return {
        presets: arr(j.presets).flatMap((raw) => {
          const p = raw as Record<string, unknown>;
          const id = str(p?.id, ID_RE);
          if (!id) return [];
          const sheet = typeof p.sheet_url === 'string' ? validateMediaInputUrl(p.sheet_url) : null;
          return [withoutNulls({
            id,
            species: p.species === 'animal' || p.species === 'person' ? p.species : null,
            // A sheet on Studios' own host can be sent back as imageUrl with imageKind 'sheet'.
            sheetUrl: sheet && new URL(sheet).hostname === STUDIOS_HOST ? sheet : null,
          })];
        }),
      };
    case 'recast-presets': {
      const own = j.own_clip && typeof j.own_clip === 'object' ? j.own_clip as Record<string, unknown> : null;
      return {
        presets: arr(j.presets).flatMap((raw) => {
          const p = raw as Record<string, unknown>;
          const id = str(p?.id, ID_RE);
          if (!id) return [];
          return [withoutNulls({
            id,
            performers: Array.isArray(p.performers) ? Math.min(p.performers.length, 8) : null,
            minImages: num(p.min_images),
            seconds: num(p.seconds),
            priceUsd: num(p.price_usd),
            defaultResolution: str(p.default_resolution, TOKEN_RE),
            resolutions: arr(p.resolutions, 8).flatMap((r) => {
              const rr = r as Record<string, unknown>;
              const rid = str(rr?.id, TOKEN_RE);
              const price = num(rr?.price_usd);
              return rid && price !== null ? [{ id: rid, priceUsd: price }] : [];
            }),
            shape: p.shape === 'tall' || p.shape === 'wide' || p.shape === 'square' ? p.shape : null,
          })];
        }),
        ownClip: own ? withoutNulls({
          maxSeconds: num(own.max_seconds),
          resolutions: arr(own.resolutions, 8).flatMap((r) => {
            const rr = r as Record<string, unknown>;
            const rid = str(rr?.id, TOKEN_RE);
            const price = num(rr?.usd_per_second);
            return rid && price !== null ? [{ id: rid, usdPerSecond: price }] : [];
          }),
        }) : null,
      };
    }
  }
}
