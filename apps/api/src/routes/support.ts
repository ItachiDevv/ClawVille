/**
 * Lean in-product support tickets — POST /api/support/tickets.
 *
 * Filable by ANY subject (user / connected-agent / guest) so nobody who needs
 * help is locked out. Each ticket is persisted to `support_tickets` (append-only,
 * never lost) and then best-effort relayed to the itachi-debug Telegram bot so the
 * team sees it immediately. The Telegram relay fail-opens: a missing/broken bot
 * never blocks the user's submission.
 *
 * Intentionally lean — no admin triage UI, no dispute-audit workflow. The
 * self-serve fairness path is the provably-fair verifier (/cove/verify); this is
 * the human escape hatch ("our math is solid; if a player needs to, they file").
 *
 * Same-diff docs: ARCHITECTURE.md (route + table), GameFeatures.md (support flow).
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db, supportTickets, avatars, eq, and } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import {
  AGENT_SESSION_HEADER,
  resolveAgentSession,
} from '../middleware/require-auth-or-agent';
import type { AppContext } from '../types';

export const supportRouter = new Hono<AppContext>();
supportRouter.use('*', sessionMiddleware);

// ─── Input ──────────────────────────────────────────────────────────────────

const CATEGORIES = ['bug', 'payment', 'fairness', 'account', 'gameplay', 'other'] as const;

const ticketSchema = z
  .object({
    category: z.enum(CATEGORIES),
    subject: z.string().trim().max(200).optional(),
    message: z.string().trim().min(1).max(4000),
    context: z
      .object({
        page: z.string().max(200).optional(),
        url: z.string().max(500).optional(),
        game: z.string().max(40).optional(),
        eventId: z.string().max(64).optional(),
        userAgent: z.string().max(400).optional(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

// ─── Per-subject rate limit (in-memory sliding window) ───────────────────────
// Lean anti-spam: at most MAX_PER_WINDOW tickets per subject per window. Process-
// local (good enough for abuse damping; not a security boundary). Keyed by the
// strongest identity available so a guest can't bypass via logout.

const WINDOW_MS = 10 * 60_000; // 10 min
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

// ─── Telegram relay (best-effort, fail-open, PLAIN TEXT) ─────────────────────
// Plain text (NO parse_mode) so user-supplied content can't break formatting or
// inject Markdown. Never throws — a broken bot must not fail the submission.

const TG_TOKEN = process.env.ITACHI_DEBUG_BOT_TOKEN;
const TG_CHAT = process.env.ITACHI_DEBUG_CHAT_ID;

async function relayToTelegram(t: {
  id: string;
  subjectType: string;
  who: string;
  category: string;
  subject?: string;
  message: string;
  context?: Record<string, unknown> | null;
}): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('[support] Telegram not configured — ticket persisted, not relayed', { id: t.id });
    return;
  }
  const ctxLine = t.context ? `\ncontext: ${JSON.stringify(t.context)}` : '';
  const body =
    `🎫 ClawVille support ticket\n` +
    `id: ${t.id}\n` +
    `from: ${t.subjectType} (${t.who})\n` +
    `category: ${t.category}\n` +
    (t.subject ? `subject: ${t.subject}\n` : '') +
    `\n${t.message.slice(0, 1500)}` +
    (t.message.length > 1500 ? ' …[truncated]' : '') +
    ctxLine;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: body }),
    });
  } catch (err) {
    console.warn('[support] Telegram relay failed (ticket still persisted)', err);
  }
}

// ─── POST /tickets ────────────────────────────────────────────────────────────

supportRouter.post('/tickets', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ticketSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const input = parsed.data;

  // Resolve identity: user (Lucia) → agent (session header) → guest (fp).
  const user = c.get('user');
  const fpHash = c.get('fpHash') ?? null;

  let subjectType: 'user' | 'agent' | 'guest';
  let userId: string | null = null;
  let avatarId: string | null = null;
  let agentId: string | null = null;

  if (user) {
    subjectType = 'user';
    userId = user.id;
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });
    avatarId = avatar?.id ?? null;
  } else {
    const sessionId = c.req.header(AGENT_SESSION_HEADER);
    const resolved = sessionId ? await resolveAgentSession(sessionId) : null;
    if (resolved) {
      subjectType = 'agent';
      agentId = resolved.agentId;
      userId = resolved.userId ?? null;
      avatarId = resolved.avatarId ?? null;
    } else {
      subjectType = 'guest';
    }
  }

  // Rate limit on the strongest identity available.
  const rlKey =
    userId ? `u:${userId}` : agentId ? `a:${agentId}` : fpHash ? `g:${fpHash}` : 'g:anon';
  if (rateLimited(rlKey)) {
    throw new HTTPException(429, {
      message: 'rate_limited: too many tickets — please wait a few minutes before submitting another',
    });
  }

  const [row] = await db
    .insert(supportTickets)
    .values({
      subjectType,
      userId,
      avatarId,
      agentId,
      fpHash,
      category: input.category,
      subject: input.subject ?? null,
      message: input.message,
      context: input.context ?? null,
      status: 'open',
    })
    .returning({ id: supportTickets.id, status: supportTickets.status });

  if (!row) throw new HTTPException(500, { message: 'ticket_insert_failed' });

  // Best-effort notify (never blocks the response on a slow/broken bot).
  void relayToTelegram({
    id: row.id,
    subjectType,
    who: userId ?? agentId ?? fpHash ?? 'anon',
    category: input.category,
    subject: input.subject,
    message: input.message,
    context: input.context ?? null,
  });

  return c.json({ ticketId: row.id, status: row.status }, 201);
});
