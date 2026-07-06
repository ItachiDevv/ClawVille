---
name: feedback_no_dark_text_on_dark_panel
description: "Inside a dark-bg surface (.claw-panel, any modal/toast/overlay with rgba navy/black background, dark-mode email body, etc.) NEVER use Tailwind text-gray-700/800/900, text-slate-700/800/900, text-zinc-700/800/900 — they're <2:1 contrast = invisible. Always pick a light token (text-cyan-50, text-white, text-slate-100/200, text-cyan-200/300 for muted) so the ratio clears WCAG AAA 7:1."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 25cc6bf6-a173-4bff-a7f8-ee1fc633b21d
---

When the parent surface is dark (the canonical case is `.claw-panel` in globals.css with `linear-gradient(180deg, rgba(10, 22, 40, 0.92) 0%, rgba(6, 13, 23, 0.96) 100%)`), the text token MUST be light. Concretely:

- **Heading / primary text** → `text-cyan-50` (#ecfeff, picks up the panel border accent) or `text-white`
- **Body / secondary text** → `text-slate-100` or `text-slate-200`
- **Muted / metadata** → `text-slate-300` (still ≥7:1 on dark navy)
- **De-emphasized timestamps / disabled hint** → `text-slate-400` minimum, never lower

Banned-on-dark tokens (these all produce <2:1 contrast on .claw-panel, unreadable):
- `text-gray-700|800|900`
- `text-slate-700|800|900`
- `text-zinc-700|800|900`
- `text-neutral-700|800|900`
- `text-stone-700|800|900`

**Exception:** if a child element has its OWN light background pill/badge (e.g. `bg-white/60`, `bg-gray-100`, `bg-yellow-100`), then dark text is fine inside that pill because it's no longer on the dark panel.

**Why:** Set 2026-05-22 after the user called out a "skill claimed!" toast rendering near-black `text-gray-900` on the navy `.claw-panel` background — completely unreadable. They flagged this as a recurring pattern of "dark text on dark background, terrible UI practices, no color theory" across multiple modals. Same bug found and fixed in `toast-notifications.tsx` + `marketplace-modal.tsx` same diff.

**How to apply:** Before writing or editing ANY component that lives inside `.claw-panel` OR any other dark-surface modal/toast/HUD, check the parent's background color. If dark, every text utility class must come from the light end of the scale. If the parent has gradients, assume worst-case contrast is against the darkest stop. When in doubt, run the WCAG checker on the foreground/background pair — minimum 4.5:1 for normal text, 7:1 for AAA. Companion to [[feedback_emails_light_mode_only]] (the email-rendering equivalent of the same principle inverted).
