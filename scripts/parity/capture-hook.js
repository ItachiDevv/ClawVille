(() => {
  'use strict';

  const BUCKET_CAP = 256;
  const buckets = new Map();
  let nextSeq = 1;
  const nativeFetch = window.fetch.bind(window);
  let releaseFixtureGate;
  let fixtureGateReleased = false;
  const fixtureGate = new Promise((resolve) => {
    releaseFixtureGate = resolve;
  });

  window.__CV_SET_FIXTURE_HEADER = (header) => {
    if (typeof header === 'string' && header.length > 0) {
      window.__CV_TEST_FIXTURE_HEADER = header;
    } else {
      window.__CV_TEST_FIXTURE_HEADER = undefined;
    }
  };

  window.__CV_RELEASE_FIXTURE_GATE = (header) => {
    if (typeof header === 'string' && header.length > 0) {
      window.__CV_SET_FIXTURE_HEADER(header);
    }
    if (!fixtureGateReleased) {
      fixtureGateReleased = true;
      releaseFixtureGate();
    }
  };

  const redactSecrets = (value) => {
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => (
      /^(token|secret|secretKey|authorization|joinCode)$/i.test(key)
        ? [key, '[REDACTED]']
        : [key, redactSecrets(child)]
    )));
  };

  const safeClone = (value) => {
    if (value === undefined) return null;
    try {
      return redactSecrets(JSON.parse(JSON.stringify(value)));
    } catch {
      return null;
    }
  };

  const parseText = (text) => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const readBody = async (value) => {
    if (value == null) return null;
    if (typeof value === 'string') return parseText(value);
    if (value instanceof URLSearchParams) {
      return Object.fromEntries(value.entries());
    }
    if (value instanceof FormData) {
      return Object.fromEntries(value.entries());
    }
    if (value instanceof Blob) return parseText(await value.text());
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return null;
    return safeClone(value);
  };

  const deepFind = (value, keys) => {
    if (!value || typeof value !== 'object') return null;
    const queue = [value];
    const seen = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || seen.has(current)) continue;
      seen.add(current);
      for (const [key, child] of Object.entries(current)) {
        if (keys.has(key) && child !== null && child !== undefined) return child;
        if (child && typeof child === 'object') queue.push(child);
      }
    }
    return null;
  };

  const asString = (value) => (
    typeof value === 'string' && value.length > 0 ? value : null
  );
  const asNumber = (value) => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return null;
  };

  const suffixFor = (url) => {
    try {
      const parsed = new URL(url, window.location.href);
      const marker = '/api/cove/';
      const index = parsed.pathname.indexOf(marker);
      const path = index >= 0
        ? parsed.pathname.slice(index + marker.length)
        : parsed.pathname.replace(/^\/+/, '');
      return path;
    } catch {
      return String(url);
    }
  };

  const append = (record) => {
    const bucket = buckets.get(record.urlSuffix) ?? [];
    bucket.push(Object.freeze(record));
    if (bucket.length > BUCKET_CAP) bucket.splice(0, bucket.length - BUCKET_CAP);
    buckets.set(record.urlSuffix, bucket);
  };

  window.__CV_WIRE_GET = (urlSuffix, seq) => {
    const bucket = buckets.get(urlSuffix) ?? [];
    const found = seq === undefined
      ? bucket[bucket.length - 1]
      : bucket.find((record) => record.seq === seq);
    return found ? safeClone(found) : null;
  };
  window.__CV_WIRE_SINCE = (urlSuffix, afterSeq) => (
    (buckets.get(urlSuffix) ?? [])
      .filter((record) => record.seq > afterSeq)
      .map(safeClone)
  );
  window.__CV_WIRE_ALL = () => (
    [...buckets.values()]
      .flat()
      .sort((left, right) => left.seq - right.seq)
      .map(safeClone)
  );

  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const rawUrl = request ? request.url : String(input);
    const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
    let requestBody = await readBody(init?.body);
    if (requestBody === null && request && !['GET', 'HEAD'].includes(method)) {
      try {
        requestBody = parseText(await request.clone().text());
      } catch {
        requestBody = null;
      }
    }

    let effectiveInput = input;
    let effectiveInit = init;
    const fixtureArmedPath = /\/api\/cove\/(?:blackjack\/(?:session\/(?:open|close)|hand\/|action)|baccarat\/(?:session\/(?:open|close)|coup)|poker\/cash\/|holdem\/|test-fixture\/)/.test(rawUrl);
    const fixtureSeedArm = /\/api\/cove\/(?:blackjack\/session\/open|baccarat\/session\/open|holdem\/session\/open|poker\/cash\/tables\/[^/?]+\/sit)(?:[/?]|$)/.test(rawUrl);
    if (fixtureSeedArm && method !== 'GET') {
      await fixtureGate;
    }
    const fixtureHeader = window.__CV_TEST_FIXTURE_HEADER;
    if (fixtureHeader && fixtureArmedPath && method !== 'GET') {
      const headers = new Headers(init?.headers ?? request?.headers);
      headers.set('X-CV-Test-Fixture', fixtureHeader);
      if (request && !init) {
        effectiveInput = new Request(request, { headers });
      } else {
        effectiveInit = { ...(init ?? {}), headers };
      }
    }

    const response = await nativeFetch(effectiveInput, effectiveInit);
    let responseBody = null;
    try {
      responseBody = parseText(await response.clone().text());
    } catch {
      responseBody = null;
    }
    const both = { requestBody, responseBody };
    const idempotencyKey = new Headers(init?.headers ?? request?.headers)
      .get('Idempotency-Key');
    append({
      seq: nextSeq++,
      method,
      url: rawUrl,
      urlSuffix: suffixFor(rawUrl),
      status: response.status,
      requestBody: safeClone(requestBody),
      responseBody: safeClone(responseBody),
      handId: asString(deepFind(both, new Set(['handId', 'hand_id']))),
      handNumber: asNumber(
        deepFind(both, new Set(['handNumber', 'handIndex', 'hand_number'])),
      ),
      coupId: asString(deepFind(both, new Set(['coupId', 'coup_id']))),
      shoeId: asString(deepFind(both, new Set(['shoeId', 'shoe_id']))),
      idempotencyKey: asString(idempotencyKey),
    });
    return response;
  };
})();
