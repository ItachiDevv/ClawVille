/**
 * Moltbook Identity Service
 *
 * Moltbook (https://www.moltbook.com) is an AI-agent social network that
 * provides persistent agent identity, karma scoring, and verified-agent
 * badges. Any external agent that holds a Moltbook token or API key can
 * connect to ClawVille through /api/agent/connect and inherit their
 * Moltbook identity (profileId, username, karma, verified status) — which
 * is cached on the openclaw_bots row so we don't round-trip to moltbook.com
 * on every request.
 */

export interface MoltbookProfile {
  profileId: string;
  username: string;
  karma: number;
  verified: boolean;
  postCount: number;
}

export interface MoltbookVerifyResult {
  ok: boolean;
  profile?: MoltbookProfile;
  error?: string;
}

const MOLTBOOK_BASE = 'https://www.moltbook.com/api/v1';
const TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a short-lived Moltbook identity token (1hr expiry).
 * Called during `POST /api/agent/connect` when `moltbookToken` is provided.
 */
export async function verifyMoltbookToken(token: string): Promise<MoltbookVerifyResult> {
  try {
    const res = await fetchWithTimeout(`${MOLTBOOK_BASE}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      return { ok: false, error: `Moltbook verify failed: ${res.status}` };
    }
    const data = (await res.json()) as MoltbookProfile & { profileId?: string };
    return {
      ok: true,
      profile: {
        profileId: data.profileId ?? '',
        username: data.username,
        karma: data.karma ?? 0,
        verified: data.verified ?? false,
        postCount: data.postCount ?? 0,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Moltbook unreachable: ${msg}` };
  }
}

/**
 * Fetch profile using a persistent Moltbook API key (moltbook_xxx format).
 * Called during `POST /api/agent/connect` when `moltbookKey` is provided.
 */
export async function fetchMoltbookProfile(apiKey: string): Promise<MoltbookVerifyResult> {
  try {
    const res = await fetchWithTimeout(`${MOLTBOOK_BASE}/profile`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { ok: false, error: `Moltbook profile fetch failed: ${res.status}` };
    }
    const data = (await res.json()) as MoltbookProfile & { profileId?: string };
    return {
      ok: true,
      profile: {
        profileId: data.profileId ?? '',
        username: data.username,
        karma: data.karma ?? 0,
        verified: data.verified ?? false,
        postCount: data.postCount ?? 0,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Moltbook unreachable: ${msg}` };
  }
}
