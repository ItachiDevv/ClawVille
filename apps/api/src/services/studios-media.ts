/**
 * Storage for media that an avatar's Studios calls made (MCP hub phase 3b).
 *
 *   - Results arrive as base64, as an artifact path under
 *     https://mystudios.fun/api/v1/media/artifacts/, or as a signed URL that
 *     expires. ClawVille downloads a URL at once, but ONLY from
 *     https://mystudios.fun or Studios' own storage (STUDIOS_STORAGE_HOST,
 *     path STUDIOS_STORAGE_PATH_PREFIX only; sign-in results live there):
 *     no other host, no redirect, no user info, no port, a byte limit and a
 *     time limit.
 *     The Studios key is never sent on these downloads (docs.md: no key needed).
 *   - Bytes are checked by their first bytes, never by a vendor header: png,
 *     jpeg, webp (at most 8 MB) or mp4, webm (at most 50 MB).
 *   - Each avatar may keep at most MEDIA_QUOTA_BYTES_PER_AVATAR in total. A new
 *     request is refused BEFORE any spend when the stored bytes plus the
 *     reserves of its unfinished requests plus its own reserve pass the quota
 *     (`media_quota_full`, checked in studios-images.ts under the avatar lock).
 *   - The human owner can delete one item (DELETE /api/media/:id).
 */

import { and, avatarMedia, db, eq, sql } from '@clawville/database';
import { IMAGE_MAX_BYTES, STUDIOS_ARTIFACT_PREFIX, STUDIOS_HOST, STUDIOS_ORIGIN, STUDIOS_STORAGE_HOST, STUDIOS_STORAGE_PATH_PREFIX, VIDEO_MAX_BYTES } from './vendors/studios-operations';

export const MEDIA_QUOTA_BYTES_PER_AVATAR = 500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type MediaKind = 'image' | 'video';

const MAGIC: Array<{ mime: string; kind: MediaKind; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', kind: 'image', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', kind: 'image', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', kind: 'image', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  // ISO base media (mp4): a box size, then 'ftyp'.
  { mime: 'video/mp4', kind: 'video', test: (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' },
  // Matroska / WebM EBML header.
  { mime: 'video/webm', kind: 'video', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];

export function maxBytesFor(kind: MediaKind): number {
  return kind === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
}

/** The checked type of these bytes, or null (unknown type, wrong kind or too big for its type). */
export function sniffMedia(bytes: Buffer, expected: MediaKind): { mime: string; kind: MediaKind } | null {
  if (bytes.length === 0) return null;
  const match = MAGIC.find((m) => m.test(bytes));
  if (!match || match.kind !== expected) return null;
  if (bytes.length > maxBytesFor(match.kind)) return null;
  return { mime: match.mime, kind: match.kind };
}

export type ArtifactFetchFailure = 'media_host_refused' | 'media_redirect_refused' | 'media_too_large' | 'media_unreachable';

/**
 * The absolute download URL for a Studios result, or null when it is not on
 * Studios' own host or its storage path. An artifact path gets the Studios origin in front.
 */
export function studiosDownloadUrl(raw: string): string | null {
  let url: URL;
  try {
    if (raw.startsWith('/')) {
      // Only an artifact path is relative; '//host' is a different host.
      if (raw.startsWith('//') || !raw.startsWith(STUDIOS_ARTIFACT_PREFIX)) return null;
      url = new URL(raw, STUDIOS_ORIGIN);
      if (!url.pathname.startsWith(STUDIOS_ARTIFACT_PREFIX)) return null;
    } else {
      url = new URL(raw);
    }
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host === STUDIOS_HOST) return url.href;
  // Studios' storage: only its signed studio-artifacts paths. No '..' and no
  // encoded '/', '' or '.', so the storage server cannot decode a path that
  // leaves the prefix.
  if (host === STUDIOS_STORAGE_HOST && url.pathname.startsWith(STUDIOS_STORAGE_PATH_PREFIX)
    && !url.pathname.includes('/../') && !/%(2f|5c|2e)/i.test(url.pathname)) return url.href;
  return null;
}

/**
 * Download one Studios result. Refuses any other host and any redirect; reads
 * at most `maxBytes` and stops after the time limit.
 */
export async function fetchStudiosArtifact(
  raw: string,
  maxBytes: number,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: ArtifactFetchFailure }> {
  const url = studiosDownloadUrl(raw);
  if (!url) return { ok: false, code: 'media_host_refused' };
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { Accept: 'image/*, video/*' },
    });
  } catch {
    return { ok: false, code: 'media_unreachable' };
  }
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    await res.body?.cancel().catch(() => {});
    return { ok: false, code: 'media_redirect_refused' };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, code: 'media_unreachable' };
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, code: 'media_too_large' };
  }
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, code: 'media_unreachable' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, code: 'media_too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: 'media_unreachable' };
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

type Executor = Pick<typeof db, 'execute'>;

/** Bytes this avatar stores now (octet_length reads the stored size, not the data). */
export async function storedMediaBytes(executor: Executor, avatarId: string): Promise<number> {
  const rows = await executor.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(octet_length(bytes)), 0)::text AS total FROM avatar_media WHERE avatar_id = ${avatarId}`,
  );
  return Number(Array.from(rows)[0]?.total ?? '0');
}

/** One slice of one stored item, for a Range request. Postgres reads only the slice of an uncompressed value. */
export async function readMediaRange(id: string, start: number, length: number): Promise<{ mime: string; size: number; bytes: Buffer } | null> {
  const rows = await db.execute<{ mime_type: string; size: number | string; chunk: Buffer | Uint8Array | null }>(sql`
    SELECT mime_type, octet_length(bytes) AS size, substring(bytes FROM ${start + 1} FOR ${length}) AS chunk
    FROM avatar_media WHERE id = ${id}`);
  const row = Array.from(rows)[0];
  if (!row) return null;
  return { mime: row.mime_type, size: Number(row.size), bytes: Buffer.from(row.chunk ?? new Uint8Array()) };
}

/** Type and size of one stored item (no data). */
export async function readMediaHead(id: string): Promise<{ mime: string; size: number } | null> {
  const rows = await db.execute<{ mime_type: string; size: number | string }>(
    sql`SELECT mime_type, octet_length(bytes) AS size FROM avatar_media WHERE id = ${id}`,
  );
  const row = Array.from(rows)[0];
  return row ? { mime: row.mime_type, size: Number(row.size) } : null;
}

/** The human owner deletes one item of their own avatar. False when it is not theirs or not there. */
export async function deleteOwnMedia(avatarId: string, id: string): Promise<boolean> {
  const deleted = await db.delete(avatarMedia)
    .where(and(eq(avatarMedia.id, id), eq(avatarMedia.avatarId, avatarId)))
    .returning({ id: avatarMedia.id });
  return deleted.length > 0;
}
