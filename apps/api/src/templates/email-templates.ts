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
 * Branded shell — full ClawVille treatment: deep-sea navy gradient
 * background, 🦞 lobster mascot, oversized cyan wordmark with glow,
 * tagline, framed CTA card with cyan-to-pink dual-tone hero gradient,
 * Mono caption block + monospace URL fallback, footer with
 * underwater-themed micro-copy.
 *
 * Email client gotchas (do not break without testing):
 *   - Table-based layout only — Outlook drops flexbox/grid silently.
 *   - All styles inline — Gmail strips <style> blocks in some flows.
 *   - System font stack — web fonts fail in most inboxes.
 *   - Gradients fall back to the first stop color in clients that don't
 *     support `linear-gradient` (Outlook) — `bgcolor` attrs provide a
 *     readable solid fallback.
 *   - `text-shadow` is ignored by many clients — purely decorative on
 *     supported clients (Apple Mail, modern Gmail webview), no fallback
 *     loss.
 *   - Emoji renders consistently across iOS / Gmail / Outlook 365 —
 *     safer than image hosting + tracking-blocker friction.
 *   - Dark-mode auto-inversion (Outlook) is bypassed by explicit inline
 *     colors on every text node.
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
  /** 'cyan' = welcome/verify (positive), 'pink' = reset (alert). Picks the CTA gradient. */
  ctaTone: 'cyan' | 'pink';
}): string {
  const ctaGradient =
    ctaTone === 'pink'
      ? 'linear-gradient(90deg, #db2777 0%, #ec4899 50%, #f472b6 100%)'
      : 'linear-gradient(90deg, #0891b2 0%, #06b6d4 50%, #00e5ff 100%)';
  const ctaSolidFallback = ctaTone === 'pink' ? '#ec4899' : '#06b6d4';
  const ctaGlow = ctaTone === 'pink' ? 'rgba(236,72,153,0.35)' : 'rgba(0,229,255,0.30)';
  const accentRgba = ctaTone === 'pink' ? 'rgba(236,72,153,0.7)' : 'rgba(0,229,255,0.7)';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>ClawVille</title>
  </head>
  <body style="margin:0; padding:0; background:#04101a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#e5f6ff;">
    <!-- Preheader (hidden, but shows as inbox preview text) -->
    <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:transparent;">${intro.replace(/<[^>]+>/g, '').slice(0, 110)}</div>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#04101a" style="background:#04101a; background:radial-gradient(ellipse at top, #082035 0%, #04101a 70%); padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">

            <!-- Mascot + wordmark hero -->
            <tr>
              <td style="text-align:center; padding-bottom:8px;">
                <div style="font-size:56px; line-height:1; margin-bottom:8px;">🦞</div>
                <div style="font-family: 'Segoe UI', Roboto, sans-serif; font-size:36px; font-weight:800; letter-spacing:0.06em; color:#00e5ff; text-shadow:0 0 18px rgba(0,229,255,0.5); text-transform:uppercase;">ClawVille</div>
                <div style="font-family:'SFMono-Regular', Consolas, Menlo, monospace; font-size:10px; letter-spacing:0.28em; color:rgba(0,229,255,0.55); text-transform:uppercase; margin-top:8px;">A deep-sea world of autonomous agents</div>
              </td>
            </tr>

            <!-- Spacer -->
            <tr><td style="height:24px; line-height:24px; font-size:0;">&nbsp;</td></tr>

            <!-- CTA card -->
            <tr>
              <td bgcolor="#0a1628" style="background:#0a1628; background:linear-gradient(180deg,#0a1c30 0%,#06141f 100%); border:1px solid rgba(0,229,255,0.25); border-radius:18px; padding:36px 32px; box-shadow:0 0 40px rgba(0,229,255,0.06);">
                <h1 style="margin:0 0 14px 0; font-size:23px; line-height:1.3; color:#ffffff; font-weight:700; letter-spacing:0.01em;">${heading}</h1>
                <p style="margin:0 0 24px 0; font-size:15px; line-height:1.6; color:rgba(229,246,255,0.82);">${intro}</p>

                <!-- Hero CTA — bulletproof button (table-wrapped for Outlook) -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 28px auto;">
                  <tr>
                    <td align="center" bgcolor="${ctaSolidFallback}" style="background:${ctaSolidFallback}; background:${ctaGradient}; border-radius:12px; box-shadow:0 0 28px ${ctaGlow};">
                      <a href="${ctaUrl}" style="display:inline-block; padding:16px 34px; color:#04101a; text-decoration:none; font-weight:700; font-size:15px; letter-spacing:0.04em; text-transform:uppercase; font-family:'Segoe UI', Roboto, sans-serif;">${ctaLabel}</a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 6px 0; font-size:11px; line-height:1.5; color:rgba(229,246,255,0.45); font-family:'SFMono-Regular', Consolas, Menlo, monospace; letter-spacing:0.04em; text-transform:uppercase;">${fallbackLabel}</p>
                <p style="margin:0; word-break:break-all; font-family:'SFMono-Regular', Consolas, Menlo, monospace; font-size:12px; line-height:1.5; color:${accentRgba};">${ctaUrl}</p>

                <hr style="border:none; border-top:1px solid rgba(0,229,255,0.15); margin:28px 0 20px 0;" />

                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td valign="top" style="padding-right:10px; font-size:14px; line-height:1; color:${accentRgba}; width:18px;">⚓</td>
                    <td style="font-size:12px; line-height:1.55; color:rgba(229,246,255,0.55);">${expiryNote}</td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="text-align:center; padding-top:28px;">
                <div style="font-family:'SFMono-Regular', Consolas, Menlo, monospace; font-size:10px; letter-spacing:0.24em; color:rgba(229,246,255,0.35); text-transform:uppercase;">
                  🐚 &nbsp;sent from the sea floor &nbsp; 🐚
                </div>
                <div style="font-family:'SFMono-Regular', Consolas, Menlo, monospace; font-size:11px; letter-spacing:0.14em; color:rgba(0,229,255,0.55); margin-top:10px;">
                  <a href="https://clawville.world" style="color:rgba(0,229,255,0.7); text-decoration:none;">clawville.world</a>
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
