import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, users, avatars, agents } from '@clawville/database';
import { avatarRoutes } from '../routes/avatars';
import { authRoutes } from '../routes/auth';
import type { AppContext } from '../types';

// Test user credentials
const TEST_EMAIL = `test-${Date.now()}@clawville-test.com`;
const TEST_PASSWORD = 'testpassword123';
let testUserId: string;
let testSessionCookie: string;

// Create test app
function createTestApp() {
  const app = new Hono<AppContext>();
  app.route('/api/auth', authRoutes);
  app.route('/api/avatars', avatarRoutes);
  return app;
}

describe('Avatar API Tests', () => {
  const app = createTestApp();

  beforeAll(async () => {
    // Create test user via signup
    const signupRes = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: 'Test User',
      }),
    });

    expect(signupRes.status).toBe(200);

    // Get the session cookie
    const cookies = signupRes.headers.get('set-cookie');
    if (cookies) {
      testSessionCookie = cookies.split(';')[0];
    }

    // Get user ID
    const user = await db.query.users.findFirst({
      where: eq(users.email, TEST_EMAIL),
    });
    testUserId = user?.id || '';
  });

  afterAll(async () => {
    // Cleanup: delete test user and related data
    if (testUserId) {
      await db.delete(avatars).where(eq(avatars.userId, testUserId));
      await db.delete(agents).where(eq(agents.userId, testUserId));
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  describe('POST /api/avatars (Create Avatar)', () => {
    it('should fail without authentication', async () => {
      const res = await app.request('/api/avatars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'TestPet',
          species: 'cat',
          color: 'green',
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
          characterConfig: {
            bio: 'A friendly test avatar',
            greeting: 'Hello there!',
            personality: 'Friendly and curious',
            tone: 'friendly',
            topics: ['games', 'adventures'],
            adjectives: ['friendly', 'curious'],
            rules: [],
            style: [],
          },
        }),
      });

      expect(res.status).toBe(401);
    });

    it('should fail with name too short', async () => {
      const res = await app.request('/api/avatars', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: testSessionCookie,
        },
        body: JSON.stringify({
          name: 'AB', // too short
          species: 'cat',
          color: 'green',
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
          characterConfig: {
            bio: 'A friendly test avatar',
            greeting: 'Hello there!',
            personality: 'Friendly and curious',
            tone: 'friendly',
            topics: ['games'],
            adjectives: ['friendly'],
            rules: [],
            style: [],
          },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should fail with invalid species', async () => {
      const res = await app.request('/api/avatars', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: testSessionCookie,
        },
        body: JSON.stringify({
          name: 'TestPet123',
          species: 'unicorn', // invalid
          color: 'green',
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
          characterConfig: {
            bio: 'A friendly test avatar',
            greeting: 'Hello there!',
            personality: 'Friendly and curious',
            tone: 'friendly',
            topics: ['games'],
            adjectives: ['friendly'],
            rules: [],
            style: [],
          },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should fail with invalid color', async () => {
      const res = await app.request('/api/avatars', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: testSessionCookie,
        },
        body: JSON.stringify({
          name: 'TestPet456',
          species: 'cat',
          color: 'purple', // invalid
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
          characterConfig: {
            bio: 'A friendly test avatar',
            greeting: 'Hello there!',
            personality: 'Friendly and curious',
            tone: 'friendly',
            topics: ['games'],
            adjectives: ['friendly'],
            rules: [],
            style: [],
          },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should create avatar successfully with valid data', async () => {
      const avatarName = `TestPet${Date.now()}`;
      const res = await app.request('/api/avatars', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: testSessionCookie,
        },
        body: JSON.stringify({
          name: avatarName,
          species: 'cat',
          color: 'green',
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
          characterConfig: {
            bio: 'A friendly test avatar that loves adventures',
            greeting: 'Hello there! Ready for fun?',
            personality: 'Friendly and curious, always exploring',
            tone: 'friendly',
            topics: ['games', 'adventures'],
            adjectives: ['friendly', 'curious'],
            rules: [],
            style: [],
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.avatar).toBeDefined();
      expect(data.avatar.name).toBe(avatarName);
      expect(data.avatar.species).toBe('cat');
      expect(data.avatar.color).toBe('green');
      expect(data.avatar.platformAgentId).toBeDefined();
      expect(data.agentId).toBeDefined();

      // Verify stats were calculated correctly
      // forest (s:3, d:4, m:3) + exploring (s:1, d:1, m:3) + wave-hello (s:1, d:2, m:2)
      expect(data.avatar.stats.strength).toBe(5);
      expect(data.avatar.stats.defence).toBe(7);
      expect(data.avatar.stats.movement).toBe(8);
    });

    it('should fail when user already has a avatar', async () => {
      const res = await app.request('/api/avatars', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: testSessionCookie,
        },
        body: JSON.stringify({
          name: `AnotherPet${Date.now()}`,
          species: 'dragon',
          color: 'red',
          gender: 'female',
          personality: { habitat: 'mountain', hobby: 'battling', greeting: 'roar' },
          characterConfig: {
            bio: 'A fierce dragon avatar that breathes fire',
            greeting: 'ROAR! Who dares approach?',
            personality: 'Fierce and brave, protects friends',
            tone: 'playful',
            topics: ['battles'],
            adjectives: ['fierce'],
            rules: [],
            style: [],
          },
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/avatars/me', () => {
    it('should fail without authentication', async () => {
      const res = await app.request('/api/avatars/me');
      expect(res.status).toBe(401);
    });

    it('should return user avatar when authenticated', async () => {
      const res = await app.request('/api/avatars/me', {
        headers: { Cookie: testSessionCookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.avatar).toBeDefined();
      expect(data.avatar.userId).toBe(testUserId);
    });
  });

  describe('GET /api/avatars/check-name/:name', () => {
    it('should return available for new name', async () => {
      // Use a simple alphanumeric name that should be available
      const uniqueName = `Fluffy${Math.floor(Math.random() * 100000)}`;
      const res = await app.request(`/api/avatars/check-name/${uniqueName}`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.available).toBe(true);
    });

    it('should return unavailable for short name', async () => {
      const res = await app.request('/api/avatars/check-name/AB');
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.available).toBe(false);
      expect(data.reason).toContain('3-20');
    });

    it('should return unavailable for non-alphanumeric name', async () => {
      const res = await app.request('/api/avatars/check-name/Test@Avatar');
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.available).toBe(false);
    });
  });

  describe('PATCH /api/avatars/me (Update Position)', () => {
    it('should fail without authentication', async () => {
      const res = await app.request('/api/avatars/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionX: 100, positionY: 200 }),
      });

      expect(res.status).toBe(401);
    });

    it('should update position when authenticated', async () => {
      const res = await app.request('/api/avatars/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: testSessionCookie,
        },
        body: JSON.stringify({ positionX: 500, positionY: 300 }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.avatar.positionX).toBe(500);
      expect(data.avatar.positionY).toBe(300);
    });

    it('should fail with invalid position', async () => {
      const res = await app.request('/api/avatars/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: testSessionCookie,
        },
        body: JSON.stringify({ positionX: -10, positionY: 200 }),
      });

      expect(res.status).toBe(400);
    });
  });
});
