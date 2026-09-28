# ClawVille Brand Kit

Public rules and press assets for ClawVille-branded material.

Last Audited: 2026-09-28.
Drift note (09-28): split into a public kit and private team notes; added logo usage rules and sheet, the icon set, the social card, web brand tokens, and the in-app sign; added a transparent hi-res wordmark (the old hi-res file has a baked checkerboard).

Companion copy rules: `docs/brand-language.md`. Public assets live in `branding/assets/`.
Update this guide in the same change as any brand asset or rule change.

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
  economy news. This is the register for x402 / settlement / protocol content.
- Reference assets: `assets/reference/Agent Network EP7.jpg`,
  `assets/reference/Clawville Space Recap.jpg`, `assets/reference/PAY AI Builder Banter.jpg`.

## 3. Color

The web app exposes these colors as `brand.*` Tailwind colors and matching `--brand-*` CSS variables. Existing `claw.*` colors remain separate.

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

**Brand lettering never appears alone.** Use the complete sign: wood plank, Clawville Display
lettering, and emboss layers. The lettering has a darker inner rim, soft bevel, top highlight,
and chocolate offset shadow. Do not place plain Clawville Display text on a flat background.
Use `assets/fonts/render-embossed-text.py` for headline art. It takes text and size and makes
a transparent PNG with a gradient face, darker inner rim, top highlight, and offset shadow.
Place the result on a wood plank. Use a wood plank backing supplied by the marketing team.

**Use one locked font and one weight:** `assets/fonts/ClawvilleDisplay.otf` and `.woff2`.
Do not make another weight or an alternate cut without explicit approval from the ClawVille founder.
Use it for Register A display text and headlines as part of the sign treatment.
Pair Logo Yellow with a Plank Wood offset shadow. Use it for display text only.
The font has 63 glyphs: space, A-Z, a-z, and 0-9. It has no punctuation or kerning table.
The logo files remain canonical; never re-typeset the logo.

The kit also bundles the broadcast stand-ins as woff2 in `assets/fonts/` (Anton 400, Barlow
600/700; both SIL Open Font License) so banner templates render identically everywhere.

| Role | Observed style | Stand-in (Google Fonts) |
|---|---|---|
| Logo wordmark | custom chunky rounded slab, playful | never re-set; use the logo files |
| Broadcast headline | ultra-bold condensed caps, tight tracking, textured fill | Anton, or Archivo Black |
| Broadcast sub/kicker | spaced-out medium caps ("BUILDING THE AGENT INTERNET") | Barlow SemiBold, +0.2em tracking |
| Chips / HUD labels | clean geometric sans caps | Inter / Barlow |
| Daylight display | rounded friendly bold | none needed: use the locked Clawville Display (above) |

Headline pattern from the exemplars: 2-3 stacked lines, alternating fill treatments per line
(e.g. white "CLAWVILLE" / lime "JOINS" / white "AGENT NETWORK"), one keyword may get its own
color. Small connector words ("ON") drop to a smaller gold weight between lines.

## 5. Logo rules

**The official logo** is `assets/logos/clawville-logo-official.png` (1024x1024).
The claw girl has green hair, a pink bow and earmuffs, red antennae, big red lobster claws,
and a white CLAWVILLE crossed-claws tee. She rises from a surf splash under a blue sky.
Use this $CLAWVILLE token logo on listing sites such as CoinGecko, Solscan, Jupiter, and DexScreener.
The source JPEG is `assets/logos/clawville-token-logo-source-1254.jpg` (1254x1254).
Hosted press copies: `https://clawville.world/press/token/clawville-token-logo.png` (512)
and `/press/token/clawville-token-logo-{200,256,512,1024}.png`.
Never mutate a hosted path in place; add a new filename because the Cloudflare edge cache lasts seven days.
Keep the logo square. Never crop the claws or bow, recolor the logo, or add a border.
On dark Register B scenes, use it as a round or rounded-square badge.

The previous official logo, `assets/logos/clawville-logo-official-2026-07-previous.jpg` (200x200),
shows the mascot rising from the surf under the wood sign. Its high-resolution companion is
`assets/mascot/mascot-square.jpg`. Keep it for older material only; do not use it for new listings.
The pirate OG card is alternate promo art, not the official logo.

**THE OFFICIAL BANNER**: `assets/world/clawville-banner-official.gif` (600x200 ANIMATED,
144 frames, the DexScreener header; prefer the GIF wherever animation plays) + static
fallback `assets/world/clawville-banner-official-static.jpg`. The town-square
"More Than A Game" scene (`clawville-logo-banner.jpg`) is a one-off ARTICLE PROMO banner,
not the official banner.

**Token identity:** $CLAWVILLE Solana mint
`Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA`.

Files in `assets/logos/`:
- `clawville-logo-transparent.png`: full-color wood sign, transparent bg. DEFAULT wordmark.
- `clawville-logo-wood-large.png`: 1792x576, OPAQUE: the checkerboard is baked into the pixels; do not use it on a background, use the transparent file.
- `clawville-logo-wood-large-transparent.png`: 1792x576, real alpha; the hi-res default.
- `clawville-wordmark-mono.svg`: one-color vector wordmark (`#231F20`). For stamps, engraving,
  single-color contexts. Recolor the fill as needed.
- `clawville-logo-sky.jpg`: logo on sky, social-header crop.

Rules: the yellow-on-wood colorway is canonical. Don't recolor the plank version. Don't
re-typeset the wordmark. The claw-silhouette "v" is part of the mark; never swap it for a
plain letter. On Register B dark scenes the logo appears as a small badge (top corner), not
as the headline; the headline is set in the display type instead.

## 5a. Logo usage rules

Use the wood-sign wordmark with clear space of at least 0.25 times its height on every side.
Use it at 120 px wide or larger on screen, or 25 mm wide or larger in print. From 80 px to below
120 px, use `clawville-wordmark-mono.svg`. Below 80 px, use the official logo or app icon.
Use the sign on the dark web app background `#061520`, light `#FFFFFF`, sky `#D8E8E0`, or a calm area of a photo.
Never stretch, squash, rotate, recolor, outline, or add a glow ring to the sign. Do not place it
on a busy area, crop the plank, or retype the word in another font.

Keep the official claw-girl logo square. Never crop its claws or bow, recolor it, or add a border.
On dark scenes, use a round or rounded-square badge. See `logo-usage.html` for visual examples.

## 5b. Icons and social

`assets/icons/` contains the full-square claw-girl icon set: favicon `.ico` with 16, 32, and
48 px frames; 16, 32, 48, and 96 px PNGs; apple-touch 180 px; PWA 192 and 512 px; maskable
PWA 512 px; and social avatar 400 px. Each icon uses the full square image, downscaled without
cropping. `assets/icons/alt/` holds a claw-mark small-size alternate for comparison only. The
web app does not use that alternate. `assets/social/og-1200x630.{png,jpg}` shows the beach scene
with the wood sign. Rebuild these files with `python branding/scripts/build_icons.py`.

## 5c. In the web app

The landing hero and the /game loading screen show `/brand/clawville-sign-v1-{480,960}.webp`.
Use that sign image instead of typing the wordmark in a font. Next.js `app/` provides
`favicon.ico`, `icon.png`, `apple-icon.png`, `opengraph-image.jpg`, `twitter-image.jpg`, and
`manifest.ts` with display `browser`. Brand colors use Tailwind `brand.*` and CSS `--brand-*`;
their hex values match section 3. Never mutate a hosted web path in place. Add a new versioned
filename, such as `-v2`, because of the Cloudflare edge cache. The one exception is `app/favicon.ico`: browsers request the bare `/favicon.ico` path, so it is replaced in place and may show the old icon for up to 7 days.

## 6. Mascot

The red lobster is the brand character.
- **Cinematic pirate rendition:**
  `assets/logos/clawville-logo-og.jpg` (square social/OG card, pirate lobster hoisting the
  sign) and the derived transparent hero `assets/mascot/mascot-pirate-cutout.png`: the
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
- **Official links:** website `clawville.world` · X `@Clawville_World` · Discord
  `discord.gg/KJfvM4VqQZ` · Telegram `t.me/clawvillesol` · TikTok `@clawvilleworld` ·
  GitHub `github.com/ItachiDevv/ClawVille`. Outward graphics may carry only these links.
  Do not use `@clawville`.
- **The domain is ALWAYS `clawville.world`** in every footer, link bar, and printed URL.
  Do not copy the `.com` error in the Spaces Recap exemplar.
- Partner names (PayAI, Meridian, Covenant): naming them in graphics and copy is fine
  with no sign-off needed. Follow each partner's published brand guidelines when you place
  its logo.
- Never name OOBE, SAP, or the Synapse Agent Protocol in new graphics, banners, roadmap
  entries, or copy. Do not advertise on-chain bounty escrow or SAP-backed agent identity.
  USDC bounties use a custodial hold with PayAI payout.
  Keep `banner-protocol-upgrades`, `banner-agent-economy-live`, and `banner-agents-pay-agents`
  as records, and treat any other published piece that names them the same way. Do not delete, republish, re-cut, or reuse them as templates.
- Keep logo files as-is. Use ALL CAPS in display type and "ClawVille" in running prose.

## 9. Asset inventory

| Path | What | Register |
|---|---|---|
| `assets/logos/clawville-logo-transparent.png` | default logo, transparent | both |
| `assets/logos/clawville-logo-wood-large.png` | opaque hi-res logo (baked checkerboard); do not use, see `-transparent` | n/a |
| `assets/logos/clawville-logo-wood-large-transparent.png` | hi-res logo with real alpha; default for large backgrounds | both |
| `assets/logos/clawville-wordmark-mono.svg` | 1-color vector wordmark | both |
| `assets/logos/clawville-logo-sky.jpg` | logo on sky header | A |
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
| `assets/logos/clawville-token-logo-source-1254.jpg` | official logo SOURCE (claw girl, 1254x1254 JPEG) | both |
| `apps/web/public/press/token/clawville-token-logo*.png` | HOSTED token logo for listing sites (200/256/512/1024 + default 512) | both |
| `assets/logos/clawville-logo-official.png` | official logo / $CLAWVILLE token logo (claw girl, 1024x1024) | both |
| `assets/logos/clawville-logo-official-2026-07-previous.jpg` | previous official logo (mascot-in-surf, 200x200), legacy only | both |
| `assets/world/clawville-banner-official.gif` | THE official banner, animated (DexScreener header) | A |
| `assets/world/clawville-banner-official-static.jpg` | official banner, static frame | A |
| `assets/world/clawville-logo-banner.jpg` | article PROMO banner ("More Than A Game"), not official | A |
| `assets/fonts/*.woff2` | Anton + Barlow stand-ins (OFL) | B |
| `graphics/banner-*.html` | live banner templates (1965x800, Register B recipe); open in a browser at that viewport and screenshot to export | B |
| `graphics/banner-uos-launch.html` | uOS App Store launch banner: partner-palette variant of Register B. uOS magenta `#FF00C5` replaces lime as the accent; Electric Blue stays. `.keep{text-transform:none}` preserves lowercase "u" in "uOS" against Anton's uppercase. | B |
| `assets/fonts/ClawvilleDisplay.otf` / `.woff2` | THE brand display font (locked, one weight) | A |
| `assets/fonts/render-embossed-text.py` | emboss renderer: text in, transparent headline PNG out | A |
| `brand-board.html` | visual one-page board of colors, logos, mascot, stickers | both |
| `logo-usage.html` | visual logo rules and examples | both |
| `logo-work/` | vector candidates, not approved for use | n/a |
| `scripts/build_icons.py` | icon, social card, and web brand asset builder | both |
| `assets/icons/` | full-square claw-girl favicon, PNG, PWA, and social avatar set | both |
| `assets/icons/alt/` | claw-mark small-size comparison alternate | both |
| `assets/social/` | 1200x630 beach scene and wood-sign social cards | both |

Team-only notes are kept outside this repository.
