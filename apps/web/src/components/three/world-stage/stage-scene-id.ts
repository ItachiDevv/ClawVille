export const WORLD_SCENE_ID = 'world';
export const COVE_SCENE_ID = 'cove';
export const KELP_SCENE_ID = 'kelp';
export const ACTIVITY_SCENE_ID = 'activity';
export const NAV_NONCE_PARAM = '__wsnav';

export function sceneIdForPathname(pathname: string): string | null {
  if (pathname === '/game') return WORLD_SCENE_ID;
  if (pathname === '/cove') return COVE_SCENE_ID;
  if (pathname === '/kelp') return KELP_SCENE_ID;
  const segments = pathname.split('/');
  if (
    segments.length === 4 &&
    segments[1] === 'activity' &&
    segments[2].length > 0 &&
    segments[3].length > 0
  ) {
    return ACTIVITY_SCENE_ID;
  }
  return null;
}

export function stagePathnameFromHref(href: string): string {
  return new URL(href, window.location.origin).pathname;
}

export function stageDestinationKey(pathname: string): string | null {
  const sceneId = sceneIdForPathname(pathname);
  if (sceneId === null) return null;
  if (sceneId !== ACTIVITY_SCENE_ID) return sceneId;
  const segments = pathname.split('/');
  return `${ACTIVITY_SCENE_ID}:${segments[2]}:${segments[3]}`;
}

export function roomKeyFromPathname(pathname: string): string | null {
  const segments = pathname.split('/');
  if (segments.length !== 4 || segments[1] !== 'activity') return null;
  if (!segments[2] || !segments[3]) return null;
  return `${segments[2]}:${segments[3]}`;
}

export function canonicalStageUrl(href: string): string {
  const url = new URL(href, window.location.origin);
  url.searchParams.delete(NAV_NONCE_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface NavNonce {
  readonly epoch: string;
  readonly seq: number;
}

export function parseNavNonce(
  search: string | URLSearchParams,
): NavNonce | null {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw = params.get(NAV_NONCE_PARAM);
  if (raw === null) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const suffix = raw.slice(dot + 1);
  if (!/^[0-9]+$/.test(suffix)) return null;
  const seq = Number.parseInt(suffix, 10);
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  return { epoch: raw.slice(0, dot), seq };
}
