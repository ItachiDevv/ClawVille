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

**RULE (founder insight 2026-07-27): the brand lettering NEVER appears standalone.** It has
only ever existed as one fused unit: letterforms + wood plank texture + embossed layering
(darker inner rim, soft bevel, top highlight, chocolate offset shadow). Rendering the font
alone on a flat background always lands flat and is NOT the brand look. The reusable
component is the SIGN: wood plank + Clawville Display text + the emboss layer recipe.
The emboss layering is IMPLEMENTED as a renderer: `assets/fonts/render-embossed-text.py`
(text + size in, transparent PNG out: gradient face, thin darker inner rim, subtle top
highlight, crisp chocolate offset shadow) — calibrated side-by-side against the real logo.
Use it for headline art. Plank/wood backing: still marketing-supplied when needed.

**⛔ LOCKED (founder 2026-07-27): the shipped `ClawvilleDisplay.otf`/`.woff2` is THE brand
font — ONE font, ONE weight (the +18% build), NO variants.** Do not rebuild at other
weights, regenerate sheets, or introduce alternate cuts without explicit founder direction.
The pipeline below stays only for repair/regeneration of THIS font.

**Clawville Display — the REAL brand font (v3, built 2026-07-27, fully ours).** The logo
lettering was AI-generated art with no font file behind it, so we built one. Pipeline:
gpt-image-2 generated three alphabet sheets (upper / lower / digits) styled on THREE logo
references with the dimensional bouncy hand-drawn character preserved, then a local pipeline
(color mask, connected-component glyph slicing, potrace vectorization, fontTools assembly)
produced `assets/fonts/ClawvilleDisplay.otf` + `.woff2`. Use it for Register A display text,
headlines, and anywhere the playful chunky-slab voice fits; pair with Logo Yellow fill +
Plank Wood offset shadow to reproduce the logo treatment. Caveats: display use only (no
kerning, basic metrics); the LOGO files themselves remain canonical, never re-typeset the
logo. Regenerate: sheets via `assets/fonts/generate-glyphsheets.py` (needs OPENAI_API_KEY),
font via `assets/fonts/build-clawville-display.py` (reads `assets/fonts/glyphsheets/`).

The kit also bundles the broadcast stand-ins as woff2 in `assets/fonts/` (Anton 400, Barlow
600/700; both SIL Open Font License) so banner templates render identically everywhere.

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

**THE OFFICIAL LOGO** (founder-confirmed 2026-07-26, pulled from the token's DexScreener
profile): `assets/logos/clawville-logo-official.jpg` (200x200) = the daylight mascot bursting
from the surf under the wood sign. Hi-res version of the same composition:
`assets/mascot/mascot-square.jpg`. The pirate OG card is ALTERNATE promo art, not the logo.

**THE OFFICIAL BANNER**: `assets/world/clawville-banner-official.gif` (600x200 ANIMATED,
144 frames, the DexScreener header; prefer the GIF wherever animation plays) + static
fallback `assets/world/clawville-banner-official-static.jpg`. The town-square
"More Than A Game" scene (`clawville-logo-banner.jpg`) is a one-off ARTICLE PROMO banner,
not the official banner.

**Token identity + live source of truth:** $CLAWVILLE mint
`Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA` (Solana). Re-pull current official assets any
time from the DexScreener API (`https://api.dexscreener.com/latest/dex/tokens/<mint>` →
`info.imageUrl` logo / `info.header` banner; strip the query params from the CDN URL to get
the ORIGINAL file, which is how the kit copies were fetched).

Files in `assets/logos/`:
- `clawville-logo-transparent.png`: full-color wood sign, transparent bg. DEFAULT wordmark.
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
- **Cinematic pirate rendition IS in the kit** (added 2026-07-26 by the founder):
  `assets/logos/clawville-logo-og.jpg` (square social/OG card, pirate lobster hoisting the
  sign) and the derived transparent hero `assets/mascot/mascot-pirate-cutout.png` — the
  DEFAULT hero for Register B banners (it carries the logo sign, so no separate logo badge
  is needed in the layout).
- Tagline "More Than A Game" appears on the article-promo banner
  (`assets/world/clawville-logo-banner.jpg`); treat as available copy, not locked brand
  language (the promo banner is not the official banner).
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
- **The domain is ALWAYS `clawville.world`** in every footer, link bar, and printed URL.
  We do not own clawville.com; the `.com` printed in the Spaces Recap exemplar is an error,
  never copy it. (Founder ruling 2026-07-26.)
- Partner names (PayAI, Meridian, OOBE, Covenant): naming them in graphics and copy is fine
  with no sign-off needed; we implement their software and are partnered with them.
  (Founder ruling 2026-07-26.) When placing their actual LOGOS, follow each project's own
  published brand guidelines as normal practice.

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
| `assets/mascot/mascot-pirate-cutout.png` | cinematic pirate hero, transparent (derived from og) | B |
| `assets/logos/clawville-logo-og.jpg` | square OG/social card, pirate + sign (ALTERNATE promo art) | B |
| `assets/logos/clawville-logo-official.jpg` | THE official logo (DexScreener token profile, 200x200) | both |
| `assets/world/clawville-banner-official.gif` | THE official banner, animated (DexScreener header) | A |
| `assets/world/clawville-banner-official-static.jpg` | official banner, static frame | A |
| `assets/world/clawville-logo-banner.jpg` | article PROMO banner ("More Than A Game"), not official | A |
| `assets/fonts/*.woff2` | Anton + Barlow stand-ins (OFL) | B |
| `graphics/banner-*.html` | live banner templates (1965x800, Register B recipe); open in a browser at that viewport and screenshot to export | B |

Not in the repo on purpose: `early-ideas.jpg` (Drive only). It contains recognizable
third-party game characters; internal mood reference ONLY, never publish or commit.

## 10. Open flags (founder / marketing to resolve)

1. ~~Domain~~ RESOLVED 2026-07-26: always `clawville.world` (we do not own .com); rule moved
   to §8.
2. Real font names: get the actual display/chip typefaces from the marketing team; replace
   the stand-ins in §4.
3. Mascot name: lock an official name (graphics keep needing one).
4. Wordmark casing: logo reads "Clawville"; repo prose uses "ClawVille"; broadcast headlines
   use all-caps. Codified here as: logo files as-is, ALL CAPS in display type, "ClawVille"
   in running prose. Overrule if wrong.
5. ~~Cinematic mascot renders~~ PARTIALLY RESOLVED 2026-07-26: the pirate render arrived
   (`clawville-logo-og.jpg`, cutout derived) and is now the default Register B hero. The
   tropical-shirt variant still exists only baked into the Recap exemplar; add it if a
   standalone version turns up.
