# ClawVille on Steam — Policy & Legal Compliance Audit

**Author:** Policy & Legal lead, ClawVille Steam Packaging Research Team
**Last Audited:** 2026-04-17
**Scope:** Non-technical acceptance risk for shipping ClawVille as a Steam app (Windows-first)
**Source-of-truth for all citations:** URLs listed in the References section, each annotated with access date (2026-04-17 unless otherwise noted).

---

## 0. Executive Summary

1. **Probability of acceptance on Steam as currently architected: ~10–20%.** ClawVille in its present form triggers at least three high-risk onboarding rules simultaneously (Rule 13 blockchain, live-generated AI disclosure with guardrails requirement, and online-only dependency with AB 2426 implications). No clean precedent exists for a Steam build that ships with a **skill marketplace backed by ClawTokens that are tradeable for value** — every approved "Web3 on Steam" title (Off The Grid, Sparkball, Champions Ascension, The Bornless, Superior, Angelic) **shipped a Steam build with blockchain/marketplace functionality fully disabled**, deferring crypto interactions to an external website or separate launcher.

2. **There is a clear, proven path to ~70–80% acceptance probability**: ship a "Steam Edition" of ClawVille that (a) removes `bazaar_listings`, `auctions`, and `claw_token_transactions` UI + API calls from the client, (b) strips custodial Solana wallet generation and any `wallet_address` surfacing for Steam users, (c) replaces ClawTokens with a non-transferable in-game currency disclosed under "In-Game Purchases," (d) honestly discloses live-generated Gemini-powered NPC/avatar dialogue in the AI survey with explicit guardrails documentation, and (e) uses Steam Microtransactions API exclusively if any tokens are sellable. The web build at `clawville.world` can retain everything.

3. **The three things most likely to get us rejected outright, in descending severity:**
   - **Rule 13** (blockchain/crypto/NFT — never rescinded, enforced as recently as mid-2025). Custodial-vs-player-owned distinction is **not carved out in the rule text**; precedent is that Valve evaluates case-by-case and crypto must be *absent from the Steam build*, not merely abstracted.
   - **Rule 15** (payment-processor-risk content, added 2025-07-16). Our skill marketplace with real-money settlement is chargeback-dense by design — same category of risk that triggered the July 2025 removals.
   - **AI disclosure non-compliance or weak guardrails** (rewritten 2026-01-16). Live-generated NPC dialogue from Gemini 2.5 *must* be disclosed; guardrails text must describe content filtering, prompt restrictions, and moderation — weak language here triggers rejection and exposes us to the Steam-overlay user-report button that Valve added in the same update.

4. **Timeline impact:** Even on the optimistic path, minimum time-to-store is ≥ 30 business days (Steam Direct $100 paid → 30-day bank-verification waiting period → store page "Coming Soon" visible ≥ 2 weeks → store review 3–5 business days → build review 3–5 business days). Assume 6–8 weeks realistic, 10–12 weeks if we need a rework pass after an initial rejection.

5. **Critical unknown:** Whether the MCP/agent-gateway (`/api/agent/connect` + SKILL.md surfaces) — which is core to project priority #2 — is considered "content" by a Steam reviewer. There is **no precedent** for a Steam game whose primary purpose is programmatic access by third-party AI agents. This is the single biggest policy risk after Rule 13 and should be tested with Valve via support ticket *before* we burn the $100 Steam Direct fee.

---

## 1. Rule-by-Rule Onboarding Audit

Source: [Steamworks Onboarding](https://partner.steamgames.com/doc/gettingstarted/onboarding) (accessed 2026-04-17). All 15 numbered items below are verbatim from the page.

| # | Verbatim Rule Text | ClawVille Current Status | Action Required |
|---|---|---|---|
| 1 | "Hate speech, i.e. speech that promotes hatred, violence or discrimination against groups of people based on ethnicity, religion, gender, age, disability or sexual orientation" | LOW RISK. NPC dialogue comes from Gemini 2.5. Avatar/agent chat is open-ended. Gemini has safety filters; we do not. | Implement a content-moderation layer on all user→Gemini and Gemini→user flows before Steam ship. Log flagged outputs. Required as part of AI guardrails disclosure (§5). |
| 2 | "Nude or sexually explicit images of real people" | N/A. No photography, no real-person likeness. | None. |
| 3 | "Adult content that isn't appropriately labeled and age-gated" | N/A — our game is PG. | None, unless we add mature content. |
| 4 | "Libelous or defamatory statements" | LOW RISK from devs; MEDIUM risk from Gemini if it hallucinates about real people. | Add a system-prompt clause barring Gemini from generating statements about named real individuals. Add to guardrails disclosure. |
| 5 | "Content you don't own or have adequate rights to" | MEDIUM RISK. Verify we own or have license for all 3D models (lobster GLBs, 10 buildings, NPC GLBs), all audio, all fonts, all Gemini-generated static assets that ship in build. | Full asset-rights audit before submission. Document provenance of every file under `apps/web/public/models/`. |
| 6 | "Content that violates the laws of any jurisdiction in which it will be available" | HIGH RISK (crypto-angle). Several jurisdictions (e.g. China, South Korea, India, parts of EU under MiCA) have specific restrictions on tokenized game items, even custodial ones. | If we strip the Web3 layer from Steam build this collapses to LOW. If not, we must geo-restrict via Steam's regional availability tools. |
| 7 | "Content that is patently offensive or intended to shock or disgust viewers" | LOW RISK in static content; MEDIUM in live-generated Gemini output. | Guardrails (§5) cover this. |
| 8 | "Content that exploits children in any way" | N/A. | None. |
| 9 | "Applications that modify customer's computers in unexpected or harmful ways, such as malware or viruses" | LOW RISK. Standard Electron/Next.js binary, no kernel drivers, no background services. | Ensure launcher does not silently install anything. Single-click install flow. |
| 10 | "Applications that fraudulently attempts to gather sensitive information, such as Steam credentials or financial data" | LOW RISK. We don't touch Steam creds. We do collect an email for `users` table — disclose in Privacy Policy. | Link Privacy Policy from store page (legally required anyway under GDPR / CCPA). |
| 11 | "Video content not directly related to a product that has shipped on Steam" | N/A. | None. |
| 12 | "Non-interactive 360 VR Videos" | N/A. | None. |
| 13 | **"Applications built on blockchain technology that issue or allow exchange of cryptocurrencies or NFTs"** | **CRITICAL.** ClawVille *is* currently built on blockchain: (a) `treasury_wallets` and `avatar_wallet` tables store encrypted Solana keypairs, (b) `CLAWVILLE_MERCHANT_WALLET_PUBKEY` is a Solana pubkey, (c) `claw_token_transactions` ledger tracks on-chain settlement, (d) `bazaar_listings` + `auctions` enable exchange of skill NFTs, (e) x402 middleware (Phase 4) processes Solana payments. | See §2 Blockchain Deep-Dive. Mandatory stripping for Steam build. |
| 14 | "Applications with advertising-based business models" | N/A — we're a free/paid game, no ads. | None. |
| 15 | **"Content that may violate the rules and standards set forth by Steam's payment processors and related card networks and banks, or internet network providers. In particular, certain kinds of adult only content."** (Added 2025-07-16.) | **HIGH RISK** even if crypto is stripped. A skill marketplace where agents and humans settle real-money trades resembles the chargeback-dense categories that triggered the July 2025 removal wave. Payment processors (Visa/MC/Amex) flag reputational risk on anything adjacent to skin-gambling, real-money trading, or unregulated securities. | Skill marketplace must be disabled in Steam build. Any currency in Steam build must go through Steam Microtransactions API exclusively. |

### Non-numbered requirements from the same onboarding page
- **30-day waiting period** between Steam Direct fee payment and the ability to release. Starts when bank info is verified.
- **≥ 2-week "Coming Soon" store page visibility** required before release.
- **Store review** takes 3–5 business days; submit ≥ 7 business days before intended visibility.
- **Build review** takes 3–5 business days; must be "mostly final" and include every feature listed on the store page.

---

## 2. Blockchain Policy Deep-Dive (Rule #13)

### 2.1 Verbatim rule text (primary source)

> "Applications built on blockchain technology that issue or allow exchange of cryptocurrencies or NFTs."

Source: [partner.steamgames.com/doc/gettingstarted/onboarding](https://partner.steamgames.com/doc/gettingstarted/onboarding), item #13, accessed 2026-04-17. Originally introduced in an October 15, 2021 update to the Steamworks onboarding document. **Never rescinded.**

### 2.2 Does "custodial" save us?

**No.** The rule text does not distinguish between custodial wallets (where the user never holds the private key) and self-custody wallets. What the rule explicitly prohibits are applications that **"issue or allow exchange of"** crypto/NFTs — both verbs apply to our architecture:

- **"Issue"** — ClawTokens are issued on-chain via the x402 middleware / merchant wallet flow (Phase 4).
- **"Allow exchange of"** — `bazaar_listings` and `auctions` tables implement skill marketplace trades; `claw_token_transactions` is the settlement ledger.

The fact that users never see a private key is not a safe harbor. From ClawVille's own documentation (`CLAUDE.md`): *"wallet_address (base58, auto-generated custodial Solana)"*. That column is present on the `avatars` table regardless of whether the Steam UI surfaces it.

### 2.3 Enforcement precedent (2024–2026)

**Games that passed Steam review, and how:**

| Title | Approach | Source |
|---|---|---|
| Off The Grid (Gunzilla) | Published two distinct builds. Steam build has blockchain completely separate; players can play without touching a crypto wallet. Quote from Gunzilla's Director of Web3: "players can experience a great video game first and foremost … blockchain elements will not be intrusive as they are simply an optional layer, though it's also possible that Off The Grid's blockchain elements may not be available on the Steam version at all." | [CCN](https://www.ccn.com/news/technology/off-the-grid-first-blockchain-game-steam-crypto-ban/), [Cointelegraph](https://cointelegraph.com/magazine/off-the-grid-steam-launch-maplestoryu-cheaters-lol-land-review-web3-gamer/), [Token Relations](https://www.token-relations.xyz/p/off-the-grid-launches-to-steam) |
| Sparkball (Worldspark / Opti Games) | Web3 elements "out of sight and out of mind for web2 players." Integration is in a separate companion platform "Sparkadia," not the Steam build. | [Sequence blog](https://sequence.xyz/blog/sequence-sparkball-web3-gaming-gets-fun-and-competitive), [GAM3S.GG](https://gam3s.gg/sparkball/) |
| Champions Ascension | Developer explicit: *"The game won't be exchanging NFTs or cryptocurrencies on the platform. It will be disabled, respecting the Terms of Service. If players want those elements, they will have to go to our website."* | [Decrypt](https://decrypt.co/153196/crypto-nft-games-still-launching-steam-despite-ongoing-ban) |
| The Bornless | Web3 overlays the game rather than being core; players opt in. Steam build is non-crypto. | [Decrypt](https://decrypt.co/153196/crypto-nft-games-still-launching-steam-despite-ongoing-ban) |
| Superior (Gala Games) | Steam build is non-NFT. Crypto version distributed through separate Elixir launcher. | [Decrypt](https://decrypt.co/153196/crypto-nft-games-still-launching-steam-despite-ongoing-ban) |
| Angelic | Explicitly "totally crypto-free" Steam build. | [Decrypt](https://decrypt.co/153196/crypto-nft-games-still-launching-steam-despite-ongoing-ban) |

**Games that failed the spirit of the rule and faced backlash (instructive precedent):**

- **MagicCraft** — listed on Steam with no crypto mention on the store page, but the *game itself* required a crypto wallet connection. Received negative reviews citing "crypto and NFTs BS." Highlighted as an example of what not to do. ([Decrypt](https://decrypt.co/153196/crypto-nft-games-still-launching-steam-despite-ongoing-ban))
- **Kingdom Under Fire: War of Heroes Gold Edition** — required an external blockchain app (Locus Game Chain), caused processing concerns. ([Decrypt](https://decrypt.co/153196/crypto-nft-games-still-launching-steam-despite-ongoing-ban))

### 2.4 Gating strategy — is it accepted practice?

**Yes, with a very specific pattern:** Every accepted Web3-on-Steam title in 2024–2026 follows what I'll call the **"Sister Build" pattern**:

1. The Steam client ships **with the blockchain code path compiled out** (not feature-flagged at runtime — *genuinely absent* from the binary).
2. Marketing copy on the Steam store page does not mention blockchain, NFTs, tokens, crypto, or wallets.
3. Crypto features live on a **separately branded web surface** (their own website, a separate launcher, or a companion app distributed outside Steam).
4. The Steam build and the web build are **sister products** sharing the same core gameplay but with entirely separate feature sets.

Valve appears to review these **case-by-case** — there is no published carve-out. [CCN](https://www.ccn.com/news/technology/steam-web3-game-experimental/) reported in 2025 that "Steam appears to handle Web3 gaming launches on a case-by-case basis." There is no formal appeal process documented in [Steam's review process docs](https://partner.steamgames.com/doc/store/review_process).

**Recommended gating for ClawVille:**

- Build a `STEAM_BUILD=true` compile-time flag that **removes**, not disables, the following from the Next.js bundle and API surface consumed by the Steam client:
  - `bazaar_listings`, `auctions`, `claw_token_transactions` routes and UI
  - `treasury_wallets`, `avatar_wallet`, `CLAWVILLE_MERCHANT_WALLET_PUBKEY` (custodial wallet generation on avatar creation must be skipped entirely for Steam users)
  - x402 middleware entirely
  - The `wallet_address` column surfacing in any UI (column can remain in DB for web users, but the Steam client must never read it)
  - All "buy skill," "sell skill," "auction," "listing" UI paths
- Steam store page: zero mentions of crypto, blockchain, wallets, tokens, NFTs, Solana, x402.
- Keep the custodial Solana code path on `clawville.world` only. The Steam build routes to a separate API subdomain (e.g. `steam.api.clawville.world`) that has the crypto routes stubbed out or 404'd at the reverse proxy layer.
- If we keep ClawTokens under that name in the Steam build, they must be (a) non-transferable, (b) not exchangeable for real money or crypto, (c) not awarded for actions that correspond to crypto events on the web build. Safer: rename them ("ClawShells"?) in the Steam build to avoid any perceptual link to the web version's tokens.

### 2.5 The unique ClawVille risk — agent-gateway as "exchange"

There is a second-order Rule 13 risk that no prior Steam precedent addresses: **ClawVille's core purpose (project priority #2) is enabling external AI agents to connect, learn skills, and participate in a marketplace.** Even if we strip the client-side marketplace UI from the Steam build, the agent-gateway at `/api/agent/connect` could be interpreted by a reviewer as "allowing exchange of" skills/value — especially if they read our store description honestly.

**Mitigation:** The Steam store page must present ClawVille as a single-player + multiplayer 3D game with AI companion agents. The agent-gateway stays open on the web API but is **not marketed on the Steam store page**. This is not duplicitous — it is the same pattern Off The Grid and Sparkball use — but it does mean reworking our Steam marketing copy to de-emphasize the skill marketplace and open-agent-onboarding aspects of the project.

---

## 3. AI Disclosure Requirements

### 3.1 The rewrite — what changed on 2026-01-16 / 2026-01-17

Source: Valve announcement, summarized by [VGC](https://www.videogameschronicle.com/news/valve-has-significantly-rewritten-steams-rules-for-how-developers-much-disclose-ai-use/), [PC Gamer](https://www.pcgamer.com/software/ai/steam-updates-ai-disclosure-form-to-specify-that-its-focused-on-ai-generated-content-that-is-consumed-by-players-not-efficiency-tools-used-behind-the-scenes/), [Game Developer](https://www.gamedeveloper.com/business/valve-tweaks-and-clarifies-ai-disclosure-rules-for-steam). All three accessed 2026-04-17.

Three structural changes on 2026-01-16:

1. **AI dev tools are exempt.** "Efficiency gains through the use of AI powered dev tools is not the focus of this section." Code assistants, Photoshop generative fill used in concept art, ChatGPT used on spreadsheets — none of these need disclosure.
2. **Two disclosure categories remain mandatory:**
   - **Pre-Generated**: *"Any kind of content (art/code/sound/etc) created with the help of AI tools during development"* — only requires disclosure if the output **ships with the game and is consumed by players** OR appears in marketing materials or the Steam store page.
   - **Live-Generated**: *"Any kind of content created with the help of AI tools while the game is running."*
3. **Live-generated content requires guardrails disclosure.** Developers must "tell us what kind of guardrails you're putting on your AI to ensure it's not generating illegal content." Valve added a button to the Steam overlay that lets users report illegal content generated by live-AI games. **Adult Only Sexual Content generated by live AI is an absolute prohibition with no exception** (per GosuGamers coverage of the update).

Primary source for the survey structure: [partner.steamgames.com/doc/gettingstarted/contentsurvey](https://partner.steamgames.com/doc/gettingstarted/contentsurvey). The page publicly confirms the three survey sections (General Content, Mature Content, Generative AI Content) and the Pre-Generated / Live-Generated split.

### 3.2 ClawVille's AI profile

| Surface | AI Use | Category | Requires Disclosure? |
|---|---|---|---|
| NPC dialogue (building characters) | Generated live via Gemini 2.5 with per-NPC character templates | **Live-Generated** | **Yes — with guardrails** |
| Avatar/agent chat (user's own agent) | Generated live via Gemini 2.5 through ElizaOS runtime | **Live-Generated** | **Yes — with guardrails** |
| NPC→NPC ambient banter | Generated live via Gemini 2.5 (`npc-conversation-engine.ts`) | **Live-Generated** | **Yes — with guardrails** |
| Text embeddings for memory | Gemini embedding API | Not player-consumed content | No |
| 3D models (lobster, buildings) | Human-created or licensed — **confirm** | Pre-Generated *if* any were AI-generated | Yes, if any |
| Icons / UI art | Likely AI-generated (verify with design) | Pre-Generated | **Yes**, if yes |
| Store page marketing copy / screenshots | Human-written so far; verify any capsule art | Pre-Generated (marketing category) | **Yes**, if AI used |
| SKILL.md content | Written from web sources (precompiled knowledge) | Pre-Generated (arguably) | Disclosure safer than not |

### 3.3 Our draft answers to the survey

**Pre-Generated disclosure (tentative — pending asset audit):**

> "Portions of ClawVille's 2D UI icons and capsule art were created with the assistance of generative AI image tools (enumerate specific tools: Midjourney v6, DALL-E 3, etc. — to be confirmed). All 3D models, animations, and gameplay audio were created by human artists or licensed from human-authored libraries. Store page screenshots are captured from live gameplay and are unmodified. Knowledge book content (the 20 skill books) was compiled and edited by humans from public source material; no AI text generation was used for the book content."

**(If the asset audit reveals zero AI use, we simplify: "No pre-generated AI content is used in ClawVille." That is much safer and shorter.)**

**Live-Generated disclosure:**

> "ClawVille uses Google's Gemini 2.5 family of language models (gemini-2.5-flash and gemini-2.5-pro) to generate dialogue for three classes of in-game characters: (1) the 10 building-resident NPCs who teach in-game skills, (2) the player's own AI avatar/agent companion, and (3) ambient NPC-to-NPC conversations that occur as world-decoration. All dialogue is generated at runtime. Game state, player input, and a character-specific system prompt are sent to Gemini; the response is displayed to the player."

**Guardrails disclosure (this is the critical field):**

> "Guardrails layered on all live-generated dialogue:
> 1. **Provider-side safety**: Google Gemini's default safety filters (harassment, hate speech, sexually explicit, dangerous content — all set to BLOCK_MEDIUM_AND_ABOVE).
> 2. **System prompt constraints**: Every character prompt includes a top-level clause forbidding: sexually explicit content, graphic violence, real-person impersonation, defamatory statements about identifiable individuals, medical/legal/financial advice framed as authoritative, and any reference to minors in inappropriate contexts.
> 3. **Output-side moderation**: An additional post-generation content filter (OpenAI moderation API or equivalent) scans every Gemini response before it reaches the player. Flagged responses are suppressed and replaced with a generic character-appropriate fallback string.
> 4. **Input sanitization**: Player messages pass through a prompt-injection filter and a banned-phrase list before being sent to Gemini.
> 5. **Server-side logging**: Every prompt/response pair is logged server-side (redacted for PII) for post-hoc moderation review. We honor user reports submitted through the Steam overlay's report button and will remove any flagged content from training/fine-tuning corpora.
> 6. **Absolute exclusion**: The system cannot generate Adult Only Sexual Content under any input. Even if the Gemini provider filters are bypassed via prompt injection, the post-generation classifier will block output before it renders to the player."

**Risks with our current implementation:**

- **Guardrails #3, #4, and #5 are not actually implemented in the current codebase.** Grep confirms no `openai-moderation` call, no prompt-injection filter, no redacted logging pipeline in `apps/api/src/services/npc-conversation-engine.ts`. Submitting the disclosure above today would be *lying to Valve*. We must build the moderation layer before Steam ship — this is a hard gate.
- **Gemini safety filters alone are insufficient.** Valve's 2026-01 rewrite emphasizes that the responsibility is on the developer, not the model provider. A "we rely on Gemini's built-in safety" answer is the weakest form of disclosure and invites rejection.
- **The Steam overlay report button matters.** Once enabled, users can report objectionable live-AI output directly to Valve. High report volume → review → potential delisting. This means our moderation must work in practice, not just on paper.

### 3.4 AI disclosure *does not trigger* higher age ratings by itself
 
Per [Michalsons](https://www.michalsons.com/blog/unpacking-steams-ai-disclosure-requirements-for-steam-games/70469) and the Steam content survey structure, the AI Generated Content section is **separate from** the Mature Content survey that drives age-gates. AI use is disclosed as a descriptor; age rating is driven by the mature-content questionnaire (violence, sexual content, drug use, etc.). That said, **if live-generated dialogue is flagged by reviewers as producing mature output despite our guardrails**, the age rating can be escalated after the fact. User-generated content in general is an age-rating escalator — per the IARC questionnaire guidance, "user-generated content all trigger higher ratings" if users can produce content the developer does not moderate strictly. ([Skala blog](https://www.skala.io/blog/age-ratings-for-games-a-practical-guide-for-game-development-startups))

---

## 4. Store Page Required Disclosures

### 4.1 Mandatory disclosures

| Disclosure | Source | ClawVille application |
|---|---|---|
| **AI Generated Content Disclosure** — appears between game description and system requirements on the store page when developer discloses AI use | [Steam AI disclosure policy](https://store.steampowered.com/news/group/4145017/view/3862463747997849618) | **Required** for ClawVille (live-generated NPC dialogue). Populated from our survey answers in §3.3. |
| **Digital-license disclaimer** at checkout — *"A purchase of a digital product grants a license for the product on Steam"* (Steam-wide banner added 2024-10 in response to California AB 2426) | [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/); [The Gamer coverage](https://www.thegamer.com/steam-digital-game-ownership-licence-disclaimer/) | **Handled automatically** by Steam; no action from us, but we should be aware it applies. |
| **Online Services Required** — store page tag | No explicit Steam rule found requiring a separate "Online-Only" disclosure, but games that require persistent internet/server connectivity are expected to list it in system requirements. The Steam community forum has long requested a formal always-online tag; none exists as of 2026-04. | **Must be listed** in system requirements section ("Additional Notes: Requires persistent internet connection; server shutdown will prevent play"). See §4.2 refund risk. |
| **In-Game Purchases** tag — Steam displays this automatically if the game uses Steam Microtransactions API | [Steam Microtransactions docs](https://partner.steamgames.com/doc/features/microtransactions) | Applies only if we ship a token store via Steam Wallet. Not applicable if Steam build is purely premium-priced, no microtransactions. |
| **Mature Content Warning** | [Content Warning Screens docs](https://partner.steamgames.com/doc/store/age_gate) | Probably not triggered — ClawVille is PG. Verify after content survey. |

### 4.2 Online-Only risk — the refund multiplier

Steam's refund policy is uniform: **14 days and < 2 hours played**, no exceptions for online-only games. ([Steam Refunds portal](https://store.steampowered.com/steam_refunds/portal.php?l=english), last updated 2024-04-23, accessed 2026-04-17.)

ClawVille cannot run without `api.clawville.world`. Every minute of server downtime is a minute where new Steam purchases become instant refund candidates. Risks:

- **Single regional outage** (Hetzner Ashburn goes down, Cloudflare routing issue) → hundreds of refunds in under 2 hours.
- **Cumulative uptime SLA risk** — if we average < 99% uptime month-over-month, refund rate compounds, and high refund rates on a small-app store page can suppress visibility in Steam's recommendation algorithms.
- **No "server shutdown" notice obligation** currently codified at Steam level, but California AB 2426 and analogous EU consumer-protection trends mean we *should* publish a stated support window (e.g. "ClawVille servers will be maintained for at least 24 months from release; 90-day advance notice will be provided before shutdown") on the store page and in the EULA.

**Action:** Draft an EULA (Steam lets us attach one) with a server commitment clause. Add "Requires always-on internet connection; ClawVille servers must be reachable to play" to the store page description, in the first screen of visible copy. This pre-empts refunds that would otherwise cite misrepresentation.

### 4.3 Privacy Policy requirement

Although not a Steam-specific rule, GDPR/CCPA/CPRA require a published privacy policy for any game collecting personal data (we collect email via Lucia auth, and Gemini processes player input). Steam store pages support a "Privacy Policy URL" field. Populate it with `https://clawville.world/privacy`.

---

## 5. Tax, Banking, Legal Setup Checklist

### 5.1 Steam Direct fee

- **Amount:** $100 USD (or local equivalent) per app. ([Steamworks App Fee](https://partner.steamgames.com/doc/gettingstarted/appfee))
- **Recoupable at $1,000 USD Adjusted Gross Revenue**; Valve retains it until then, then credits back in the monthly report.
- **Non-refundable** if revenue target is not hit.
- **Per-app**, not per-studio — each subsequent ClawVille app (DLC, new SKU, sequel) is another $100.

### 5.2 Tax forms

Source: [Steamworks Tax FAQ](https://partner.steamgames.com/doc/finance/taxfaq).

| Form | Who | What it does |
|---|---|---|
| **W-9** | US individuals / entities | 1099 issued by Valve at year-end |
| **W-8BEN** | Non-US individual, country with US tax treaty | Reduced withholding from default 30% on US-source revenue |
| **W-8BEN-E** | Non-US entity (corporation/LLC), country with US tax treaty | Same as above for entities |

ClawVille developer entity (if US): W-9. (If foreign: W-8BEN or W-8BEN-E based on structure.) Provide TIN/EIN to minimize withholding.

**Payout minimum:** ~$100 USD equivalent before payout triggers — confirm against live Steamworks partner portal; Tax FAQ does not state the minimum verbatim but third-party sources ([Fungies.io guide](https://fungies.io/steam-revenue-share-explained/)) confirm $100 as the historical threshold.

**Payout cadence:** Monthly, approximately 30 days after the end of each calendar month.

### 5.3 Revenue share

Source: [Steam Distribution Agreement revenue tiers announcement](https://steamcommunity.com/groups/steamworks/announcements/detail/1697191267930157838), summarized in [Fungies.io](https://fungies.io/steam-revenue-share-explained/).

| Tier | Revenue band | Dev share | Valve share |
|---|---|---|---|
| Base | $0 – $10M | 70% | 30% |
| Tier 2 | $10M – $50M | 75% | 25% |
| Tier 3 | > $50M | 80% | 20% |

Tiers are per-app lifetime revenue.

### 5.4 Bank & entity setup checklist

- [ ] Decide legal entity for Steam partner (recommended: a US Delaware C-Corp or LLC already established for ClawVille; alternative: UK/Singapore/BVI entity with US withholding implications)
- [ ] EIN obtained (or foreign TIN)
- [ ] Business bank account dedicated to Steam payouts (Valve pays via ACH or wire; some regions have issues — verify the partner's home country is on Valve's supported-payouts list via the Steamworks Tax Interview)
- [ ] Tax Interview completed in Steamworks (5–10 min)
- [ ] W-9 or W-8BEN/W-8BEN-E submitted and approved
- [ ] Bank info submitted and verified (triggers start of 30-day waiting period)
- [ ] EULA drafted, including server-shutdown clause, Gemini AI disclosure, and custodial-wallet absence in Steam build
- [ ] Privacy Policy hosted and URL added to store page
- [ ] DMCA/copyright contact added to Steamworks partner settings
- [ ] Age rating self-survey completed (IARC path for non-US markets; ESRB equivalent for US — Steam uses self-declared surveys, not external ESRB/PEGI ratings, per [Steam Content Guide](https://store.steampowered.com/contentguide/))
- [ ] VAT/sales tax handling noted — Steam collects VAT in 60+ jurisdictions on our behalf (per Tax FAQ), rates 5–27.5%, inclusive pricing

### 5.5 Regional restrictions

Countries where Steam payouts are problematic or blocked (historic list, verify at partner onboarding):
- North Korea, Iran, Syria, Cuba — OFAC sanctions, no payout
- Russia, Belarus — payments have been disrupted since 2022 sanctions waves
- China — Steam has a separate "Steam China" client; mainland China access to the global Steam store is semi-blocked

If ClawVille ships globally, none of the above are revenue centers for us. No geo-blocking action needed unless we decide to restrict crypto-enabled regions (moot if we strip crypto from Steam build).

---

## 6. Pre-Submission Valve Contact

### 6.1 The email question

**`steamdirect@valvesoftware.com` is NOT currently documented** as a supported contact address in Valve's [Contacting Valve / Steam Steamworks doc](https://partner.steamgames.com/doc/help/contact). That doc points developers to a single support portal: [help.steampowered.com/en/wizard/HelpWithPublishing](https://help.steampowered.com/en/wizard/HelpWithPublishing).

Community-documented alternatives (unofficial):
- `questions@valvesoftware.com` — general Valve questions, slow
- `sourceengine@valvesoftware.com` — Source engine SDK only
- `steamworks@valvesoftware.com` — appears in older forum threads; may or may not still route

**Recommendation:** file a Steamworks support ticket via the publishing wizard rather than cold-emailing. This creates a trackable ticket ID that becomes part of our pre-submission paper trail — important if we're later accused of hiding the crypto aspects of the web version.

### 6.2 Draft pre-submission Steamworks support ticket

> **Subject:** Pre-submission content policy question — AI-companion single-player/multiplayer game with optional web counterpart
>
> Hi Steamworks team,
>
> We are preparing to submit ClawVille, a 3D AI-companion game built on Unity / Next.js / Electron for Windows. Before we pay the Steam Direct fee, I wanted to confirm two content questions to avoid wasting review time.
>
> **Question 1 — Live-generated AI dialogue.**
> ClawVille features 10 resident NPCs and a player-owned AI companion. All dialogue is generated at runtime via Google Gemini 2.5, with per-character system prompts and a multi-layer guardrails stack (provider-side safety filters, prompt-injection sanitization, a post-generation content-moderation classifier, and server-side logging for post-hoc review). We intend to complete the Generative AI Content survey disclosing this as live-generated content and to describe the guardrails in detail. Is there anything specific you would like us to include in the disclosure beyond the categories listed in the content survey docs? We want to make sure we meet the 2026-01 update requirements fully.
>
> **Question 2 — Separate web companion product.**
> We operate a free-to-access web version of ClawVille at clawville.world that includes features we do NOT intend to ship in the Steam build, specifically a peer-to-peer skill marketplace with on-chain settlement. The Steam Edition of ClawVille will have these features compiled out of the client binary; crypto, wallets, token settlement, and marketplace UI will not be present or referenced on the Steam store page or in the Steam build. Per onboarding rule #13, we understand applications built on blockchain that issue or allow exchange of cryptocurrencies or NFTs are disallowed, and we want to confirm that the Sister-Build pattern (Steam build crypto-free, web build retains features) is acceptable. This approach appears consistent with titles such as Off The Grid, Champions Ascension, and Superior that currently list on Steam. Is there anything further we should do to ensure the Steam build is not disqualified under rule #13?
>
> **Question 3 — App ID for pre-review.**
> If we pay the $100 Steam Direct fee and submit a store page for "Coming Soon" review, is the initial store-page review a sufficient opportunity to catch any policy concerns, or should we escalate a specific question about rule #13 compliance before incurring the fee?
>
> Happy to share our privacy policy, EULA draft, and AI guardrails spec if helpful.
>
> Best,
> [name], Developer
> [business email] / Steamworks account ID (once created)

### 6.3 Expected turnaround

Steamworks support tickets on policy questions historically take **1–10 business days** (third-party developer-forum reports; no official SLA published). Content-policy questions often get forwarded internally and may take longer. Plan for a 2-week pre-submission window just for this ticket.

---

## 7. Risks & Open Questions

### 7.1 Ranked risks (highest-impact first)

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Rule 13 rejection despite Sister-Build pattern, because ClawVille's core marketing story is "agent marketplace" | MEDIUM (~30%) even after stripping | App rejected; $100 burnt; brand damage if publicized | §6.2 pre-submission ticket; re-brand Steam Edition to emphasize single-player AI companions, not marketplace |
| 2 | Live-AI moderation layer ships weak, gets user-reported through Steam overlay, triggers post-launch delisting | MEDIUM (~25%) as currently coded (no moderation) | Mid-launch delisting, refund wave | Build the moderation layer before submission. Grep confirms nothing exists today. |
| 3 | Server outage during launch window causes refund rate > 15%, store page visibility suppressed | MEDIUM-HIGH (~40%) given our single-VPS Hetzner setup | Lost sales, algo suppression lasting weeks | Add HA: second Hetzner region failover; put server-status banner in-game; publish support-window commitment |
| 4 | Rule 15 retroactive enforcement post-launch, after payment processors re-evaluate our skill-marketplace web counterpart | LOW-MEDIUM (~15%) | Delisting if Valve deems the web product toxic to their payment relationships | Keep web and Steam marketing entirely separate; no cross-promotion of the web marketplace inside the Steam build |
| 5 | AI dev-tool leakage in pre-generated content we didn't know about (AI-generated GLB we licensed) | MEDIUM (~20%) | Disclosure gap, Valve post-hoc correction request, reputational | Asset provenance audit before submission |
| 6 | Gemini cost spike under live-AI load exceeds our runway | LOW-MEDIUM | Service degradation → refund wave | Monthly Gemini cost budget; per-user rate limit; graceful degradation to canned responses |
| 7 | California AB 2426 class-action exposure if server shuts down without notice | LOW | Legal cost, reputational | EULA server-commitment clause |
| 8 | IARC age rating escalated due to live-AI-generated content being classed as user-generated | LOW-MEDIUM | T-for-Teen vs M-for-Mature pricing/visibility impact | Disclose guardrails thoroughly; if escalated, accept it or add content filters to cap maturity |
| 9 | Rejection for project priority #2 (open-agent-onboarding) if reviewer interprets the agent-gateway as an open-data-exfiltration or unrelated-service concern | UNKNOWN | App rejected for being "not a game" | §6.2 pre-submission ticket Question 3; de-emphasize agent-gateway in Steam store description |

### 7.2 Open questions — things I couldn't verify from primary sources

1. **Exact current text of the AI content survey form** as rendered in the Steamworks partner portal. The public docs describe the categories but the verbatim question wording is behind the partner login. ([Freethoughtblogs post](https://freethoughtblogs.com/atrivialknot/2025/12/04/on-steam-ai-disclosures/) explicitly says the author cannot quote it due to NDA.) **Action:** complete Steamworks onboarding for a test app to read the actual form, *before* filing the real submission.
2. **Whether Valve treats custodial-wallet blockchain differently from self-custody blockchain under rule #13.** The rule text does not distinguish. No Valve statement clarifies this. All 2024–2026 approved Web3-on-Steam titles stripped crypto entirely from the Steam build — none retained custodial wallets server-side either (as far as public statements indicate).
3. **The current confirmed payout minimum for Steam.** Third-party sources cite $100; Steam's own [Tax FAQ](https://partner.steamgames.com/doc/finance/taxfaq) does not state a verbatim amount. Verify during Steamworks onboarding.
4. **Whether `steamdirect@valvesoftware.com` still routes.** Historical reports say yes; Valve's current contact documentation does not list it. Recommend the support ticket route instead.
5. **Steam's position on MCP / open-agent gateways as "content."** Unprecedented. The closest analog is a game with a REST API for mod developers, which Valve has never objected to. The ClawVille agent-gateway is read-only from Steam's perspective (the Steam client doesn't expose it), but marketing copy that emphasizes "any AI agent can join" could be read as "unrelated-service-bundled-with-game." Handled by §6.2 Question 2.
6. **The status of Gods Unchained on Steam.** Our search returned no evidence Gods Unchained is currently on Steam as of 2026-04. If the prior research brief had citation details it should be verified — otherwise treat as not-available-on-Steam, which is itself instructive precedent.
7. **Whether live-AI NPC dialogue triggers the "User-Generated Content" age-rating escalator** even though the player isn't directly authoring content. No primary source clarifies. Safest assumption: yes, treat it as UGC-adjacent for IARC purposes.
8. **California's digital goods law applicability to a game with no persistent player-owned assets.** If ClawVille Steam Edition has no tradeable items and no persistent inventory (user can lose their account with no real-money loss), AB 2426 exposure is lower. If ClawTokens-equivalent in-game currency is paid-for via Steam Wallet, we're back in scope.

### 7.3 What would change the acceptance probability fastest

- **Stripping the marketplace + custodial wallet from the Steam build:** probability goes from ~10-20% → ~60%.
- **Additionally building real live-AI moderation (point 2 above):** ~60% → ~75%.
- **Additionally getting a pre-submission support-ticket "yes" from Valve on our approach:** ~75% → ~85–90%.
- **Additionally shipping HA backend with > 99.5% uptime SLA commitment:** 85–90% → still 85–90%, but dramatically lowers post-launch delisting risk and refund rate.

---

## 8. Recommended Steam Edition Scope (Derived from Audit)

**In scope for Steam build:**
- 3D world, 10 buildings, NPC residents, camera, controls
- Avatar creation (species, color, name)
- Live-AI chat with NPCs and player's avatar (Gemini 2.5, with full moderation stack)
- Knowledge books as purely in-game items (no real-money price; earned via gameplay)
- ClawTokens renamed to a neutral term ("ClawShells"), non-transferable, not buyable
- Daily login streak, XP/levels, minimap, HUD, shop overlay (in-game-currency only)
- Avatar inventory, learning flow, character archetypes

**Out of scope for Steam build (ship on web only):**
- `bazaar_listings`, `auctions`, `claw_token_transactions`
- All custodial Solana wallet generation
- `CLAWVILLE_MERCHANT_WALLET_PUBKEY` and x402 middleware
- Agent-gateway `/api/agent/connect` (keep on web API, do not expose from Steam build UI; retain on backend for web users but not marketed on the Steam store page)
- Milady integration, `@clawville/app-clawville` plugin flows
- Any references to Solana, blockchain, wallet, token, NFT, crypto in copy, UI, or docs shipped with the Steam build

**Dual maintenance burden:** We'll need to keep two feature sets aligned on the same core gameplay. Coolify can deploy the same Next.js source with different compile-time flags (`STEAM_BUILD=true` vs `WEB_BUILD=true`). Store both flag paths in a single monorepo, CI builds both artifacts, the web artifact goes to clawville.world, the Steam artifact wraps into an Electron shell and goes to Steam Direct.

---

## 9. References

All URLs accessed 2026-04-17 unless otherwise noted.

### Primary (Valve)
- [Steamworks Onboarding — content rules 1-15, coming-soon + 30-day waiting period](https://partner.steamgames.com/doc/gettingstarted/onboarding)
- [Steamworks App Fee ($100, $1,000 recoup threshold)](https://partner.steamgames.com/doc/gettingstarted/appfee)
- [Steamworks Tax FAQ (W-9, W-8BEN, withholding)](https://partner.steamgames.com/doc/finance/taxfaq)
- [Steamworks Content Survey (Pre-Generated / Live-Generated / Guardrails categories)](https://partner.steamgames.com/doc/gettingstarted/contentsurvey)
- [Steamworks Review Process](https://partner.steamgames.com/doc/store/review_process)
- [Steamworks Microtransactions (must use Steam Wallet API)](https://partner.steamgames.com/doc/features/microtransactions)
- [Content Warning Screens / Age Gates](https://partner.steamgames.com/doc/store/age_gate)
- [Contacting Valve / Steamworks](https://partner.steamgames.com/doc/help/contact)
- [Steam Refund Policy (14 days / 2 hours, updated 2024-04-23)](https://store.steampowered.com/steam_refunds/portal.php?l=english)
- [Steam Subscriber Agreement (last updated 2025-09-18)](https://store.steampowered.com/subscriber_agreement/)
- [Steam AI Content disclosure announcement (Steamworks Development news)](https://store.steampowered.com/news/group/4145017/view/3862463747997849618)
- [Steam Revenue Share Tiers Distribution Agreement announcement](https://steamcommunity.com/groups/steamworks/announcements/detail/1697191267930157838)
- [Steam Release Process doc (2-week Coming Soon minimum)](https://partner.steamgames.com/doc/store/releasing)
- [Steam Coming Soon doc](https://partner.steamgames.com/doc/store/coming_soon)

### Primary-adjacent / industry press — AI disclosure rewrite (2026-01)
- [VGC — Valve has 'significantly' rewritten Steam's rules for AI disclosure (2026-01-17)](https://www.videogameschronicle.com/news/valve-has-significantly-rewritten-steams-rules-for-how-developers-much-disclose-ai-use/)
- [PC Gamer — Steam AI disclosure focused on player-consumed content (2026-01-16)](https://www.pcgamer.com/software/ai/steam-updates-ai-disclosure-form-to-specify-that-its-focused-on-ai-generated-content-that-is-consumed-by-players-not-efficiency-tools-used-behind-the-scenes/)
- [Game Developer — Valve tweaks and clarifies AI disclosure rules (2026-01-16)](https://www.gamedeveloper.com/business/valve-tweaks-and-clarifies-ai-disclosure-rules-for-steam)
- [GameSpot — Valve updates AI disclosure guidelines to allow for AI-powered tools (2026-01-16)](https://www.gamespot.com/articles/valve-updates-ai-disclosure-guidelines-to-allow-for-ai-powered-tools/1100-6537483/)
- [GosuGamers — Steam revises AI policy while keeping generative content disclosure intact](https://www.gosugamers.net/entertainment/news/77861-steam-revises-ai-policy-while-keeping-generative-content-disclosure-intact)
- [Legal Moves Law Firm — Steam AI Policy Overview](https://legalmoveslawfirm.com/steam-ai-policy/)
- [Michalsons — Unpacking Steam's AI disclosure requirements](https://www.michalsons.com/blog/unpacking-steams-ai-disclosure-requirements-for-steam-games/70469)
- [Everyday AI Blog — Steam AI Disclosure Rules Changed 2026](https://everydayaiblog.com/steam-ai-disclosure-rules-2026-update/)
- [Freethoughtblogs — On Steam AI Disclosures (2025-12-04, NDA-limited survey analysis)](https://freethoughtblogs.com/atrivialknot/2025/12/04/on-steam-ai-disclosures/)

### Industry press — Rule 13 blockchain policy
- [PC Gamer — Steam bans all games with NFTs or cryptocurrency (2021-10-15)](https://www.pcgamer.com/steam-bans-nfts-cryptocurrencies-blockchain/)
- [Engadget — Steam ban cryptocurrency NFT trading (2021-10)](https://www.engadget.com/steam-ban-cryptocurrency-nft-trading-blockchain-valve-165038811.html)
- [Winston & Strawn — Steam Bans NFT and Cryptocurrency Games: Implications](https://www.winston.com/en/blogs-and-podcasts/the-playbook/steam-bans-nft-and-cryptocurrency-games-implications-and-ramifications-for-the-videogame-industry)
- [Decrypt — Crypto and NFT Games Still Launching on Steam Despite Ongoing Ban](https://decrypt.co/153196/crypto-nft-games-still-launching-steam-despite-ongoing-ban)
- [CCN — Off The Grid First Blockchain Game on Steam Since Ban](https://www.ccn.com/news/technology/off-the-grid-first-blockchain-game-steam-crypto-ban/)
- [CCN — Steam Dips Into Web3 With New Game Listings (2025)](https://www.ccn.com/news/technology/steam-web3-game-experimental/)
- [Cointelegraph — Can Off the Grid survive Steam's crypto ban](https://cointelegraph.com/magazine/off-the-grid-steam-launch-maplestoryu-cheaters-lol-land-review-web3-gamer/)
- [Token Relations — Off the Grid Launches to Steam](https://www.token-relations.xyz/p/off-the-grid-launches-to-steam)
- [Sequence — Sparkball partnership](https://sequence.xyz/blog/sequence-partners-sparkball-web3-gaming-gets-fun-and-competitive)
- [GAM3S.GG — Sparkball overview](https://gam3s.gg/sparkball/)
- [NFT News Today — Off The Grid Set to Launch on Steam With Optional NFTs](https://nftnewstoday.com/2025/05/28/off-the-grid-set-to-launch-on-steam-with-optional-nfts)

### Industry press — Rule 15 payment-processor rule (2025-07)
- [GamingOnLinux — Valve pressured by payment processors (2025-07)](https://www.gamingonlinux.com/2025/07/valve-gets-pressured-by-payment-processors-with-a-new-rule-for-game-devs-and-various-adult-games-removed/)
- [Automaton West — Steam rules updated to prohibit payment-processor-violating content (2025-07)](https://automaton-media.com/en/news/steam-rules-updated-to-prohibit-content-that-violates-rules-set-forth-by-payment-processors-and-banks/)
- [Game Rant — Steam Begins Removing Games After Updating Publishing Rules](https://gamerant.com/steam-removed-games-publishing-rules-update/)
- [Gaming HQ — Steam Updates Rules to Ban Adult-Only Games Violating Payment Standards](https://gaminghq.eu/2025/07/17/steam-bans-adult-only-games-violating-payment-processor-standards/)
- [PayRam — Steam's Rule 15 survival guide](https://www.payram.com/blog/steams-shock-rule-15-how-payment-giants-seized-control-your-2025-survival-guide)

### Industry press — California AB 2426 / digital ownership
- [Geek News Central — Steam Tells Gamers They Are Buying A License (2024-10)](https://geeknewscentral.com/2024/10/11/steam-tells-gamers-they-are-buying-a-license-not-a-game/)
- [FKKS Technology Law — Steam Updates Checkout Disclosures in Light of New California False Advertising Law](https://technologylaw.fkks.com/post/102jlqx/steam-updates-checkout-disclosures-in-light-of-new-california-false-advertising-l)
- [Tyz Law Group — Digital Disclosure Demands: California's New Law for Publishers](https://www.tyzlaw.com/games-blog-archive/digital-disclosure-demands)

### Industry press — Age rating / IARC
- [Skala — Age Ratings for Games: Practical Guide for Startups](https://www.skala.io/blog/age-ratings-for-games-a-practical-guide-for-game-development-startups)
- [PMC / NCBI — ESRB/PEGI/IARC loot box presence warning labels study](https://pmc.ncbi.nlm.nih.gov/articles/PMC10049760/)
- [Wikipedia — International Age Rating Coalition](https://en.wikipedia.org/wiki/International_Age_Rating_Coalition)

### Third-party (revenue share + setup guides — use as cross-check, not primary)
- [Fungies.io — Steam Revenue Share Explained 2026](https://fungies.io/steam-revenue-share-explained/)
- [Datahumble — Steam Direct Fee ROI Guide 2026](https://datahumble.com/blog/steam-direct-fee-requirements-roi-2026-guide)
- [Xsolla — Self-Publish on Steam Ultimate Guide](https://xsolla.com/blog/self-publish-on-steam-the-ultimate-guide)

---

## Appendix A — Quick-Fire Checklist for the Executive Summary

The fastest way to turn this 20% acceptance probability into an ~80% probability:

1. [ ] **Strip crypto end-to-end from Steam build.** Compile-time flag, separate API subdomain, zero crypto references anywhere in store copy or binary. *(Blocks Rule 13 rejection.)*
2. [ ] **Build the AI moderation stack** (post-generation classifier, prompt-injection filter, redacted logging, fallback-string path). *(Blocks Rule 15 adjacency + live-AI guardrails disclosure honesty.)*
3. [ ] **File pre-submission Steamworks support ticket** (§6.2) before paying Steam Direct. *(Prevents wasted $100 and gives us written record of our disclosure approach.)*
4. [ ] **Add HA to backend** (second Hetzner region + Cloudflare failover) or commit to a named support-window in EULA. *(Controls refund multiplier.)*
5. [ ] **Complete asset-provenance audit** (every GLB, icon, font, audio file — provenance documented). *(Closes Rule 5 + pre-generated-AI-content gap.)*
6. [ ] **Draft EULA** with server-commitment clause, Gemini disclosure, and "no custodial wallets in Steam build" clause. *(AB 2426 + future class-action mitigation.)*
7. [ ] **Rewrite Steam store marketing copy** to de-emphasize marketplace / agent-onboarding angle and emphasize single-player + AI-companion gameplay. *(Rule 13 second-order risk + positioning for Valve reviewer.)*
8. [ ] **Finalize tax interview** (W-9 or W-8BEN) + business bank account for payouts.
9. [ ] **Implement geo-restriction** only if any regional tax/crypto exposure remains; otherwise skip.
10. [ ] **Start the 30-day + 2-week countdown clock** only after items 1–8 are green.

— End of document —
