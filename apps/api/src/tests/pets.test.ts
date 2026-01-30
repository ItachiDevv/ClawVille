import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, users, pets, agents } from '@elizapets/database';
import { petRoutes } from '../routes/pets';
import { authRoutes } from '../routes/auth';
import type { AppContext } from '../types';

// Test user credentials
const TEST_EMAIL = `test-${Date.now()}@elizapets-test.com`;
const TEST_PASSWORD = 'testpassword123';
let testUserId: string;
let testSessionCookie: string;

// Create test app
function createTestApp() {
  const app = new Hono<AppContext>();
  app.route('/api/auth', authRoutes);
  app.route('/api/pets', petRoutes);
  return app;
}

describe('Pet API Tests', () => {
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
      await db.delete(pets).where(eq(pets.userId, testUserId));
      await db.delete(agents).where(eq(agents.userId, testUserId));
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  describe('POST /api/pets (Create Pet)', () => {
    it('should fail without authentication', async () => {
      const res = await app.request('/api/pets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'TestPet',
          species: 'cat',
          color: 'green',
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
          characterConfig: {
            bio: 'A friendly test pet',
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
      const res = await app.request('/api/pets', {
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
            bio: 'A friendly test pet',
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
      const res = await app.request('/api/pets', {
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
            bio: 'A friendly test pet',
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
      const res = await app.request('/api/pets', {
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
            bio: 'A friendly test pet',
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

    it('should create pet successfully with valid data', async () => {
      const petName = `TestPet${Date.now()}`;
      const res = await app.request('/api/pets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: testSessionCookie,
        },
        body: JSON.stringify({
          name: petName,
          species: 'cat',
          color: 'green',
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
          characterConfig: {
            bio: 'A friendly test pet that loves adventures',
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
      expect(data.pet).toBeDefined();
      expect(data.pet.name).toBe(petName);
      expect(data.pet.species).toBe('cat');
      expect(data.pet.color).toBe('green');
      expect(data.pet.platformAgentId).toBeDefined();
      expect(data.agentId).toBeDefined();

      // Verify stats were calculated correctly
      // forest (s:3, d:4, m:3) + exploring (s:1, d:1, m:3) + wave-hello (s:1, d:2, m:2)
      expect(data.pet.stats.strength).toBe(5);
      expect(data.pet.stats.defence).toBe(7);
      expect(data.pet.stats.movement).toBe(8);
    });

    it('should fail when user already has a pet', async () => {
      const res = await app.request('/api/pets', {
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
            bio: 'A fierce dragon pet that breathes fire',
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

  describe('GET /api/pets/me', () => {
    it('should fail without authentication', async () => {
      const res = await app.request('/api/pets/me');
      expect(res.status).toBe(401);
    });

    it('should return user pet when authenticated', async () => {
      const res = await app.request('/api/pets/me', {
        headers: { Cookie: testSessionCookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.pet).toBeDefined();
      expect(data.pet.userId).toBe(testUserId);
    });
  });

  describe('GET /api/pets/check-name/:name', () => {
    it('should return available for new name', async () => {
      // Use a simple alphanumeric name that should be available
      const uniqueName = `Fluffy${Math.floor(Math.random() * 100000)}`;
      const res = await app.request(`/api/pets/check-name/${uniqueName}`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.available).toBe(true);
    });

    it('should return unavailable for short name', async () => {
      const res = await app.request('/api/pets/check-name/AB');
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.available).toBe(false);
      expect(data.reason).toContain('3-20');
    });

    it('should return unavailable for non-alphanumeric name', async () => {
      const res = await app.request('/api/pets/check-name/Test@Pet');
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.available).toBe(false);
    });
  });

  describe('PATCH /api/pets/me (Update Position)', () => {
    it('should fail without authentication', async () => {
      const res = await app.request('/api/pets/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionX: 100, positionY: 200 }),
      });

      expect(res.status).toBe(401);
    });

    it('should update position when authenticated', async () => {
      const res = await app.request('/api/pets/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: testSessionCookie,
        },
        body: JSON.stringify({ positionX: 500, positionY: 300 }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.pet.positionX).toBe(500);
      expect(data.pet.positionY).toBe(300);
    });

    it('should fail with invalid position', async () => {
      const res = await app.request('/api/pets/me', {
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
