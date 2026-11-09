import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { jsonBodyGuard } from '../json-body-guard';
import { safeBodyLimit } from '../safe-body-limit';

const onError = (c: any) => c.json({ code: 'payload_too_large' }, 413);

function app() {
  const a = new Hono();
  a.onError((err, c) => c.json({ code: 'internal', message: String(err) }, 500));
  a.use('*', jsonBodyGuard);
  a.post('/x', safeBodyLimit({ maxSize: 64, onError }), async (c) => c.json({ got: await c.req.json() }));
  return a;
}

// Like the MCP clawville_call sub-request: a string body and no Content-Length header.
const noLength = (body: unknown) =>
  new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const withLength = (body: unknown) => {
  const text = JSON.stringify(body);
  return new Request('http://t/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(text).byteLength) },
    body: text,
  });
};

// Hono's own bodyLimit answers 500 for the no-Content-Length case on Bun 1.4.4 (the staging and
// prod runtime) but not on Bun 1.3.x, so the bug itself is not pinned here; these tests pin the fix.
describe('safeBodyLimit after jsonBodyGuard', () => {
  test('a small body with no Content-Length reaches the handler', async () => {
    const res = await app().fetch(noLength({ a: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { a: 1 } });
  });

  test('a large body with no Content-Length gets 413', async () => {
    const res = await app().fetch(noLength({ a: 'x'.repeat(100) }));
    expect(res.status).toBe(413);
  });

  test('a Content-Length smaller than the real body does not pass a large body', async () => {
    const text = JSON.stringify({ a: 'x'.repeat(100) });
    const lie = new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1' }, body: text });
    expect((await app().fetch(lie)).status).toBe(413);
  });

  test('a BOM-prefixed body is measured with its declared length', async () => {
    const text = JSON.stringify({ a: 'x'.repeat(54) }); // 62 bytes after decode (under the 64 limit)
    const body = '﻿' + text; // 65 bytes on the wire with the 3-byte BOM (over the limit)
    const bytes = new TextEncoder().encode(body).byteLength;
    const req = new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(bytes) }, body });
    expect(new TextEncoder().encode(text).byteLength).toBe(62);
    expect(bytes).toBe(65);
    expect((await app().fetch(req)).status).toBe(413);
    // Same body with no Content-Length, and with an understated one.
    const bare = new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect((await app().fetch(bare)).status).toBe(413);
    const low = new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '10' }, body });
    expect((await app().fetch(low)).status).toBe(413);
  });

  test('boundary: a body 3 bytes under the limit passes; 2 bytes under is refused (BOM allowance)', async () => {
    const at = (n: number) => JSON.stringify({ a: 'x'.repeat(n - 8) }); // n bytes
    expect(new TextEncoder().encode(at(61)).byteLength).toBe(61);
    expect((await app().fetch(noLength(JSON.parse(at(61))))).status).toBe(200);
    expect((await app().fetch(noLength(JSON.parse(at(62))))).status).toBe(413);
  });

  test('Content-Length requests behave as before', async () => {
    expect((await app().fetch(withLength({ a: 1 }))).status).toBe(200);
    expect((await app().fetch(withLength({ a: 'x'.repeat(100) }))).status).toBe(413);
  });
});
