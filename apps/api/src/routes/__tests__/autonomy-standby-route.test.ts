import { afterAll, describe, expect, it, setSystemTime } from 'bun:test';
import { Hono } from 'hono';

process.env.FINGERPRINT_SECRET ??= 'a'.repeat(64);

const [{ dashboardRoutes }, { DASH_COOKIE_NAME, expectedDashCookie }] = await Promise.all([
  import('../dashboard'),
  import('../../middleware/admin-only'),
]);
const { autonomyStandbyTestSeams } = await import('../../services/autonomy-standby');

const app = new Hono();
app.route('/api/dashboard', dashboardRoutes);

const dashCookie = expectedDashCookie();
if (!dashCookie) throw new Error('dashboard test cookie could not be derived');
const adminHeaders = { Cookie: `${DASH_COOKIE_NAME}=${dashCookie}` };

afterAll(() => {
  setSystemTime();
  autonomyStandbyTestSeams.restoreDefault();
});

describe('dashboard autonomy standby routes', () => {
  it('rejects a non-admin caller', async () => {
    const response = await app.request('/api/dashboard/autonomy');
    expect(response.status).toBe(401);
  });

  it('round-trips arm and standby state for an admin', async () => {
    const now = new Date('2026-07-19T14:00:00.000Z');
    setSystemTime(now);

    const standbyResponse = await app.request('/api/dashboard/autonomy/standby', {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(standbyResponse.status).toBe(200);
    expect(await standbyResponse.json()).toMatchObject({
      mode: 'standby',
      armedUntil: null,
      counts: { house: expect.any(Number), user: expect.any(Number), total: expect.any(Number) },
    });

    const armResponse = await app.request('/api/dashboard/autonomy/arm', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: 120 }),
    });
    expect(armResponse.status).toBe(200);
    const armed = await armResponse.json() as {
      mode: string;
      armedUntil: number | null;
      counts: { house: number; user: number; total: number };
    };
    expect(armed.mode).toBe('active');
    expect(armed.armedUntil).toBe(now.getTime() + 120 * 60_000);
    expect(armed.counts.total).toBe(armed.counts.house + armed.counts.user);

    const getResponse = await app.request('/api/dashboard/autonomy', {
      headers: adminHeaders,
    });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({
      mode: 'active',
      armedUntil: now.getTime() + 120 * 60_000,
      counts: armed.counts,
    });

    const finalStandbyResponse = await app.request('/api/dashboard/autonomy/standby', {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(finalStandbyResponse.status).toBe(200);
    expect(await finalStandbyResponse.json()).toMatchObject({
      mode: 'standby',
      armedUntil: null,
    });
  });

  it('Zod-rejects invalid arm input', async () => {
    const response = await app.request('/api/dashboard/autonomy/arm', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: 'two hours' }),
    });
    expect(response.status).toBe(400);
  });
});
