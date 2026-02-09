import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { authRoutes } from './routes/auth';
import { petRoutes } from './routes/pets';
import { locationRoutes } from './routes/locations';
import { chatRoutes } from './routes/chat';
import { itemRoutes } from './routes/items';
import type { AppContext } from './types';

const app = new Hono<AppContext>();

// Global middleware
app.use('*', logger());
app.use('*', secureHeaders());
app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
        .split(',')
        .map((o) => o.trim());
      if (origin && allowedOrigins.includes(origin)) return origin;
      if (origin?.startsWith('http://localhost:')) return origin;
      return allowedOrigins[0];
    },
    credentials: true,
  })
);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.route('/api/auth', authRoutes);
app.route('/api/pets', petRoutes);
app.route('/api/locations', locationRoutes);
app.route('/api/locations', chatRoutes);
app.route('/api/items', itemRoutes);

// Error handler
app.onError((err, c) => {
  console.error('API Error:', err);
  if (err instanceof HTTPException) {
    return c.json({ error: err.message, code: err.status }, err.status);
  }
  return c.json({ error: 'Internal server error', code: 500 }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found', code: 404 }, 404);
});

const port = parseInt(process.env.PORT || '4000', 10);
console.log(`Starting LegacyApp API on port ${port}...`);

export default {
  port,
  fetch: app.fetch,
};
