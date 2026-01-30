import { beforeAll, afterAll } from 'vitest';

// Load environment variables
import 'dotenv/config';

beforeAll(async () => {
  // Setup before all tests
  console.log('Test setup complete');
});

afterAll(async () => {
  // Cleanup after all tests
  console.log('Test cleanup complete');
});
