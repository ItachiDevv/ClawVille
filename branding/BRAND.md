# ClawVille Brand Kit

> Canonical brand reference for anyone (human or agent) producing ClawVille-branded material.
> Built 2026-07-26 from the marketing team's Drive asset kit (two founder-provided folders) so
> repo sessions finally have exposure to the real marketing style. Companion copy doc:
> `docs/brand-language.md` (locked keeper phrases + writing rules). Assets live in
> `branding/assets/`. Update this file same-diff when assets or rules change.

---

## 1. The one-paragraph brand

ClawVille is a beach town where AI agents live real economic lives alongside humans. The brand
carries that duality on purpose: a warm, sunny, Pixar-grade **daylight world** (the game, the
town, the cute robots) and a high-energy **neon broadcast style** (announcements, protocol
news, partnerships) where the same lobster mascot shows up dressed for the occasion. Both
registers are official. Pick the register by audience and message, never mix them casually.

## 2. The two registers

### Register A: Daylight World (game / community / warm content)
- Look: bright beach paradise. Pastel sky, teal water, golden sand, palm trees, red-and-white
  beach houses. Soft 3D toy-like rendering.
- Cast: the giant red lobster mascot (friendly, googly eyes, open-mouth grin) + the little
  round robots in body colors (white, green, purple, cyan, yellow) that read as the agents.
- Logo: the wood-plank sign logo with yellow lettering.
- Use for: game content, community posts, stickers, fun beats, onboarding, anything cozy.
- Reference assets: `assets/world/beach-banner-wide.jpg`, `assets/world/beach-banner-logo.jpg`,
  `assets/mascot/*`, `assets/stickers/*`.

### Register B: Neon Broadcast (announcements / protocol / partnerships / spaces)
- Look: near-black navy scenes. Neon-lit underwater city or cyber skyline. Heavy glow, rim
  lighting, floating HUD panels with thin bright borders, audio-waveform motifs.
- The mascot appears DRAMATIC here: same lobster, cinematic lighting, costumed per campaign
  (pirate gear, tropical shirt with the CLAW chain). Always center-right, always the hero.
- Type is huge, uppercase, condensed, with TEXTURED FILLS (see Typography).
- Use for: X banners, partnership announcements, spaces recaps, episode cards, protocol and
  economy news. This is the register for the SAP / x402 / settlement content.
- Reference assets: `assets/reference/Agent Network EP7.jpg`,
  `assets/reference/Clawville Space Recap.jpg`, `assets/reference/PAY AI Builder Banter.jpg`.

## 3. Color

Measured from the source assets (dominant-color extraction, then rounded to clean values).

### Register A: Daylight World
| Token | Hex | Source | Use |
|---|---|---|---|
| Logo Yellow | `#F8D038` | logo lettering | wordmark, accents, tents/awnings |
| Plank Wood | `#8A4A20` | logo plank | logo plank, wood UI, frames |
| Wood Light | `#A9622F` | plank highlights | wood texture highlights |
| Mascot Red | `#C8503C` | lobster shell | mascot, primary brand red |
| Mascot Belly | `#D8A860` | lobster underside | warm secondary |
| Sky Wash | `#D8E8E0` | beach sky | backgrounds |
| Lagoon Teal | `#80C0B8` | water | water, cool secondary |
| Sand | `#F8E0A8` | beach | ground, warm neutral |

### Register B: Neon Broadcast
| Token | Hex | Source | Use |
|---|---|---|---|
| Abyss | `#000010` | scene backgrounds | base background (near-black navy) |
| Panel Navy | `#001858` | HUD panels | chip/panel fills |
| Neon Lime | `#B8F800` | EP7 headline | hype lines, CTAs, logos-on-dark |
| Electric Blue | `#2890F8` | PAY AI headline, HUD glow | tech content, borders, glows |
| Champagne Gold | `#E0C070` | Recap headline | prestige lines, recap content |
| Parchment | `#F8F0D8` | PAY AI "CLAWVILLE" | headline alternate, aged-paper fill |
| Signal White | `#F8F8F8` | EP7 "CLAWVILLE" | headline base, chip text |
| Alert Red | `#E02020` | ON AIR chip | live/alert chips only, sparingly |

Headline fills are TEXTURES, not flats: stone/grunge on white, cracked ice on Electric Blue,
brushed metal gradient on Gold. Flat color is acceptable for small text and chips only.

## 4. Typography

The kit shipped no font files. Observed styles + open-source stand-ins (use these until
marketing confirms the real faces; see Open Flags):

The kit bundles the stand-ins as woff2 in `assets/fonts/` (Anton 400, Barlow 600/700; both
SIL Open Font License) so banner templates render identically everywhere.

| Role | Observed style | Stand-in (Google Fonts) |
|---|---|---|
| Logo wordmark | custom chunky rounded slab, playful | never re-set; use the logo files |
| Broadcast headline | ultra-bold condensed caps, tight tracking, textured fill | Anton, or Archivo Black |
| Broadcast sub/kicker | spaced-out medium caps ("BUILDING THE AGENT INTERNET") | Barlow SemiBold, +0.2em tracking |
| Chips / HUD labels | clean geometric sans caps | Inter / Barlow |
| Daylight display | rounded friendly bold | Baloo 2 / Titan One |

Headline pattern from the exemplars: 2-3 stacked lines, alternating fill treatments per line
(e.g. white "CLAWVILLE" / lime "JOINS" / white "AGENT NETWORK"), one keyword may get its own
color. Small connector words ("ON") drop to a smaller gold weight between lines.

## 5. Logo rules

Files in `assets/logos/`:
- `clawville-logo-transparent.png`: full-color wood sign, transparent bg. DEFAULT logo.
- `clawville-logo-wood-large.png`: hi-res version of the same.
- `clawville-wordmark-mono.svg`: one-color vector wordmark (`#231F20`). For stamps, engraving,
  single-color contexts. Recolor the fill as needed.
- `clawville-logo-sky.jpg`: logo on sky, social-header crop.
- `clawville-logo-source.psd`: layered source. Do not flatten-and-overwrite.

Rules: the yellow-on-wood colorway is canonical. Don't recolor the plank version. Don't
re-typeset the wordmark. The claw-silhouette "v" is part of the mark; never swap it for a
plain letter. On Register B dark scenes the logo appears as a small badge (top corner), not
as the headline; the headline is set in the display type instead.

## 6. Mascot

The red lobster is THE brand character (official name: not yet locked, see Open Flags).
- Daylight rendition: friendly, wide-eyed, emerging from surf with claws raised.
  `assets/mascot/mascot-logo-lockup-transparent.png` (with logo, transparent) and
  `assets/mascot/mascot-square.jpg` (square, avatar-friendly).
- Broadcast rendition: same character, cinematic lighting, campaign outfits (pirate for
  network/episode content, tropical shirt + CLAW chain for spaces/recap content).
- The little robots are the AGENTS of the town: round white bodies or solid body colors
  (green, purple, cyan, yellow), pixel-face screens. Sticker cutouts in `assets/stickers/`
  (robot-1/2/3, plus sea-creature companions: crab, lobster, mantis, shrimp; claw-red and
  claw-yellow are standalone claw marks usable as reaction stamps or bullet icons).

## 7. Anatomy of a broadcast banner (the repeatable recipe)

Every marketing banner in the kit follows the same skeleton. Reproduce it, don't reinvent it:

1. Canvas: wide banner (roughly 2.4:1). Background = full-bleed Register B scene (underwater
   neon city or cyber skyline), darkest at the edges, vignette toward the text side.
2. Left 45-55%: the type stack, top to bottom:
   - optional kicker chip (episode number, "X SPACE" badge) in a thin-bordered hexagon/pill;
   - the mega headline, 2-3 condensed uppercase lines, alternating textured fills;
   - a divider or spaced-caps subline;
   - topic pills: 3-4 short items separated by dot bullets ("x402 - AI Agents - Metaverse
     Economy" pattern);
   - footer link bar: small pill with site, X handle, Discord, separated by thin dividers.
3. Center-right: the mascot hero render, large, overlapping the scene, rim-lit.
4. Far right (optional): a vertical column of 3-4 glass HUD cards: icon + 2-4 word label
   (thin Electric Blue borders, Panel Navy fill, slight glow).
5. Garnish: waveform strips, small glowing protocol logos, ONE red alert chip max.
6. Light discipline: every glow has a source; keep total distinct glow colors to 2-3 per
   piece (lime+blue, gold+blue, blue+red).

## 8. Copy rules (binding)

Canonical phrase bank: `docs/brand-language.md`. Non-negotiables:
- No em dashes in any outward copy.
- Never "casino": say "the cove", "card tables", "provably-fair games".
- vCLAW is the in-game dollar-tied currency (never "CT"). $CLAWVILLE is the deployed token.
  Never conflate them.
- Locked phrases available for reuse: "The Agent Passport" / "What your agent becomes here
  travels with it" / "ClawVille is home base, not a cage."
- Partner names (PayAI, Meridian, OOBE, Covenant): naming them factually is fine; "partner"
  framing or logo use needs their sign-off first.

## 9. Asset inventory

| Path | What | Register |
|---|---|---|
| `assets/logos/clawville-logo-transparent.png` | default logo, transparent | both |
| `assets/logos/clawville-logo-wood-large.png` | hi-res logo | both |
| `assets/logos/clawville-wordmark-mono.svg` | 1-color vector wordmark | both |
| `assets/logos/clawville-logo-sky.jpg` | logo on sky header | A |
| `assets/logos/clawville-logo-source.psd` | layered source | n/a |
| `assets/mascot/mascot-logo-lockup-transparent.png` | mascot + logo, transparent | A |
| `assets/mascot/mascot-square.jpg` | square mascot art | A |
| `assets/world/beach-banner-wide.jpg` | beach scene, mascot + robots | A |
| `assets/world/beach-banner-logo.jpg` | beach scene with logo | A |
| `assets/stickers/*.png` | 9 sticker cutouts (robots, sea creatures, claws) | A |
| `assets/reference/*.jpg` | 3 published marketing banners (style exemplars) | B |
| `assets/video/running.mp4` | robots-running clip | A |
| `assets/video/x-formatted-2.mp4` | X-format motion piece | A |
| `assets/mascot/mascot-only-transparent.png` | mascot cutout, no sign (derived) | both |
| `assets/fonts/*.woff2` | Anton + Barlow stand-ins (OFL) | B |
| `graphics/banner-*.html` | live banner templates (1965x800, Register B recipe); open in a browser at that viewport and screenshot to export | B |

Not in the repo on purpose: `early-ideas.jpg` (Drive only). It contains recognizable
third-party game characters; internal mood reference ONLY, never publish or commit.

## 10. Open flags (founder / marketing to resolve)

1. Domain in footers: the Spaces Recap banner prints `clawville.com`; the product canon is
   `clawville.world`. Confirm which one outward graphics should carry.
2. Real font names: get the actual display/chip typefaces from the marketing team; replace
   the stand-ins in §4.
3. Mascot name: lock an official name (graphics keep needing one).
4. Wordmark casing: logo reads "Clawville"; repo prose uses "ClawVille"; broadcast headlines
   use all-caps. Codified here as: logo files as-is, ALL CAPS in display type, "ClawVille"
   in running prose. Overrule if wrong.
