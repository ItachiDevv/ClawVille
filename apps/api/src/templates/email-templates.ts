/**
 * Inline-styled transactional email templates for ClawVille.
 *
 * Plain HTML — NO React Email runtime. Two templates today (verify +
 * reset); if a third arrives, factor `wrapShell()` into a separate
 * module and keep the two templates as thin payload customisers.
 *
 * Security:
 *   - `userName` is HTML-escaped before insertion (prevents stored-XSS
 *     via a malicious display name landing in the email body).
 *   - URLs come from the caller (`{verifyUrl}` / `{resetUrl}`) and the
 *     route builders source them from `WEB_ORIGIN`, never request
 *     headers. Host-header injection is therefore not exploitable here,
 *     but we still URL-escape the token segment at the route layer.
 *
 * Plaintext fallback is mandatory — some inbox clients (lynx, screen
 * readers, Markdown-rendering inboxes) render text/plain only. The
 * Resend SDK accepts both `html` and `text` in a single send.
 */

export interface EmailPayload {
  subject: string;
  html: string;
  text: string;
}

/**
 * HTML-escape — minimal, only the five characters that can break out
 * of an inline-styled <div>. Email HTML doesn't run JS so we don't
 * need the broader OWASP set; the goal is to prevent the markup from
 * being malformed when a display name contains `<`, `>`, `&`, `"`, or `'`.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeName(raw: string | null | undefined): string {
  if (!raw) return 'agent';
  const trimmed = raw.trim().slice(0, 60);
  if (!trimmed) return 'agent';
  return escapeHtml(trimmed);
}

/**
 * Branded shell — LIGHT-mode transactional email (rewritten 2026-05-22
 * after dark-bg + low-opacity text got eaten by Apple Mail's dark-mode
 * dimming heuristic).
 *
 * Design: warm off-white canvas, white card with cyan accent stripe at
 * the top, dark-navy heading, slate body text, 🦞 mascot + cyan brand
 * wordmark, dual-tone CTA gradient (cyan for welcome/verify, pink for
 * reset/alert) — Stripe / Linear / Vercel pattern. Brand identity
 * lives in the accent colors and the mascot, not the background.
 *
 * Why not dark mode: Apple Mail / Gmail iOS apply a CSS overlay that
 * dims "near-white" text under user-dark-mode regardless of the email's
 * own color-scheme meta. Dark-on-dark = unreadable in their hands. Light
 * mode renders identically across every client + dark-mode UA.
 *
 * Email client gotchas (do not regress):
 *   - Table-based layout — Outlook drops flexbox/grid silently.
 *   - Inline styles only — Gmail strips <style>.
 *   - System font stack — web fonts fail in most inboxes.
 *   - Solid hex colors only on text — NO rgba(...) opacity. Apple Mail
 *     dims rgba text aggressively in dark mode. Use named slate hex
 *     values (#0f172a, #334155, #64748b) for contrast tiers instead.
 *   - Gradients fall back to first stop in clients without support;
 *     `bgcolor` attrs provide a readable solid fallback.
 *   - Bulletproof button = <a> wrapped in a <table> with bgcolor — works
 *     in Outlook 2007+ and every modern client.
 *   - Emojis (🦞 ⚓ 🐚) render natively cross-client.
 */
function wrapShell({
  heading,
  intro,
  ctaLabel,
  ctaUrl,
  fallbackLabel,
  expiryNote,
  ctaTone,
}: {
  heading: string;
  intro: string;
  ctaLabel: string;
  ctaUrl: string;
  fallbackLabel: string;
  expiryNote: string;
  /** 'cyan' = welcome/verify (positive), 'pink' = reset (alert). Picks the CTA gradient + accent strip. */
  ctaTone: 'cyan' | 'pink';
}): string {
  const ctaGradient =
    ctaTone === 'pink'
      ? 'linear-gradient(90deg, #db2777 0%, #ec4899 50%, #f472b6 100%)'
      : 'linear-gradient(90deg, #0891b2 0%, #06b6d4 50%, #22d3ee 100%)';
  const ctaSolidFallback = ctaTone === 'pink' ? '#ec4899' : '#06b6d4';
  const accentColor = ctaTone === 'pink' ? '#ec4899' : '#06b6d4';
  const accentDark = ctaTone === 'pink' ? '#be185d' : '#0e7490';
  const accentStripGradient =
    ctaTone === 'pink'
      ? 'linear-gradient(90deg, #db2777 0%, #ec4899 50%, #06b6d4 100%)'
      : 'linear-gradient(90deg, #06b6d4 0%, #22d3ee 50%, #06b6d4 100%)';

  // Color tiers — solid hex, no rgba (Apple Mail dark-mode dimming compatible)
  const PAGE_BG = '#f1f5f9';        // slate-100 — warm off-white canvas
  const CARD_BG = '#ffffff';        // pure white card
  const TEXT_STRONG = '#0f172a';    // slate-900 — heading
  const TEXT_BODY = '#334155';      // slate-700 — body
  const TEXT_MUTED = '#64748b';     // slate-500 — labels, footer
  const TEXT_FAINT = '#94a3b8';     // slate-400 — micro caption
  const BORDER = '#e2e8f0';         // slate-200 — hairlines

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>ClawVille</title>
  </head>
  <body style="margin:0; padding:0; background:${PAGE_BG}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:${TEXT_BODY};">
    <!-- Preheader (hidden, but shows as inbox preview text) -->
    <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:transparent;">${intro.replace(/<[^>]+>/g, '').slice(0, 110)}</div>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${PAGE_BG}" style="background:${PAGE_BG}; padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">

            <!-- Mascot + wordmark hero -->
            <tr>
              <td style="text-align:center; padding-bottom:24px;">
                <div style="font-size:56px; line-height:1; margin-bottom:10px;">🦞</div>
                <div style="font-family: 'Segoe UI', Roboto, sans-serif; font-size:34px; font-weight:800; letter-spacing:0.06em; color:${accentDark}; text-transform:uppercase;">ClawVille</div>
                <div style="font-family:'SFMono-Regular', Consolas, Menlo, monospace; font-size:10px; letter-spacing:0.26em; color:${TEXT_MUTED}; text-transform:uppercase; margin-top:8px;">A deep-sea world of autonomous agents</div>
              </td>
            </tr>

            <!-- CTA card -->
            <tr>
              <td bgcolor="${CARD_BG}" style="background:${CARD_BG}; border:1px solid ${BORDER}; border-radius:16px; padding:0; overflow:hidden; box-shadow:0 1px 3px rgba(15,23,42,0.06), 0 4px 12px rgba(15,23,42,0.04);">
                <!-- Top accent stripe — brand color band -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td height="4" bgcolor="${accentColor}" style="height:4px; line-height:4px; font-size:0; background:${accentColor}; background:${accentStripGradient};">&nbsp;</td>
                  </tr>
                </table>

                <!-- Card content -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td style="padding:36px 32px;">
                      <h1 style="margin:0 0 14px 0; font-size:22px; line-height:1.35; color:${TEXT_STRONG}; font-weight:700; letter-spacing:-0.01em;">${heading}</h1>
                      <p style="margin:0 0 28px 0; font-size:15px; line-height:1.6; color:${TEXT_BODY};">${intro}</p>

                      <!-- Hero CTA — bulletproof button (table-wrapped for Outlook) -->
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 28px auto;">
                        <tr>
                          <td align="center" bgcolor="${ctaSolidFallback}" style="background:${ctaSolidFallback}; background:${ctaGradient}; border-radius:10px;">
                            <a href="${ctaUrl}" style="display:inline-block; padding:14px 32px; color:#ffffff; text-decoration:none; font-weight:700; font-size:15px; letter-spacing:0.04em; text-transform:uppercase; font-family:'Segoe UI', Roboto, sans-serif;">${ctaLabel}</a>
                          </td>
                        </tr>
                      </table>

                      <p style="margin:0 0 6px 0; font-size:11px; line-height:1.5; color:${TEXT_MUTED}; font-family:'SFMono-Regular', Consolas, Menlo, monospace; letter-spacing:0.04em; text-transform:uppercase;">${fallbackLabel}</p>
                      <p style="margin:0; word-break:break-all; font-family:'SFMono-Regular', Consolas, Menlo, monospace; font-size:12px; line-height:1.5;"><a href="${ctaUrl}" style="color:${accentDark}; text-decoration:underline;">${ctaUrl}</a></p>

                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px;">
                        <tr>
                          <td height="1" bgcolor="${BORDER}" style="height:1px; line-height:1px; font-size:0; background:${BORDER};">&nbsp;</td>
                        </tr>
                      </table>

                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:20px;">
                        <tr>
                          <td valign="top" style="padding-right:10px; font-size:14px; line-height:1; color:${accentColor}; width:18px;">⚓</td>
                          <td style="font-size:12px; line-height:1.55; color:${TEXT_MUTED};">${expiryNote}</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="text-align:center; padding-top:28px;">
                <div style="font-family:'SFMono-Regular', Consolas, Menlo, monospace; font-size:10px; letter-spacing:0.24em; color:${TEXT_FAINT}; text-transform:uppercase;">
                  🐚 &nbsp;sent from the sea floor &nbsp; 🐚
                </div>
                <div style="font-family:'SFMono-Regular', Consolas, Menlo, monospace; font-size:11px; letter-spacing:0.14em; margin-top:10px;">
                  <a href="https://clawville.world" style="color:${accentDark}; text-decoration:none;">clawville.world</a>
                </div>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function verifyEmailTemplate(params: {
  userName: string | null | undefined;
  verifyUrl: string;
}): EmailPayload {
  const name = safeName(params.userName);
  const url = params.verifyUrl;
  const subject = 'Welcome to ClawVille 🦞 — confirm your email';
  const html = wrapShell({
    heading: `Welcome aboard, ${name}.`,
    intro: `Your agent has dropped into the deep. Tap the button below to confirm this email is yours — confirming helps us recover your account if you ever lose access, and unlocks the full ClawVille world.`,
    ctaLabel: 'Confirm my email',
    ctaUrl: url,
    fallbackLabel: 'Button not working? Copy this link:',
    expiryNote: 'This link expires in 24 hours. If you didn’t sign up for ClawVille, you can safely ignore this message — no further emails will land.',
    ctaTone: 'cyan',
  });
  // Plaintext fallback — used by terminal mail clients + screen readers.
  // Keep it short; the link itself is the only load-bearing element.
  const text = [
    `Welcome to ClawVille, ${params.userName?.trim() || 'agent'}.`,
    '',
    'Confirm your email by opening this link:',
    url,
    '',
    'This link expires in 24 hours. If you did not sign up, ignore this message.',
    '',
    '— ClawVille (clawville.world)',
  ].join('\n');
  return { subject, html, text };
}

export function resetPasswordTemplate(params: {
  userName: string | null | undefined;
  resetUrl: string;
}): EmailPayload {
  const name = safeName(params.userName);
  const url = params.resetUrl;
  const subject = 'Reset your ClawVille password 🔑';
  const html = wrapShell({
    heading: `Resetting your password, ${name}.`,
    intro: `Someone (hopefully you) asked to reset your ClawVille password. Tap the button below within the next hour to choose a new one. The old password stays valid until the moment you finish the reset.`,
    ctaLabel: 'Reset my password',
    ctaUrl: url,
    fallbackLabel: 'Button not working? Copy this link:',
    expiryNote: 'This link expires in 60 minutes and can only be used once. If you didn’t request a reset, you can safely ignore this email — your password stays unchanged and no one else can act on this link.',
    ctaTone: 'pink',
  });
  const text = [
    `ClawVille password reset for ${params.userName?.trim() || 'agent'}.`,
    '',
    'Open this link within the next hour to choose a new password:',
    url,
    '',
    'This link expires in 60 minutes and can be used once.',
    'If you did not request a reset, ignore this message — your password stays unchanged.',
    '',
    '— ClawVille (clawville.world)',
  ].join('\n');
  return { subject, html, text };
}
