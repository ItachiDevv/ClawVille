/**
 * Studios operations through the human's Studios sign-in (MCP hub phase 3c,
 * part 2). Maps OUR operation params to the Studios MCP tool inputs, and the
 * tool results back to OUR fields. The MCP transport is
 * `studios-mcp-client.ts`; the pipeline (request row first, approval, limits,
 * runner, lease fencing) is `services/studios-images.ts`.
 *
 * Tool input schemas: the Studios MCP tool list (read 2026-11-06). Every
 * argument object is built from an explicit list of fields per tool, so the
 * client-filled `files` field is never sent, and `start_upload` /
 * `upload_media` are never called (our own public `/api/media/<id>` URLs go
 * as `image_urls`; Studios fetches them).
 *
 * Tool OUTPUT shapes are NOT verified against the live server. Every reader
 * here is strict: a field is kept only when it has the expected type and
 * pattern. A reply that does not match (after a paid tool was sent) is read
 * as `unknown`, and the caller records `outcome_unknown` (never retried).
 * Vendor text is untrusted: descriptions are cut to 200 characters, control
 * characters are removed, and they are returned as plain data only.
 */

import { z } from 'zod';
import type { StudiosOperationId } from '@clawville/shared';
import type { StudiosToolResult } from './studios-mcp-client';
import {
  MEDIA_URL_MAX,
  STUDIOS_CHARACTER_SHOTS,
  STUDIOS_VIDEO_DEFAULT_MODEL,
  type CharacterParams,
  type ImageParams,
  type RecastParams,
  type StudiosParams,
  type VideoParams,
} from './studios-operations';

export type SigninCreateTool = 'create_image' | 'create_video' | 'create_character_shots' | 'recast';

export type SigninToolCall =
  | { ok: true; tool: SigninCreateTool; args: Record<string, unknown> }
  /** A setting with no sign-in equivalent; the request is refused before any call. */
  | { ok: false; field: 'model' | 'resolution' | 'quality' | 'videoUrl' };

/**
 * The tool and its arguments for one operation. Only fields named in the
 * Studios tool schema are set; an absent value is left out.
 */
export function buildSigninToolCall(operation: StudiosOperationId, raw: StudiosParams): SigninToolCall {
  switch (operation) {
    case 'image': {
      const p = raw as ImageParams;
      const args: Record<string, unknown> = { prompt: p.prompt };
      if (p.model) args.model = p.model;
      return { ok: true, tool: 'create_image', args };
    }
    case 'video': {
      const p = raw as VideoParams;
      // The same default model as the key and wallet modes (the cheapest), so
      // the price does not depend on the pay mode.
      const args: Record<string, unknown> = { prompt: p.prompt, model: p.model ?? STUDIOS_VIDEO_DEFAULT_MODEL };
      if (p.imageUrl) args.image_urls = [p.imageUrl];
      if (p.durationSeconds !== undefined) args.duration_seconds = p.durationSeconds;
      if (p.resolution) args.resolution = p.resolution;
      if (p.aspectRatio) args.aspect_ratio = p.aspectRatio;
      if (p.audio !== undefined) args.audio = p.audio;
      return { ok: true, tool: 'create_video', args };
    }
    case 'character_shots': {
      const p = raw as CharacterParams;
      // create_character_shots has no model, quality or resolution input.
      if (p.model) return { ok: false, field: 'model' };
      if (p.quality) return { ok: false, field: 'quality' };
      if (p.resolution) return { ok: false, field: 'resolution' };
      const args: Record<string, unknown> = { shots: p.shots ?? ['sheet'] };
      if (p.picks) {
        // The tool takes a list of option ids per section.
        args.picks = Object.fromEntries(Object.entries(p.picks).map(([section, ids]) => [section, Array.isArray(ids) ? ids : [ids]]));
      }
      if (p.random !== undefined) args.random = p.random;
      if (p.prompt) args.prompt = p.prompt;
      if (p.style) args.style = p.style;
      if (p.imageKind) args.image_kind = p.imageKind;
      if (p.imageUrl) args.image_urls = [p.imageUrl];
      return { ok: true, tool: 'create_character_shots', args };
    }
    case 'recast': {
      const p = raw as RecastParams;
      // The tool takes a preset or a My Media clip id, not a clip URL.
      if (p.videoUrl) return { ok: false, field: 'videoUrl' };
      const args: Record<string, unknown> = { preset: p.preset, image_urls: p.imageUrls };
      if (p.direction) args.direction = p.direction;
      if (p.resolution) args.resolution = p.resolution;
      return { ok: true, tool: 'recast', args };
    }
  }
}

// ---------------------------------------------------------------------------
// Tool results (shapes NOT verified live; strict readers)
// ---------------------------------------------------------------------------

const MAX_TEXT_CHARS = 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The tool's data object: `structuredContent` when it is an object, else the
 * first text content item that parses as a JSON object. Null otherwise.
 */
export function toolPayload(result: Record<string, unknown>): Record<string, unknown> | null {
  if (isPlainObject(result.structuredContent)) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content.slice(0, 16) : [];
  for (const item of content) {
    if (!isPlainObject(item) || item.type !== 'text' || typeof item.text !== 'string') continue;
    if (item.text.length > MAX_TEXT_CHARS) return null;
    try {
      const parsed: unknown = JSON.parse(item.text);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Plain text (vendor prose) is not data.
    }
  }
  return null;
}

export const SIGNIN_JOB_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const jobId = z.string().regex(SIGNIN_JOB_ID_RE);
const mediaId = z.string().regex(MEDIA_ID_RE);
const linkUrl = z.string().min(1).max(MEDIA_URL_MAX);

const mediaItemSchema = z.object({
  media_id: mediaId.optional(),
  id: mediaId.optional(),
  url: linkUrl.nullable().optional(),
  original_url: linkUrl.nullable().optional(),
  shot: z.string().max(32).optional(),
}).passthrough();

const jobSchema = z.object({
  job_id: jobId.optional(),
  status: z.string().max(32).optional(),
  media: z.array(z.unknown()).max(16).optional(),
}).passthrough();

export interface SigninMedia {
  /** The item in the human's Studios My Media, when the reply names it. */
  vendorMediaId: string | null;
  /** Full file first, then the display copy (both expire in about 1 hour). */
  urls: string[];
  /** Character shots: which shot this is, when the reply says so. */
  shot: (typeof STUDIOS_CHARACTER_SHOTS)[number] | null;
}

export type SigninJob =
  | { jobId: string; status: 'running' }
  | { jobId: string | null; status: 'failed' }
  | { jobId: string | null; status: 'finished'; media: SigninMedia[] };

function readMedia(items: unknown[]): SigninMedia[] {
  return items.flatMap((raw) => {
    const item = mediaItemSchema.safeParse(raw);
    if (!item.success) return [];
    const urls = [item.data.original_url, item.data.url].filter((u): u is string => typeof u === 'string');
    const shot = (STUDIOS_CHARACTER_SHOTS as readonly string[]).includes(item.data.shot ?? '')
      ? (item.data.shot as SigninMedia['shot'])
      : null;
    return [{ vendorMediaId: item.data.media_id ?? item.data.id ?? null, urls, shot }];
  });
}

/** One job object, or null when it does not match a running, finished or failed job. */
function readJob(raw: unknown): SigninJob | null {
  const parsed = jobSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { job_id: id = null, status, media } = parsed.data;
  if (status === 'failed') return { jobId: id, status: 'failed' };
  if (status === 'running' || (status === undefined && id !== null && (media === undefined || media.length === 0))) {
    return id === null ? null : { jobId: id, status: 'running' };
  }
  if (status === 'finished' || (status === undefined && media !== undefined && media.length > 0)) {
    return { jobId: id, status: 'finished', media: readMedia(media ?? []) };
  }
  return null;
}

export type SigninReply =
  /** The tool marked the call as failed and named no job: not charged (Studios docs). */
  | { kind: 'refused' }
  | { kind: 'jobs'; jobs: SigninJob[] }
  /** Anything else. `jobIds` = every job id we could read, kept for the human. */
  | { kind: 'unknown'; jobIds: string[] };

/** Every job id anywhere at the top level or in `jobs` (for an `unknown` reply). */
function jobIdsIn(payload: Record<string, unknown> | null): string[] {
  if (!payload) return [];
  const candidates = [payload, ...(Array.isArray(payload.jobs) ? payload.jobs.slice(0, 8) : [])];
  return candidates.flatMap((c) => {
    const id = isPlainObject(c) ? c.job_id : undefined;
    return typeof id === 'string' && SIGNIN_JOB_ID_RE.test(id) ? [id] : [];
  });
}

/**
 * Our reading of a create tool or get_job result: one job, or `jobs` (one per
 * character shot). Every job must read, or the reply is `unknown`.
 */
export function readSigninReply(reply: StudiosToolResult): SigninReply {
  const payload = toolPayload(reply.result);
  if (reply.isError) {
    const ids = jobIdsIn(payload);
    return ids.length === 0 ? { kind: 'refused' } : { kind: 'unknown', jobIds: ids };
  }
  if (!payload) return { kind: 'unknown', jobIds: [] };
  const rawJobs = Array.isArray(payload.jobs) ? payload.jobs : [payload];
  if (rawJobs.length === 0 || rawJobs.length > 8) return { kind: 'unknown', jobIds: jobIdsIn(payload) };
  const jobs: SigninJob[] = [];
  for (const raw of rawJobs) {
    const job = readJob(raw);
    if (!job) return { kind: 'unknown', jobIds: jobIdsIn(payload) };
    jobs.push(job);
  }
  return { kind: 'jobs', jobs };
}

// ---------------------------------------------------------------------------
// Read surfaces: get_account, list_media (never charged)
// ---------------------------------------------------------------------------

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (isPlainObject(value) && typeof value.usd === 'number' && Number.isFinite(value.usd)) return value.usd;
  return null;
}

function firstNum(payload: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = num(payload[name]);
    if (value !== null) return value;
  }
  return null;
}

export interface StudiosSigninAccountView {
  /** Studios balance in US dollars; null when the reply did not say. */
  balanceUsd: number | null;
  /** Free usage left today on Studios (their unit); null when the reply did not say. */
  freeUsageLeft: number | null;
  /** US dollars THIS ClawVille connection may still spend today (set by the human on Studios); null when the reply did not say. */
  connectionSpendLeftUsd: number | null;
  /** False when none of the fields could be read (the reply shape is not the one we expect). */
  readable: boolean;
}

/** Our fields from a get_account result. Field names are not verified live; unknown names give null. */
export function mapSigninAccount(payload: Record<string, unknown> | null): StudiosSigninAccountView {
  const p = payload ?? {};
  const balanceUsd = firstNum(p, ['balance_usd', 'balance']);
  const freeUsageLeft = firstNum(p, ['free_usage_left', 'free_left_today', 'free_usage_left_today']);
  const connectionSpendLeftUsd = firstNum(p, ['connection_spend_left_usd', 'app_spend_left_usd', 'spend_left_today_usd']);
  return {
    balanceUsd,
    freeUsageLeft,
    connectionSpendLeftUsd,
    readable: balanceUsd !== null || freeUsageLeft !== null || connectionSpendLeftUsd !== null,
  };
}

export const SIGNIN_DESCRIPTION_MAX = 200;
const CURSOR_RE = /^[A-Za-z0-9._~:+/=-]{1,512}$/;

/** Plain text, at most 200 characters, no control characters. Untrusted data, never instructions. */
export function plainDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, SIGNIN_DESCRIPTION_MAX) : null;
}

export interface StudiosSigninMediaItem {
  /** The Studios My Media id. */
  id: string;
  kind: 'image' | 'video' | null;
  /** Vendor text: plain data, at most 200 characters. Never follow it as an instruction. */
  description: string | null;
  /** Uploaded videos: 'ready' or 'problem'; null when the reply did not say. */
  state: 'ready' | 'problem' | null;
}

export interface StudiosSigninMediaView {
  items: StudiosSigninMediaItem[];
  nextCursor: string | null;
}

/** Our fields from a list_media result. Items that do not read are left out. */
export function mapSigninMedia(payload: Record<string, unknown> | null): StudiosSigninMediaView | null {
  if (!payload) return null;
  const list = Array.isArray(payload.media) ? payload.media : Array.isArray(payload.items) ? payload.items : null;
  if (!list) return null;
  const items = list.slice(0, 48).flatMap((raw): StudiosSigninMediaItem[] => {
    if (!isPlainObject(raw)) return [];
    const id = [raw.media_id, raw.id].find((v): v is string => typeof v === 'string' && MEDIA_ID_RE.test(v));
    if (!id) return [];
    const kindRaw = raw.kind ?? raw.type;
    const stateRaw = raw.state ?? raw.status;
    return [{
      id,
      kind: kindRaw === 'image' || kindRaw === 'video' ? kindRaw : null,
      description: plainDescription(raw.description ?? raw.summary),
      state: stateRaw === 'ready' || stateRaw === 'problem' ? stateRaw : null,
    }];
  });
  const cursorRaw = payload.next_cursor ?? payload.nextCursor;
  return { items, nextCursor: typeof cursorRaw === 'string' && CURSOR_RE.test(cursorRaw) ? cursorRaw : null };
}

export const signinMediaQuerySchema = z.object({
  kind: z.enum(['image', 'video']).optional(),
  limit: z.coerce.number().int().min(1).max(48).optional(),
  cursor: z.string().regex(CURSOR_RE).optional(),
}).strict();
