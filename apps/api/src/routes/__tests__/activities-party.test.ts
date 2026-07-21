/**
 * Party REST lifecycle coverage. The routes and party mirror are DB-backed, so
 * this suite follows the neighboring route-test convention and skips cleanly
 * when DATABASE_URL is unavailable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { inArray } from 'drizzle-orm';

import {
  activityParties,
  activityPartyMembers,
  avatars,
  db,
  users,
} from '@clawville/database';
import { lucia } from '../../lib/auth';
import { activityQueueService } from '../../services/activity/activity-queue';
import type { AppContext } from '../../types';
import { activitiesV2Routes } from '../activities';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

interface PartyPayload {
  id: string;
  shortCode: string;
  leaderAvatarId: string;
  members: Array<{ avatarId: string; displayName: string }>;
  createdAt: number;
  cap: number;
}

interface PartyResponse {
  ok: true;
  party: PartyPayload | null;
  alreadyInParty?: boolean;
}

function buildApp() {
  const app = new Hono<AppContext>();
  app.route('/api/activities', activitiesV2Routes);
  return app;
}

describeIfDb('activities party routes (requires DATABASE_URL)', () => {
  const runId = crypto.randomUUID().replaceAll('-', '');
  const userIds: string[] = [];
  const partyIds: string[] = [];
  let app: ReturnType<typeof buildApp>;
  let leader: { cookie: string; avatarId: string; displayName: string };
  let member: { cookie: string; avatarId: string; displayName: string };

  async function createIdentity(label: string) {
    const fingerprint = `${runId}${crypto.randomUUID().replaceAll('-', '')}`.slice(0, 64);
    const [user] = await db
      .insert(users)
      .values({
        identityFingerprint: fingerprint,
        name: `Party Route ${label}`,
      })
      .returning({ id: users.id });
    userIds.push(user.id);

    const displayName = `Party${label}${runId.slice(0, 8)}`;
    const [avatar] = await db
      .insert(avatars)
      .values({
        userId: user.id,
        name: displayName,
        species: 'cat',
        color: 'green',
        gender: 'male',
        archetype: 'curious-scholar',
        personality: {
          habitat: 'reef',
          hobby: 'racing',
          greeting: 'hello',
        },
        stats: { strength: 1, defence: 1, movement: 1 },
      })
      .returning({ id: avatars.id });

    const session = await lucia.createSession(user.id, {});
    return {
      avatarId: avatar.id,
      displayName,
      cookie: `${lucia.sessionCookieName}=${session.id}`,
    };
  }

  async function post(path: string, cookie: string, body?: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    activityQueueService.__resetForTest();
    app = buildApp();
    leader = await createIdentity('Leader');
    member = await createIdentity('Member');
  });

  afterAll(async () => {
    activityQueueService.__resetForTest();
    if (partyIds.length > 0) {
      await db
        .delete(activityPartyMembers)
        .where(inArray(activityPartyMembers.partyId, partyIds));
      await db.delete(activityParties).where(inArray(activityParties.id, partyIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it('runs create -> me -> join -> kick -> leave with named members and leader succession', async () => {
    const createRes = await post('/api/activities/party', leader.cookie, {});
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as PartyResponse;
    expect(created.party).not.toBeNull();
    const party = created.party!;
    partyIds.push(party.id);
    expect(party.shortCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(party.leaderAvatarId).toBe(leader.avatarId);
    expect(party.members).toEqual([
      { avatarId: leader.avatarId, displayName: leader.displayName },
    ]);

    const meRes = await app.request('/api/activities/party/me', {
      headers: { Cookie: leader.cookie },
    });
    expect(meRes.status).toBe(200);
    const mine = (await meRes.json()) as PartyResponse;
    expect(mine.party).toEqual(party);

    const joinRes = await post(
      `/api/activities/party/${party.shortCode.toLowerCase()}/join`,
      member.cookie,
    );
    expect(joinRes.status).toBe(200);
    const joined = (await joinRes.json()) as PartyResponse;
    expect(joined.party?.members).toEqual([
      { avatarId: leader.avatarId, displayName: leader.displayName },
      { avatarId: member.avatarId, displayName: member.displayName },
    ]);

    const kickRes = await post(
      `/api/activities/party/${party.id}/kick`,
      leader.cookie,
      { avatarId: member.avatarId },
    );
    expect(kickRes.status).toBe(200);
    const kicked = (await kickRes.json()) as PartyResponse;
    expect(kicked.party?.members).toEqual([
      { avatarId: leader.avatarId, displayName: leader.displayName },
    ]);

    const rejoinRes = await post(
      `/api/activities/party/${party.shortCode}/join`,
      member.cookie,
    );
    expect(rejoinRes.status).toBe(200);

    const leaderLeaveRes = await post(
      `/api/activities/party/${party.id}/leave`,
      leader.cookie,
    );
    expect(leaderLeaveRes.status).toBe(200);

    const successorMeRes = await app.request('/api/activities/party/me', {
      headers: { Cookie: member.cookie },
    });
    expect(successorMeRes.status).toBe(200);
    const successor = (await successorMeRes.json()) as PartyResponse;
    expect(successor.party?.leaderAvatarId).toBe(member.avatarId);
    expect(successor.party?.members).toEqual([
      { avatarId: member.avatarId, displayName: member.displayName },
    ]);

    const finalLeaveRes = await post(
      `/api/activities/party/${party.id}/leave`,
      member.cookie,
    );
    expect(finalLeaveRes.status).toBe(200);

    const emptyMeRes = await app.request('/api/activities/party/me', {
      headers: { Cookie: member.cookie },
    });
    expect(emptyMeRes.status).toBe(200);
    expect(await emptyMeRes.json()).toEqual({ ok: true, party: null });
  });

  it('returns 404 for an unknown valid short code and 400 for non-Crockford input', async () => {
    const missing = await post('/api/activities/party/ZZZZZZ/join', member.cookie);
    expect(missing.status).toBe(404);

    const malformed = await post('/api/activities/party/OOOOOO/join', member.cookie);
    expect(malformed.status).toBe(400);
  });
});
