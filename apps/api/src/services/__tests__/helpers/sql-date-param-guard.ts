/**
 * Test-only regression gate for raw drizzle `sql` templates: a JS Date must never
 * be a bound param.
 *
 * WHY: drizzle 0.33 on postgres-js serializes timestamptz (type 1184) params with
 * an identity function, so a Date reaches Buffer.byteLength and throws a
 * TypeError at execute time. A mock db never sees that, so a bare
 * `${new Date()}` in a raw query passes every unit test and then 500s every call
 * in production (security batch 2: the special-event start claim and the stale
 * start reconcile). Bind `${d.toISOString()}::timestamptz` instead.
 *
 * A fake db calls `assertNoDateParams(q)` on every executed query. The check
 * throws AND records the violation, so a caller that swallows the error (a
 * per-row try/catch in a worker loop) still fails the file's `afterEach` through
 * `takeDateParamViolations()`.
 */

interface ChunkCarrier {
  queryChunks: unknown[];
}

function isSqlLike(v: unknown): v is ChunkCarrier {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { queryChunks?: unknown }).queryChunks)
  );
}

function ctorName(v: unknown): string | undefined {
  return (v as { constructor?: { name?: string } } | null)?.constructor?.name;
}

/** Walk one chunk; push a path for every Date found in a param position. */
function walk(chunk: unknown, path: string, found: string[]): void {
  if (chunk instanceof Date) {
    found.push(path);
    return;
  }
  if (chunk == null || typeof chunk !== 'object') return;
  if (Array.isArray(chunk)) {
    // drizzle renders an interpolated array as a list of params.
    chunk.forEach((item, i) => walk(item, `${path}[${i}]`, found));
    return;
  }
  if (isSqlLike(chunk)) {
    chunk.queryChunks.forEach((c, i) => walk(c, `${path}.queryChunks[${i}]`, found));
    return;
  }
  const name = ctorName(chunk);
  // sql.param(value) wraps the bound value in a Param chunk.
  if (name === 'Param') {
    walk((chunk as { value?: unknown }).value, `${path}.value`, found);
    return;
  }
  // StringChunk / Name / Column / Table / Placeholder carry no bound JS value.
}

/** Every path in `q` where a Date sits in a bound-param position. */
export function findDateParams(q: unknown): string[] {
  const found: string[] = [];
  walk(q, 'sql', found);
  return found;
}

/** The SQL text with `?` for params (for a readable failure message). */
function sqlText(q: unknown): string {
  if (!isSqlLike(q)) return String(q);
  let text = '';
  for (const ch of q.queryChunks) {
    const name = ctorName(ch);
    if (name === 'StringChunk') text += ((ch as { value: string[] }).value ?? []).join('');
    else if (isSqlLike(ch)) text += sqlText(ch);
    else if (name === 'Name') text += (ch as { value: string }).value;
    else text += '?';
  }
  return text.replace(/\s+/g, ' ').trim();
}

const violations: string[] = [];

/**
 * Throw (and record) when `q` binds a JS Date in any param position, nested SQL
 * fragments and arrays included.
 */
export function assertNoDateParams(q: unknown): void {
  const found = findDateParams(q);
  if (found.length === 0) return;
  const message =
    `raw sql binds a JS Date at ${found.join(', ')} (postgres-js throws a TypeError ` +
    `on it; bind \${d.toISOString()}::timestamptz): ${sqlText(q).slice(0, 240)}`;
  violations.push(message);
  throw new TypeError(message);
}

/** Return and clear every violation recorded since the last call. */
export function takeDateParamViolations(): string[] {
  return violations.splice(0, violations.length);
}
