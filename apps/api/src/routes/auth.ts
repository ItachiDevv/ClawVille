import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, or, isNull } from 'drizzle-orm';
import { lucia } from '../lib/auth';
import { db, users, openclawBots, avatars } from '@clawville/database';
import { npcSimulation } from '../services/npc-simulation';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { validateLiveAgentSession } from '../middleware/require-auth-or-agent';
import { consumeTicket } from '../services/session-ticket-service';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { issueAuthToken, consumeAuthToken } from '../services/auth-token-service';
import { sendEmail, isGuestEmail } from '../services/email-service';
import {
  provisionAvatarAgentForSignup,
  runProvisioningFailSoft,
  isAgentProvisioningPending,
  type ProvisionAvatarAgentResult,
} from '../services/avatar-agent-provisioning';
import {
  verifyEmailTemplate,
  resetPasswordTemplate,
} from '../templates/email-templates';
import { logEventFromContext } from '../services/event-logger';
import type { AppContext } from '../types';
import { z } from 'zod';
import { DEFAULT_AGENT_MODEL_KEY } from '@clawville/shared';

export const authRoutes = new Hono<AppContext>();

authRoutes.use('*', sessionMiddleware);

// Get current user.
//
// Surface `emailVerified` + `isGuest` alongside the Lucia attributes so
// the frontend banner (`/game` soft-verify nudge) can render off a
// single `api.me()` call without a second round-trip. Lucia's attribute
// mapping doesn't include either column today, so we read them off the
// raw `users` row. Cost: one indexed PK lookup per `/me` call — same
// shape as the agent-banner dismissal read below.
authRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const row = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: { emailVerified: true, isGuest: true },
  });
  return c.json({
    user: {
      ...user,
      emailVerified: !!row?.emailVerified,
      isGuest: !!row?.isGuest,
    },
  });
});

// Phase 6 — authoritative server-side "is the user's agent connected?"
// probe for UI hydration. Zustand's `agentConnected` flag is client-only
// and defaults false on every page load; without this endpoint the UI
// would show "Connect Your Agent" for a user whose Hermes/Milady agent
// was already running, OR (worse, pre-sweeper) show "Connected" long
// after the Hermes agent exited because the modal's stale polling cache
// was the only source of truth.
//
// Resolution order:
//   1. Milady-harnessed avatars → always considered connected because
//      ClawVille hosts their Eliza runtime end-to-end. Session handle
//      surfaces as `avatar.platformAgentId`; there's no openclaw_bots row
//      to check because the agent IS the avatar.
//   2. Otherwise, look up the most-recent openclaw_bots row for the
//      user and check `session_expires_at`. Expired or missing → not
//      connected. The row isn't deleted on expiry; the agent can
//      reconnect with the signed-challenge flow and the handle resumes.
// Hosted harnesses are runtimes ClawVille runs server-side. Their avatars
// are always reachable (no external process to time out). External harnesses
// (openclaw / custom) point at a process the user runs locally — their
// liveness is derived from how recently the bot acted.
const HOSTED_HARNESSES = new Set(['milady', 'hermes']);
const EXTERNAL_ACTIVE_WINDOW_MS = (() => {
  const raw = process.env.EXTERNAL_BOT_ACTIVE_WINDOW_SECONDS;
  const n = raw ? Number.parseInt(raw, 10) : 300;
  return Number.isFinite(n) && n > 0 ? n * 1000 : 300_000; // default 5 min
})();

authRoutes.get('/me/agent-session', requireAuth, async (c) => {
  const user = c.get('user');

  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
    columns: { id: true, harness: true, platformAgentId: true, flags: true },
  });

  // External agent path takes precedence — if an openclaw_bots row exists,
  // its actual recent activity (NOT the 24h TTL) is the authoritative
  // liveness signal. A user who paired Hermes locally and then killed the
  // process should see the banner go gray within EXTERNAL_ACTIVE_WINDOW_MS
  // of the last action, not wait for a 24h sweep. The 24h TTL still gates
  // reconnect/replay; that's a separate concern.
  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.userId, user.id),
    orderBy: (t, { desc }) => [desc(t.lastSeenAt)],
    columns: {
      agentId: true,
      lastSeenAt: true,
      sessionExpiresAt: true,
      identityType: true,
    },
  });

  if (bot) {
    const now = Date.now();
    const lastSeenMs = bot.lastSeenAt.getTime();
    const expired =
      bot.sessionExpiresAt !== null && bot.sessionExpiresAt.getTime() <= now;
    const idle = now - lastSeenMs > EXTERNAL_ACTIVE_WINDOW_MS;

    if (expired) {
      return c.json({
        connected: false,
        reason: 'expired',
        mode: 'external-expired',
        agentId: bot.agentId,
        lastSeenAt: bot.lastSeenAt.toISOString(),
        expiresAt: bot.sessionExpiresAt!.toISOString(),
      });
    }

    if (idle) {
      // Bot still has a valid sessionId (within 24h TTL) but hasn't acted
      // recently — local process likely killed, laptop slept, etc. UI
      // should show "paired, idle" rather than green.
      return c.json({
        connected: false,
        reason: 'idle',
        mode: 'external-idle',
        agentId: bot.agentId,
        lastSeenAt: bot.lastSeenAt.toISOString(),
        idleSinceMs: now - lastSeenMs,
        canReconnect: true,
      });
    }

    return c.json({
      connected: true,
      mode: 'external-active',
      agentId: bot.agentId,
      harness: avatar?.harness ?? bot.identityType ?? null,
      expiresAt: bot.sessionExpiresAt?.toISOString() ?? null,
      lastSeenAt: bot.lastSeenAt.toISOString(),
    });
  }

  // No external bot — fall through to the hosted-harness carve-out for
  // avatars whose runtime ClawVille runs server-side (milady, hermes).
  // The dismissal flag (avatars.flags.agentBannerDismissed) lets the user
  // suppress the banner without anything to actually "disconnect" — the
  // server runtime is always alive in those cases; this is purely a UI
  // preference. Cleared automatically by /api/agent/connect-token when
  // the user generates a fresh pair link.
  const flags = (avatar?.flags as { agentBannerDismissed?: boolean } | null) ?? {};
  if (flags.agentBannerDismissed === true) {
    return c.json({
      connected: false,
      reason: 'dismissed',
      mode: 'dismissed',
      harness: avatar?.harness ?? null,
    });
  }

  if (avatar && HOSTED_HARNESSES.has(avatar.harness ?? '') && avatar.platformAgentId) {
    return c.json({
      connected: true,
      mode: 'hosted',
      agentId: avatar.platformAgentId,
      harness: avatar.harness,
      expiresAt: null,
      lastSeenAt: null,
    });
  }

  // P2 Slice B (2026-07-04) — derived 'agent-provisioning-pending' (D1
  // migration, NO DDL). Evaluated ONLY here at the old 'none' fall-through:
  // the bot-row precedence, 'dismissed', and 'hosted' branches above are
  // untouched. A resolved authenticated NON-guest user with no avatar (or an
  // avatar without a platformAgentId) is in the transitional
  // provisioning-pending state — the account exists but its agent rows
  // don't, e.g. a legacy "Player tier" account or a signup whose fail-soft
  // provisioning failed. Guests keep mode 'none' (never pending). One extra
  // indexed PK read, only on this cold branch — hot branches pay nothing.
  // `connected` stays false; `hasAvatar` tells the client whether the
  // /create-agent surface should PATCH (prefill) or POST (fresh create).
  //
  // The read is required: Lucia's user attributes (getUserAttributes in
  // lib/auth.ts) map only email/name/avatar_url/username — NOT is_guest — so
  // c.get('user') can't answer the guest question. This one indexed PK read
  // only runs on the cold fall-through (guests + non-provisioned users); the
  // hot bot-row / hosted / dismissed branches above return before it.
  const userRow = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: { isGuest: true },
  });
  if (
    isAgentProvisioningPending({
      isGuest: !!userRow?.isGuest,
      hasAvatar: !!avatar,
      hasPlatformAgent: !!avatar?.platformAgentId,
    })
  ) {
    return c.json({
      connected: false,
      reason: 'no_bot',
      mode: 'provisioning-pending',
      hasAvatar: !!avatar,
    });
  }

  return c.json({ connected: false, reason: 'no_bot', mode: 'none' });
});

// Logout
authRoutes.post('/logout', requireAuth, async (c) => {
  const session = c.get('session');
  const user = c.get('user');
  await lucia.invalidateSession(session.id);
  const cookie = lucia.createBlankSessionCookie();
  c.header('Set-Cookie', cookie.serialize());

  void logEventFromContext(c, {
    eventType: 'auth.logout',
    userId: user.id,
    sessionId: session.id,
    payload: {
      route: 'POST /api/auth/logout',
      outcome: 'success',
    },
  });

  return c.json({ success: true });
});

// Signup
const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

// P2 Slice A (2026-07-04, plan hard-constraint #8) — signup now fans out to
// agent+avatar provisioning INCLUDING a custodial wallet mint (Cloudflare
// Worker key wraps), so it must carry the same 5/min/IP account-mint budget
// as every other mint surface (`autoProvisionRateLimiter` in avatars.ts,
// `guestRateLimiter` below, `connectRateLimiter` in agent-gateway.ts).
// Checked BEFORE any DB work.
const signupRateLimiter = createRateLimiter({
  maxPerWindow: 5,
  windowMs: 60_000,
});

authRoutes.post('/signup', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!signupRateLimiter.check(ip)) {
    throw new HTTPException(429, {
      message: 'Too many signups from this IP. Try again in 1 minute.',
    });
  }

  const body = await c.req.json();
  const result = signupSchema.safeParse(body);

  if (!result.success) {
    // Surface the specific validation issue so the user knows WHY they
    // were rejected (wrong email format? password too short?). Previously
    // the generic "Invalid input" left users staring at a form that
    // looked fine to them. Zod's first issue is enough context: we only
    // validate 3 fields and any single failure is user-actionable.
    const first = result.error.issues[0];
    const field = first.path.join('.') || 'input';
    throw new HTTPException(400, {
      message: `Invalid ${field}: ${first.message}`,
    });
  }

  const { email: rawEmail, password, name } = result.data;
  const email = rawEmail.toLowerCase();

  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (existingUser) {
    throw new HTTPException(400, { message: 'Email already registered' });
  }

  const passwordHash = await Bun.password.hash(password, {
    algorithm: 'bcrypt',
    cost: 10,
  });

  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    email,
    passwordHash,
    name: name || email.split('@')[0],
  });

  const session = await lucia.createSession(userId, {});
  const cookie = lucia.createSessionCookie(session.id);
  c.header('Set-Cookie', cookie.serialize());

  // P2 Slice A (2026-07-04) — Path B: email signup PROVISIONS the agent
  // (model doc §1; D4: default = ClawVille-hosted ElizaOS / Milady-harness).
  // Rows only — platform_agents 'avatar-agent' + avatars + username init +
  // custodial wallet; the runtime lazy-starts on first chat (NO warm here —
  // plugin-sql mutex/boot-crush + the D8 cost guardrail). FAIL-SOFT: any
  // provisioning failure logs and the signup still 200s WITHOUT the agent
  // fields — the account then surfaces as mode 'provisioning-pending' on
  // /me/agent-session (Slice B) instead of a broken promise. Idempotent by
  // userId (guards double-submit). Avatar name derives from the signup
  // 'name' field, else the email local-part (sanitized + suffix-retry on
  // the global name UNIQUE).
  const provisioned: ProvisionAvatarAgentResult | null = await runProvisioningFailSoft(
    'signup auto-provision',
    () => provisionAvatarAgentForSignup(userId, { name, email }),
  );

  void logEventFromContext(c, {
    eventType: 'auth.signup',
    userId,
    sessionId: session.id,
    payload: {
      route: 'POST /api/auth/signup',
      isGuestEmail: isGuestEmail(email),
      agentProvisioned: !!provisioned,
      outcome: 'success',
    },
  });

  // Soft email-verification — fire-and-forget. Signup succeeds even if
  // the email send fails (degraded UX is recoverable; failed signup is
  // not). Guest placeholders never receive mail. Errors are logged
  // inside `sendEmail`; we still `.catch` here to belt-and-braces the
  // promise so an unexpected throw can't unhandled-reject the worker.
  if (!isGuestEmail(email)) {
    (async () => {
      try {
        const token = await issueAuthToken({ userId, purpose: 'email-verify' });
        const verifyUrl = `${webOriginForRedirect()}/verify-email?token=${encodeURIComponent(token.rawToken)}`;
        const payload = verifyEmailTemplate({
          userName: name || email.split('@')[0],
          verifyUrl,
        });
        await sendEmail({
          to: email,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          tag: 'verify-email-signup',
        });
      } catch (err) {
        console.warn('[auth/signup] verification email failed', err);
      }
    })().catch(() => {});
  }

  // Response ADDS the avatar + one-time wallet payload with the SAME field
  // names/shape `POST /api/avatars` returns today (`avatar` = full row,
  // `agentId` = platform_agents id, `wallet` = { address, secretKey,
  // chain:'solana' } present ONLY when the wallet was freshly created —
  // exactly-once discipline unchanged, the server never re-emits). On
  // provisioning failure the response is the legacy `{ success: true }`.
  return c.json({
    success: true,
    ...(provisioned
      ? {
          avatar: provisioned.avatar,
          agentId: provisioned.agentId,
          ...(provisioned.wallet ? { wallet: provisioned.wallet } : {}),
        }
      : {}),
  });
});

// Login
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json();
  const result = loginSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid input' });
  }

  const { email: rawEmail, password } = result.data;
  const email = rawEmail.toLowerCase();

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!user || !user.passwordHash) {
    // Log auth failure WITHOUT userId (since the email might not match
    // any user). fpHash + ipPrefixHash are still captured by
    // logEventFromContext, which is what we need to detect
    // bruteforce / credential stuffing patterns by IP prefix.
    void logEventFromContext(c, {
      eventType: 'auth.login.failed',
      payload: {
        route: 'POST /api/auth/login',
        reason: 'no_user_or_no_hash',
        outcome: '401',
      },
    });
    throw new HTTPException(401, { message: 'Invalid email or password' });
  }

  const validPassword = await Bun.password.verify(password, user.passwordHash);
  if (!validPassword) {
    void logEventFromContext(c, {
      eventType: 'auth.login.failed',
      userId: user.id,
      payload: {
        route: 'POST /api/auth/login',
        reason: 'bad_password',
        outcome: '401',
      },
    });
    throw new HTTPException(401, { message: 'Invalid email or password' });
  }

  const session = await lucia.createSession(user.id, {});
  const cookie = lucia.createSessionCookie(session.id);
  c.header('Set-Cookie', cookie.serialize());

  void logEventFromContext(c, {
    eventType: 'auth.login',
    userId: user.id,
    sessionId: session.id,
    payload: {
      route: 'POST /api/auth/login',
      outcome: 'success',
    },
  });

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Password reset + email verification
// ---------------------------------------------------------------------------
//
// Four endpoints share one design discipline: NEVER leak whether a
// given email is registered. `/forgot-password` always returns 200,
// `/reset-password` returns the same 400 for "bad token" / "expired" /
// "already used", and the GET verify route always 302s.
//
// Tokens are stored sha256-hashed (`auth_tokens.tokenHash`) and consumed
// atomically via UPDATE ... RETURNING in `auth-token-service`. The raw
// token lives only inside the email URL.

const FORGOT_PWD_IP_LIMITER = createRateLimiter({
  maxPerWindow: 5,
  windowMs: 60 * 60 * 1000, // 1 hr
});
const FORGOT_PWD_EMAIL_LIMITER = createRateLimiter({
  maxPerWindow: 3,
  windowMs: 60 * 60 * 1000, // 1 hr
});
const SEND_VERIFY_USER_LIMITER = createRateLimiter({
  maxPerWindow: 3,
  windowMs: 60 * 60 * 1000, // 1 hr
});

// Constant-time bcrypt dummy hash — burned once at module load so the
// `enumeration-prevention` branch in /forgot-password does the same
// amount of CPU work as a real verify regardless of whether the email
// exists. Without this an attacker can probe "is foo@x.com registered"
// by measuring response latency. Bcrypt cost 10 matches the login
// path's cost (signup uses cost 10), so both branches converge on the
// same wall clock.
//
// `Bun.password.verify` does a constant-time compare internally — the
// only cost variance comes from "is there a hash to verify against".
// Verifying against THIS hash with any password takes the same time as
// verifying against a real user's hash, so an attacker watching the
// latency curve sees a flat line whether or not the email is in the DB.
const DUMMY_PWD_HASH_PROMISE: Promise<string> = Bun.password.hash(
  'enumeration-prevention-dummy-input',
  { algorithm: 'bcrypt', cost: 10 },
);

const forgotPasswordSchema = z.object({
  email: z.string().email().max(255),
});

authRoutes.post('/forgot-password', async (c) => {
  const ip = getClientIp(c.req.raw.headers);

  // IP rate limit first — burned even on bad body. Stops a single IP
  // from sweeping a leaked email list. 429 is intentional even though
  // it leaks "you hit the limit"; the limit is high enough relative to
  // typical legit retries that a real user almost never sees it.
  if (!FORGOT_PWD_IP_LIMITER.check(ip)) {
    throw new HTTPException(429, {
      message: 'Too many password reset requests. Try again in an hour.',
    });
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = forgotPasswordSchema.safeParse(body);

  // Invalid body: still return the generic success message — never
  // let a 400 distinguish "email format wrong" from "email not on the
  // list". The shape of the response stays identical so the client
  // can't infer anything about the input.
  if (!parsed.success) {
    return c.json({
      ok: true,
      message: 'If that email is registered, we sent you a link.',
    });
  }

  const email = parsed.data.email.toLowerCase();

  // Per-email rate limit — independent bucket so an attacker can't
  // burn the IP budget to mask the per-email signal. If both limits
  // pass we proceed to token issuance.
  const overEmailLimit = !FORGOT_PWD_EMAIL_LIMITER.check(`pw:${email}`);

  // Look up the user — but ALWAYS execute the constant-time bcrypt
  // verify regardless of result so the response time is independent
  // of "user exists?".
  const user = !isGuestEmail(email)
    ? await db.query.users.findFirst({
        where: eq(users.email, email),
        columns: { id: true, name: true, email: true, isGuest: true },
      })
    : null;

  // Constant-time arm — fire the bcrypt verify whether or not we
  // found a user. Result discarded. This burns ~70-100ms of cost so
  // the timing of /forgot-password matches /login regardless of
  // outcome. Done in parallel with the conditional send below so we
  // don't double the response latency.
  const timingPromise = DUMMY_PWD_HASH_PROMISE.then((hash) =>
    Bun.password.verify('enumeration-prevention-dummy-input', hash),
  ).catch(() => false);

  // Conditional send — only if the user exists AND isn't a guest AND
  // we're not over the email bucket. CRITICAL: dispatched as a
  // fire-and-forget IIFE so the awaited Resend round-trip (~100-500ms)
  // does NOT extend the response window for real-user-email branches
  // (adversary H1, 2026-05-22). The earlier `await sendEmail(...)`
  // here re-opened the timing channel the dummy bcrypt was supposed
  // to close — existing email = ~150-500ms, missing email = ~70-100ms
  // was enumerable via wall-clock latency. Mirrors the fire-and-forget
  // verify-email pattern in /signup.
  if (user && !user.isGuest && user.email && !overEmailLimit) {
    const { id: userId, name: userName, email: userEmail } = user;
    void (async () => {
      try {
        const token = await issueAuthToken({
          userId,
          purpose: 'password-reset',
        });
        const resetUrl = `${webOriginForRedirect()}/reset-password?token=${encodeURIComponent(token.rawToken)}`;
        const payload = resetPasswordTemplate({
          userName: userName || userEmail.split('@')[0],
          resetUrl,
        });
        await sendEmail({
          to: userEmail,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          tag: 'password-reset',
        });
      } catch (err) {
        // Log only — never surface failures to the caller (would leak
        // existence by virtue of a 500 on real-user-email vs 200 on
        // bogus-email).
        console.warn('[auth/forgot-password] token issue / send failed', err);
      }
    })();
  }

  // Await ONLY the constant-time bcrypt arm so the response can't
  // return before the dummy verify completes. Both branches now
  // produce a response after the SAME awaited work — flat timing.
  await timingPromise;

  return c.json({
    ok: true,
    message: 'If that email is registered, we sent you a link.',
  });
});

const resetPasswordSchema = z.object({
  token: z.string().min(16).max(256),
  newPassword: z.string().min(8).max(200),
});

authRoutes.post('/reset-password', async (c) => {
  const ip = getClientIp(c.req.raw.headers);

  // Same IP rate limit as /forgot — prevents bruteforcing the token
  // space (already ~256 bits but defense-in-depth).
  if (!FORGOT_PWD_IP_LIMITER.check(`reset:${ip}`)) {
    throw new HTTPException(429, {
      message: 'Too many reset attempts. Try again in an hour.',
    });
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = resetPasswordSchema.safeParse(body);

  // Generic 400 for any failure — body shape, missing fields, weak
  // password, whatever. Never specify which field failed.
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'Invalid or expired reset link.',
    });
  }

  const consumed = await consumeAuthToken({
    rawToken: parsed.data.token,
    purpose: 'password-reset',
  });

  if (!consumed) {
    throw new HTTPException(400, {
      message: 'Invalid or expired reset link.',
    });
  }

  // Refuse to reset a guest user's "password" — guests have a
  // placeholder `$guest$disabled$...` hash that's never meant to be
  // overwritten. Treat as if the token had expired so an attacker
  // who somehow got a guest's token (which they shouldn't — guests
  // can't trigger /forgot-password because their email pattern is
  // filtered) still sees the generic failure path.
  const target = await db.query.users.findFirst({
    where: eq(users.id, consumed.userId),
    columns: { id: true, email: true, isGuest: true, passwordHash: true },
  });
  if (!target || target.isGuest || !target.email) {
    throw new HTTPException(400, {
      message: 'Invalid or expired reset link.',
    });
  }

  // Hash + persist. Cost 10 matches login + signup so login timing
  // stays consistent post-reset.
  const newHash = await Bun.password.hash(parsed.data.newPassword, {
    algorithm: 'bcrypt',
    cost: 10,
  });

  // Invalidate ALL existing Lucia sessions BEFORE issuing the fresh
  // one. If the reset was triggered because the account was
  // compromised, this is the moment the attacker's stolen cookie
  // dies. Order matters: invalidate THEN write the new hash THEN
  // create the new session — so a race that interleaves the two
  // pages can't leave a stale session valid.
  await lucia.invalidateUserSessions(target.id);

  await db
    .update(users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, target.id));

  void logEventFromContext(c, {
    eventType: 'auth.password.reset',
    userId: target.id,
    payload: {
      route: 'POST /api/auth/reset-password',
      sessionsInvalidated: true,
      outcome: 'success',
    },
  });

  return c.json({ ok: true });
});

// POST /api/auth/send-verification — authenticated users only.
// No-op (silent 200) for guests so the UI can render the same banner
// state for every account without branching client-side. 3/hr/user
// rate limit; 3 retries is plenty (one initial + two "try the spam
// folder" attempts) without giving attackers a budget to enumerate.
authRoutes.post('/send-verification', requireAuth, async (c) => {
  const user = c.get('user');

  if (!user.email || isGuestEmail(user.email)) {
    // Silent no-op — return 200 so the UI doesn't show a confusing
    // error to a guest who clicked the banner button.
    return c.json({ ok: true, sent: false, reason: 'no_email' });
  }

  // Re-read to pick up isGuest (Lucia attributes don't expose it).
  const row = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: { id: true, email: true, name: true, isGuest: true, emailVerified: true },
  });
  if (!row || row.isGuest || !row.email) {
    return c.json({ ok: true, sent: false, reason: 'no_email' });
  }
  if (row.emailVerified) {
    // Already done — don't spam. Return a benign 200 so the UI can
    // clear the banner without an error.
    return c.json({ ok: true, sent: false, reason: 'already_verified' });
  }

  if (!SEND_VERIFY_USER_LIMITER.check(`verify:${user.id}`)) {
    throw new HTTPException(429, {
      message: 'Too many verification emails. Try again in an hour.',
    });
  }

  try {
    const token = await issueAuthToken({
      userId: row.id,
      purpose: 'email-verify',
    });
    const verifyUrl = `${webOriginForRedirect()}/verify-email?token=${encodeURIComponent(token.rawToken)}`;
    const payload = verifyEmailTemplate({
      userName: row.name || row.email.split('@')[0],
      verifyUrl,
    });
    await sendEmail({
      to: row.email,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      tag: 'verify-email-resend',
    });
  } catch (err) {
    console.warn('[auth/send-verification] failed', err);
    // Still 200 — caller doesn't need to know about server-side
    // email plumbing; retry budget already burned.
  }

  return c.json({ ok: true, sent: true });
});

// GET /api/auth/verify-email?t=... — consume the token, flip
// `users.emailVerified=true`, redirect to /game?verified=1. Mirrors
// the `Referrer-Policy: no-referrer` discipline from /enter so the
// token never leaks via the Referer header on the next outbound
// request from /game.
authRoutes.get('/verify-email', async (c) => {
  const token = c.req.query('t');
  const webOrigin = webOriginForRedirect();

  c.header('Referrer-Policy', 'no-referrer');

  if (!token) {
    return c.redirect(`${webOrigin}/?error=verify-failed`, 302);
  }

  let consumed;
  try {
    consumed = await consumeAuthToken({
      rawToken: token,
      purpose: 'email-verify',
    });
  } catch (err) {
    console.warn('[auth/verify-email] consume threw', err);
    return c.redirect(`${webOrigin}/?error=verify-failed`, 302);
  }

  if (!consumed) {
    return c.redirect(`${webOrigin}/?error=verify-failed`, 302);
  }

  try {
    await db
      .update(users)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, consumed.userId));
  } catch (err) {
    console.warn('[auth/verify-email] flag update failed', err);
    return c.redirect(`${webOrigin}/?error=verify-failed`, 302);
  }

  return c.redirect(`${webOrigin}/game?verified=1`, 302);
});

// ---------------------------------------------------------------------------
// Milady session exchange — converts a ClawVille agent sessionId into a
// Lucia auth session so the embedded viewer can skip the login overlay.
//
// Flow:
//   1. Milady plugin connects via POST /api/agent/connect → gets sessionId
//   2. Plugin injects sessionId into the viewer's localStorage
//   3. ClawVille frontend calls this endpoint with that sessionId
//   4. We validate it, find/create a user, mint a Lucia cookie
//   5. Frontend is now authenticated as a "milady guest" user
//
// The guest user row uses email = `milady-<agentId>@clawville.guest`
// and a random password hash (never used — Milady guests don't log in
// via email/password). If the same Milady agent reconnects later, we
// find the existing user row and reuse it.
// ---------------------------------------------------------------------------

const miladyExchangeSchema = z.object({
  sessionId: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// In-memory rate limiter for milady-session-exchange
// Prevents brute-force attempts against the short session ID space.
// Max 5 attempts per minute per IP. Map auto-cleans on each request.
// ---------------------------------------------------------------------------
const miladyRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkMiladyRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = miladyRateLimitMap.get(ip);

  // Lazy cleanup: remove expired entries on each call (bounded by request volume)
  if (miladyRateLimitMap.size > 10000) {
    for (const [key, val] of miladyRateLimitMap) {
      if (val.resetAt <= now) miladyRateLimitMap.delete(key);
    }
  }

  if (!entry || entry.resetAt <= now) {
    miladyRateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  entry.count++;
  if (entry.count > 5) return false;
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/auth/enter?t=... — Phase 5 magic-link exchanger.
// ---------------------------------------------------------------------------
// Redeems a one-time agent-issued session ticket and swaps it for a
// real Lucia session cookie, then 302-redirects the browser to `/game`.
//
// The click-through is always from a human's browser (the agent passes
// the URL through chat), so setting `Set-Cookie` here is correct —
// the browser follows the redirect AND keeps the cookie.
//
// Spec §4.3 + §7:
//   - Atomic consume (UPDATE ... RETURNING * in session-ticket-service)
//   - Short TTL, enforced at DB level (`expires_at > now()`)
//   - One-time use
//   - `Referrer-Policy: no-referrer` set on both success and failure
//     redirects so the ticket never leaks through the Referer header
//     when /game or the error page makes its first outbound request.
// ---------------------------------------------------------------------------
function webOriginForRedirect(): string {
  if (process.env.WEB_ORIGIN) return process.env.WEB_ORIGIN.replace(/\/+$/, '');
  const corsOrigin = process.env.CORS_ORIGIN?.split(',')[0]?.trim();
  if (corsOrigin) return corsOrigin.replace(/\/+$/, '');
  return 'https://clawville.world';
}

authRoutes.get('/enter', async (c) => {
  const ticket = c.req.query('t');
  const webOrigin = webOriginForRedirect();

  // Always set Referrer-Policy before returning — on BOTH the happy
  // path (redirect to /game) and the error path (redirect to /).
  c.header('Referrer-Policy', 'no-referrer');

  if (!ticket) {
    return c.redirect(`${webOrigin}/?error=expired-link`, 302);
  }

  let consumed;
  try {
    consumed = await consumeTicket(ticket);
  } catch (err) {
    console.error('[AuthEnter] consume failed:', err);
    return c.redirect(`${webOrigin}/?error=expired-link`, 302);
  }

  if (!consumed) {
    // Invalid / expired / already-consumed — all three collapse to
    // the same UX. We deliberately don't distinguish them so an
    // attacker holding a stolen ticket can't probe for "was it
    // valid?" before bailing.
    return c.redirect(`${webOrigin}/?error=expired-link`, 302);
  }

  // Create the Lucia session — attributes match the form-login route
  // exactly (same cookie domain, same sameSite/secure settings via
  // `apps/api/src/lib/auth.ts`).
  let createdSessionId: string | null = null;
  try {
    const session = await lucia.createSession(consumed.userId, {});
    const cookie = lucia.createSessionCookie(session.id);
    c.header('Set-Cookie', cookie.serialize());
    createdSessionId = session.id;
  } catch (err) {
    console.error('[AuthEnter] session create failed:', err);
    return c.redirect(`${webOrigin}/?error=expired-link`, 302);
  }

  // Magic-link onboarding D1 (2026-07-02) — BIND-AT-REDEMPTION, the deferred
  // claim event. First-contact /connect deliberately does NOT bind
  // `openclaw_bots.user_id` (see the agent-gateway "deliberately do NOT bind"
  // comment); the human CLICKING the agent-issued link is the proof that this
  // agent belongs to this account, so the bind happens HERE. Atomic guarded
  // UPDATE: `user_id IS NULL OR user_id = <redeemer>` means we only fill an
  // unowned row or re-affirm the same owner — a DIFFERENT existing owner is
  // NEVER clobbered (skip + warn; `agentId` is a public handle, safe to log —
  // never log the ticket or any bearer). Best-effort: a bind failure must not
  // block the human's login, so the whole block is non-fatal.
  if (consumed.issuedToAgentId) {
    try {
      const bound = await db
        .update(openclawBots)
        .set({ userId: consumed.userId, updatedAt: new Date() })
        .where(
          and(
            eq(openclawBots.agentId, consumed.issuedToAgentId),
            or(
              isNull(openclawBots.userId),
              eq(openclawBots.userId, consumed.userId),
            ),
          ),
        )
        .returning({ id: openclawBots.id });
      if (bound.length > 0) {
        // Propagate onto the LIVE in-memory session config(s) so the agent's
        // demotion backstop (`resolveAgentSession`: config.boundUserId must
        // equal the row's userId) passes WITHOUT a reconnect — the connected
        // agent becomes ledger-capable the moment its human lands in-game.
        npcSimulation.bindAgentOwner(consumed.issuedToAgentId, consumed.userId);
      } else {
        // Row missing, or already owned by a DIFFERENT user (the guard
        // refused). Either way: no bind, login proceeds normally.
        console.warn(
          `[AuthEnter] agent bind skipped for agentId=${consumed.issuedToAgentId} (no row, or owned by a different user)`,
        );
      }
    } catch (err) {
      console.error('[AuthEnter] agent bind failed (non-fatal):', err);
    }
  }

  void logEventFromContext(c, {
    eventType: 'auth.magic_link.enter',
    userId: consumed.userId,
    sessionId: createdSessionId,
    payload: {
      route: 'GET /api/auth/enter',
      outcome: 'success',
    },
  });

  // Founder scenario 1 (first-time): a ticket with NO avatar bound means the
  // account has no avatar yet — route the fresh human to avatar creation
  // instead of an empty /game. Scenario 2 (returning, avatar bound) keeps the
  // /game landing; the game page's /me/agent-session hydration then drops them
  // into Controlled ('player') mode on their agent's avatar.
  if (consumed.avatarId == null) {
    return c.redirect(`${webOrigin}/create-agent?from=agent-link`, 302);
  }
  return c.redirect(`${webOrigin}/game`, 302);
});

authRoutes.post('/milady-session-exchange', async (c) => {
  // Rate limit: 5 attempts per minute per IP.
  // FIX-18: route through getClientIp (cf-connecting-ip → last-XFF-entry) instead
  // of a hand-rolled resolver that trusted the spoofable FIRST XFF entry / x-real-ip
  // and let a caller rotate the rate-limit key to defeat this 5/min cap off-CF.
  const ip = getClientIp(c.req.raw.headers);

  if (!checkMiladyRateLimit(ip)) {
    throw new HTTPException(429, {
      message: 'Too many session exchange attempts. Try again in a minute.',
    });
  }

  const body = await c.req.json();
  const parsed = miladyExchangeSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'sessionId is required' });
  }

  const { sessionId } = parsed.data;

  // Fail-closed liveness gate (Codex auth-lens hardening round 3, 2026-06-03).
  // This endpoint mints a full Lucia COOKIE from an agent-session bearer, so it
  // is auth-critical: previously it trusted bare Map membership
  // (`isValidAgentSession`), which let an EXPIRED-but-still-in-memory session
  // exchange into a real authed browser session. Route through the SAME shared
  // validator every other bearer path uses (DB `session_expires_at > now`, NULL
  // = expired, unregister stale body) so the TTL is enforced before any cookie.
  // The validator returns the in-memory config + live row in one shot, so the
  // redundant config/row lookups this used to do are gone.
  const live = await validateLiveAgentSession(sessionId);
  if (!live) {
    throw new HTTPException(404, { message: 'Agent session not found or expired' });
  }
  const { config: botConfig, bot } = live;

  // Find or create a guest user for this Milady agent
  const guestEmail = `milady-${botConfig.agentId}@clawville.guest`;
  let user = await db.query.users.findFirst({
    where: eq(users.email, guestEmail),
  });

  if (!user) {
    // Create a guest user — random password hash, never used for login
    const guestId = crypto.randomUUID();
    const randomHash = await Bun.password.hash(crypto.randomUUID(), {
      algorithm: 'bcrypt',
      cost: 4, // fast — this hash is never verified
    });

    await db.insert(users).values({
      id: guestId,
      email: guestEmail,
      passwordHash: randomHash,
      name: bot.name ?? botConfig.agentId,
    });

    user = await db.query.users.findFirst({
      where: eq(users.id, guestId),
    });
  }

  if (!user) {
    throw new HTTPException(500, { message: 'Failed to create guest user' });
  }

  // Create a Lucia session for this guest user
  const session = await lucia.createSession(user.id, {});
  const cookie = lucia.createSessionCookie(session.id);
  c.header('Set-Cookie', cookie.serialize());

  void logEventFromContext(c, {
    eventType: 'auth.milady_session.exchanged',
    userId: user.id,
    sessionId: session.id,
    payload: {
      route: 'POST /api/auth/milady-session-exchange',
      agentId: botConfig.agentId,
      outcome: 'success',
    },
  });

  return c.json({
    success: true,
    userId: user.id,
    agentId: botConfig.agentId,
    botName: bot.name,
    botUuid: bot.id,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/guest — guest avatar auto-create (2026-04-23).
//
// Lets an un-authenticated visitor play the Q2 activity games + chat with
// NPCs as a throwaway "Guest Avatar" — no email, no signup. Use case:
// "test-drive the game before deciding to make an account."
//
// Behaviour:
//   - Idempotent: if the caller already has a Lucia cookie, return their
//     existing user + avatar (handler does NOT create a second guest).
//   - Else: create a (users, avatars) pair with is_guest=true,
//     guest_expires_at = now() + 24h. Issues a Lucia session cookie.
//
// Brand carve-outs (mirroring the Q2 chunk #10 bot pattern — see
// services/activity/reward-pipeline.ts and routes/leaderboard.ts):
//   - Guest avatars do NOT appear on the agent leaderboard
//   - Guest avatars do NOT appear on per-activity leaderboards
//   - Guest match results still credit ClawTokens (in-game dopamine
//     works) but with leaderboardPoints = 0
//   - Guest events are excluded from the /dash teacher-chat metric
//
// Rate-limited to 5 mints/IP/min — same budget as the auto-provision
// branch in avatars.ts. Each mint creates a (users, avatars) pair so the cap
// matters even though guests cost less than a full identity+wallet mint.
// ---------------------------------------------------------------------------

const guestRateLimiter = createRateLimiter({
  maxPerWindow: 5,
  windowMs: 60_000,
});

const guestBodySchema = z.object({
  /** Optional — caller-suggested display name. Ignored if name collides. */
  requestedName: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9 ]+$/)
    .optional(),
});

const GUEST_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const GUEST_SPECIES = ['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle'] as const;
const GUEST_COLORS = ['green', 'red', 'blue', 'yellow'] as const;
const GUEST_GENDERS = ['male', 'female'] as const;
const GUEST_ARCHETYPE = 'brave-adventurer';

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Try INSERTing the avatar up to N times — on a 23505 unique-violation
 * (name collision) we re-roll the random suffix and retry. The 5-digit
 * suffix space is 100k entries; a collision needs >316 concurrent guests
 * with the same first roll, so a small retry budget is sufficient.
 */
async function insertGuestAvatar(
  ownerId: string,
  requestedName: string | undefined,
): Promise<{ id: string; name: string }> {
  const species = pickRandom(GUEST_SPECIES);
  const color = pickRandom(GUEST_COLORS);
  const gender = pickRandom(GUEST_GENDERS);

  // Sanitise + cap the requestedName at 14 chars so the suffix fits in
  // the 20-char `avatars.name` column.
  const baseRaw = requestedName?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);
  const base = baseRaw && baseRaw.length >= 3 ? baseRaw : 'Guest';

  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000).toString();
    const candidate = `${base}${suffix}`;
    try {
      const [row] = await db
        .insert(avatars)
        .values({
          userId: ownerId,
          name: candidate,
          species,
          color,
          gender,
          archetype: GUEST_ARCHETYPE,
          personality: {
            habitat: 'Town Center',
            hobby: 'Visiting ClawVille',
            greeting: 'Hi! Just visiting.',
          },
          stats: { strength: 5, defence: 5, movement: 5 },
          // No characterConfig — guests don't run Eliza chat as their avatar.
          // characterConfig is hydrated later if/when they convert to a
          // real account. Leaving it null is safe — the avatar routes
          // tolerate a null characterConfig (chat is gated to non-guests
          // by other checks in the chat surfaces, not enforced here).
          clawTokens: 100,
          // F1 vCLAW provenance: mirror clawTokens into softBalance so the
          // avatars_vclaw_balance_sum CHECK holds (100 = 100+0+0). Legacy/guest CT
          // is SOFT (non-cashable). Explicit set is required because clawTokens is
          // explicit here — the column default only covers omitting both.
          softBalance: 100,
          isActive: true,
          modelKey: DEFAULT_AGENT_MODEL_KEY,
          agentCategory: 'openclaw',
          harness: 'milady',
          isGuest: true,
        })
        .returning({ id: avatars.id, name: avatars.name });
      return row;
    } catch (err) {
      const code =
        (err as { code?: string; cause?: { code?: string } } | null)?.code ??
        (err as { cause?: { code?: string } } | null)?.cause?.code;
      if (code === '23505') continue;
      throw err;
    }
  }
  throw new HTTPException(503, {
    message: 'Could not generate a unique guest name — please retry',
  });
}

authRoutes.post('/guest', async (c) => {
  // Rate limit FIRST — public endpoint, no auth required.
  const ip = getClientIp(c.req.raw.headers);
  if (!guestRateLimiter.check(ip)) {
    throw new HTTPException(429, {
      message: 'Too many guest signups from this IP. Try again in 1 minute.',
    });
  }

  // Idempotent: if the caller already has a Lucia session, return their
  // current user + avatar rather than minting a second guest.
  const existingUser = c.get('user');
  if (existingUser) {
    const existingAvatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, existingUser.id), eq(avatars.isActive, true)),
    });
    return c.json({
      user: {
        id: existingUser.id,
        email: existingUser.email,
        name: existingUser.name,
        // Read isGuest off the raw row so we don't trust the user attribute mapping.
        isGuest: !!(await db.query.users.findFirst({
          where: eq(users.id, existingUser.id),
          columns: { isGuest: true },
        }))?.isGuest,
      },
      avatar: existingAvatar ?? null,
      reused: true,
    });
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = guestBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid request body' });
  }

  // Mint the guest user. Email + password_hash are populated with
  // unique placeholders so the `users_has_auth_method` CHECK passes
  // (same pattern as scripts/seed-bot-avatars.ts). The placeholder
  // password_hash is shaped like "$bot$disabled$..." so an admin can
  // tell at a glance the row was never meant to log in via email/pwd.
  const userId = crypto.randomUUID();
  const guestEmail = `guest+${userId}@guest.clawville`;
  const placeholderPasswordHash = `$guest$disabled$${userId}`;
  const expiresAt = new Date(Date.now() + GUEST_TTL_MS);

  await db.insert(users).values({
    id: userId,
    email: guestEmail,
    passwordHash: placeholderPasswordHash,
    name: 'Guest',
    isGuest: true,
    guestExpiresAt: expiresAt,
  });

  const avatar = await insertGuestAvatar(userId, parsed.data.requestedName);

  // Lucia session cookie — same attributes as signup/login (sameSite +
  // secure flags driven by NODE_ENV via lib/auth.ts).
  const session = await lucia.createSession(userId, {});
  const cookie = lucia.createSessionCookie(session.id);
  c.header('Set-Cookie', cookie.serialize());

  void logEventFromContext(c, {
    eventType: 'auth.guest.created',
    userId,
    avatarId: avatar.id,
    sessionId: session.id,
    payload: {
      route: 'POST /api/auth/guest',
      guestExpiresAt: expiresAt.toISOString(),
      outcome: 'success',
    },
  });

  return c.json({
    user: {
      id: userId,
      email: guestEmail,
      name: 'Guest',
      isGuest: true,
      guestExpiresAt: expiresAt.toISOString(),
    },
    avatar: { id: avatar.id, name: avatar.name },
    reused: false,
  });
});
