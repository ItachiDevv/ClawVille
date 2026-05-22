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
 * Branded shell — dark navy bg, cyan accents, monospace caption block.
 * Two zones: the framed CTA card and a footer line.
 */
function wrapShell({
  heading,
  intro,
  ctaLabel,
  ctaUrl,
  fallbackLabel,
  expiryNote,
}: {
  heading: string;
  intro: string;
  ctaLabel: string;
  ctaUrl: string;
  fallbackLabel: string;
  expiryNote: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ClawVille</title>
  </head>
  <body style="margin:0; padding:0; background:#04101a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#e5f6ff;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#04101a; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;">
            <tr>
              <td style="text-align:center; padding-bottom:24px;">
                <div style="font-family: 'Segoe UI', Roboto, sans-serif; font-size:28px; font-weight:700; letter-spacing:0.04em; color:#00e5ff; text-shadow:0 0 14px rgba(0,229,255,0.35);">ClawVille</div>
              </td>
            </tr>
            <tr>
              <td style="background:#0a1628; border:1px solid rgba(0,229,255,0.22); border-radius:16px; padding:32px;">
                <h1 style="margin:0 0 16px 0; font-size:22px; line-height:1.3; color:#ffffff; font-weight:600;">${heading}</h1>
                <p style="margin:0 0 20px 0; font-size:15px; line-height:1.55; color:rgba(229,246,255,0.78);">${intro}</p>
                <div style="text-align:center; margin:28px 0;">
                  <a href="${ctaUrl}" style="display:inline-block; padding:14px 28px; border-radius:10px; background:linear-gradient(90deg,#0891b2,#00e5ff); color:#04101a; text-decoration:none; font-weight:700; font-size:15px; letter-spacing:0.03em; box-shadow:0 0 24px rgba(0,229,255,0.28);">${ctaLabel}</a>
                </div>
                <p style="margin:0 0 8px 0; font-size:12px; line-height:1.5; color:rgba(229,246,255,0.45);">${fallbackLabel}</p>
                <p style="margin:0 0 0 0; word-break:break-all; font-family:'SFMono-Regular', Consolas, Menlo, monospace; font-size:12px; color:rgba(0,229,255,0.7);">${ctaUrl}</p>
                <hr style="border:none; border-top:1px solid rgba(0,229,255,0.12); margin:24px 0;" />
                <p style="margin:0; font-size:12px; line-height:1.5; color:rgba(229,246,255,0.45);">${expiryNote}</p>
              </td>
            </tr>
            <tr>
              <td style="text-align:center; padding-top:20px; font-size:11px; color:rgba(229,246,255,0.35); font-family:'SFMono-Regular', Consolas, Menlo, monospace; letter-spacing:0.08em; text-transform:uppercase;">
                Sent by ClawVille &middot; clawville.world
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
  const subject = 'Welcome to ClawVille — confirm your email';
  const html = wrapShell({
    heading: `Welcome, ${name} —`,
    intro: `Tap the button below to confirm this email is yours. Confirming helps us recover your account if you ever lose access.`,
    ctaLabel: 'Confirm my email',
    ctaUrl: url,
    fallbackLabel: 'Button broken? Paste this URL into your browser:',
    expiryNote: 'This link expires in 24 hours. If you didn’t sign up for ClawVille, you can safely ignore this message.',
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
  const subject = 'Reset your ClawVille password';
  const html = wrapShell({
    heading: `Password reset for ${name}`,
    intro: `Someone (hopefully you) asked to reset your ClawVille password. Tap the button below within the next hour to choose a new one.`,
    ctaLabel: 'Reset my password',
    ctaUrl: url,
    fallbackLabel: 'Button broken? Paste this URL into your browser:',
    expiryNote: 'This link expires in 60 minutes and can be used once. If you didn’t request a reset, you can safely ignore this email — your password stays unchanged.',
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
