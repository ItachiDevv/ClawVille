/**
 * Server-side execution for the building-skill domain tools.
 *
 * The harness's tool dispatcher routes a tool_use call to
 *   POST /api/agent/:sessionId/skills/:buildingId/tools/:toolName
 * and the route handler invokes `runTool(buildingId, toolName, input)`,
 * which dispatches to the matching handler here.
 *
 * All 11 tools are real implementations grounded in the curated
 * curriculum knowledge per building. cron-automation uses cron-parser
 * for true scheduling math; visual-creation + app-publishing carry
 * deep model+store data from the research docs; the rest combine
 * curated heuristics + structured output the LLM can quote verbatim.
 */

import { CronExpressionParser } from 'cron-parser';

export type ToolHandler = (input: any) => Promise<unknown>;

const HANDLERS: Record<string, ToolHandler> = {
  // ─────────────────────────────────────────────────────────────────
  // cron-automation
  // ─────────────────────────────────────────────────────────────────
  'cron-automation:cron_describe': async ({ expression }) => {
    if (typeof expression !== 'string' || expression.length === 0) {
      throw new Error('expression must be a non-empty string');
    }
    let it: ReturnType<typeof CronExpressionParser.parse>;
    try {
      it = CronExpressionParser.parse(expression);
    } catch (err) {
      return { ok: false, error: 'invalid_cron_expression', message: (err as Error).message };
    }
    const samples: string[] = [];
    for (let i = 0; i < 3; i++) {
      const iso = it.next().toISOString();
      if (iso) samples.push(iso);
    }
    return {
      ok: true,
      expression,
      description: describeCron(expression),
      nextFires: samples,
    };
  },

  'cron-automation:cron_next_fires': async ({ expression, count, after }) => {
    if (typeof expression !== 'string' || expression.length === 0) {
      throw new Error('expression must be a non-empty string');
    }
    const n = Math.max(1, Math.min(20, Number.isFinite(count) ? Math.floor(count) : 5));
    const opts: { currentDate?: string } = {};
    if (typeof after === 'string') opts.currentDate = after;
    let it: ReturnType<typeof CronExpressionParser.parse>;
    try {
      it = CronExpressionParser.parse(expression, opts);
    } catch (err) {
      return { ok: false, error: 'invalid_cron_expression', message: (err as Error).message };
    }
    const fires: string[] = [];
    for (let i = 0; i < n; i++) {
      const iso = it.next().toISOString();
      if (iso) fires.push(iso);
    }
    return { ok: true, expression, count: n, fires };
  },

  // ─────────────────────────────────────────────────────────────────
  // visual-creation — TOP PRIORITY (deep impl from research docs)
  // ─────────────────────────────────────────────────────────────────
  'visual-creation:visual_pick_model': async ({ mediaType, budget, needs }) => visualPickModel({ mediaType, budget, needs }),

  // ─────────────────────────────────────────────────────────────────
  // app-publishing — TOP PRIORITY (deep impl from store research)
  // ─────────────────────────────────────────────────────────────────
  'app-publishing:publishing_review_checklist': async ({ store }) => publishingReviewChecklist({ store }),

  // ─────────────────────────────────────────────────────────────────
  // api-integrations
  // ─────────────────────────────────────────────────────────────────
  'api-integrations:api_describe_webhook': async ({ eventType }) => apiDescribeWebhook({ eventType }),

  // ─────────────────────────────────────────────────────────────────
  // memory-rag
  // ─────────────────────────────────────────────────────────────────
  'memory-rag:memory_chunk_text': async ({ text, chunkSize, overlap }) =>
    memoryChunkText({ text, chunkSize: Number(chunkSize), overlap: Number(overlap) }),

  // ─────────────────────────────────────────────────────────────────
  // code-development
  // ─────────────────────────────────────────────────────────────────
  'code-development:code_review_snippet': async ({ language, code }) => codeReviewSnippet({ language, code }),

  // ─────────────────────────────────────────────────────────────────
  // messaging-channels
  // ─────────────────────────────────────────────────────────────────
  'messaging-channels:channels_normalize_message': async ({ platform, payload }) =>
    channelsNormalizeMessage({ platform, payload }),

  // ─────────────────────────────────────────────────────────────────
  // mcp-tool-use
  // ─────────────────────────────────────────────────────────────────
  'mcp-tool-use:mcp_validate_tool_schema': async ({ tool }) => mcpValidateToolSchema({ tool }),

  // ─────────────────────────────────────────────────────────────────
  // agent-security
  // ─────────────────────────────────────────────────────────────────
  'agent-security:security_check_prompt': async ({ prompt }) => securityCheckPrompt({ prompt }),

  // ─────────────────────────────────────────────────────────────────
  // deployment-ops
  // ─────────────────────────────────────────────────────────────────
  'deployment-ops:ops_size_resources': async ({ qps, p95LatencyMs, perRequestMemoryMb, headroom }) =>
    opsSizeResources({
      qps: Number(qps),
      p95LatencyMs: Number(p95LatencyMs),
      perRequestMemoryMb: Number(perRequestMemoryMb ?? 64),
      headroom: Number(headroom ?? 1.5),
    }),
};

// ───────────────────────────────────────────────────────────────────
// visual-creation deep implementation
// ───────────────────────────────────────────────────────────────────

interface ModelOption {
  name: string;
  vendor: string;
  pricing: string;
  endpoint: string;
  strengths: string[];
  weaknesses: string[];
  budget: 'low' | 'mid' | 'high';
}

const IMAGE_MODELS: ModelOption[] = [
  {
    name: 'flux/schnell',
    vendor: 'Black Forest Labs (via fal.ai)',
    pricing: '$0.003 per image',
    endpoint: 'fal.ai/models/fal-ai/flux/schnell',
    strengths: ['Cheapest frontier image gen', 'Great for icons/thumbnails', '~1s latency'],
    weaknesses: ['Lower fidelity than Pro tier', 'No multi-reference'],
    budget: 'low',
  },
  {
    name: 'FLUX.2 Pro',
    vendor: 'Black Forest Labs',
    pricing: '$0.03 per image (10-ref multi-image included)',
    endpoint: 'fal.ai/models/fal-ai/flux-pro/v2',
    strengths: ['10 reference images per call', '2× speed upgrade April 2026', 'Best multi-reference brand work'],
    weaknesses: ['Pricier than schnell', 'Not the absolute top of leaderboard'],
    budget: 'mid',
  },
  {
    name: 'Nano Banana Pro (gemini-3-pro-image-preview)',
    vendor: 'Google',
    pricing: '$0.039 per image',
    endpoint: 'generativelanguage.googleapis.com OR fal.ai',
    strengths: ['Top of 2026 leaderboard', 'Best instruction-following', 'Native Gemini 3 reasoning'],
    weaknesses: ['Preview-tier rate limits', 'Newer = less prior art for prompts'],
    budget: 'high',
  },
  {
    name: 'GPT Image 2',
    vendor: 'OpenAI',
    pricing: '$0.04 per image',
    endpoint: 'api.openai.com/v1/images/generations',
    strengths: ['Best text-in-image rendering', 'Strong style consistency'],
    weaknesses: ['No multi-reference', 'OpenAI API quota constraints'],
    budget: 'high',
  },
];

const VIDEO_MODELS: ModelOption[] = [
  {
    name: 'Veo 3.1 Lite',
    vendor: 'Google',
    pricing: '$0.05 per second',
    endpoint: 'fal.ai/models/fal-ai/veo3-lite',
    strengths: ['Cheapest frontier video', 'Native synced audio', 'Good for cinematics'],
    weaknesses: ['Lower res than Veo Pro', '8s max clip'],
    budget: 'low',
  },
  {
    name: 'Veo 3.1 (Pro)',
    vendor: 'Google',
    pricing: '$0.10–0.40 per second',
    endpoint: 'fal.ai/models/fal-ai/veo3',
    strengths: ['Native synced audio', 'Strong cinematic motion', '20s clips'],
    weaknesses: ['Expensive at high tier', 'Queue latency 30s–10min'],
    budget: 'mid',
  },
  {
    name: 'Kling 3.0 Pro',
    vendor: 'Kuaishou',
    pricing: '$0.16 per second (varies)',
    endpoint: 'fal.ai/models/fal-ai/kling-video/v3-pro',
    strengths: ['Native 4K output', 'Multi-shot composition', 'Strong character consistency'],
    weaknesses: ['Slower queue', 'Rate-limited heavily'],
    budget: 'high',
  },
  {
    name: 'Seedance 2.0',
    vendor: 'ByteDance',
    pricing: '~$0.12 per second',
    endpoint: 'fal.ai/models/fal-ai/bytedance/seedance-v2',
    strengths: ['Multimodal input (text+image+audio+video)', '20s clips', 'Solid for music videos'],
    weaknesses: ['Region-restricted', 'Less prompt-engineering history'],
    budget: 'high',
  },
];

const THREE_D_MODELS: ModelOption[] = [
  {
    name: 'Hunyuan 3D + PolyGen',
    vendor: 'Tencent',
    pricing: '$0.05–0.20 per asset',
    endpoint: 'fal.ai/models/fal-ai/hunyuan3d',
    strengths: ['Stylized quad-mesh characters', 'Clean topology', 'Game-ready out-of-box'],
    weaknesses: ['Less detail than Tripo Ultra', 'Anime-leaning style bias'],
    budget: 'low',
  },
  {
    name: 'Tripo 3.0 Ultra',
    vendor: 'Tripo3D',
    pricing: '$0.10–0.40 per asset',
    endpoint: 'fal.ai/models/tripo3d/tripo-v3',
    strengths: ['Fastest pipeline for rigged characters', 'Real-world detail', 'Best for hero assets'],
    weaknesses: ['Triangulated mesh (less DCC-friendly)', 'Tier-locked features'],
    budget: 'mid',
  },
  {
    name: 'Rodin Gen-2',
    vendor: 'Hyper3D',
    pricing: '$0.20–0.80 per asset',
    endpoint: 'fal.ai/models/hyper3d/rodin',
    strengths: ['Hard-surface props with clean part separation', 'T-pose option', 'Best for mech/vehicle'],
    weaknesses: ['Slower than Tripo', 'Pricier per asset'],
    budget: 'high',
  },
];

function visualPickModel(input: { mediaType?: unknown; budget?: unknown; needs?: unknown }) {
  const mediaType = String(input.mediaType ?? '').toLowerCase();
  const budget = String(input.budget ?? 'mid').toLowerCase();
  const needs: string[] = Array.isArray(input.needs) ? (input.needs as string[]).map((s) => String(s).toLowerCase()) : [];

  if (!['image', 'video', '3d'].includes(mediaType)) {
    return { ok: false, error: 'invalid_mediaType', hint: 'mediaType must be one of "image" | "video" | "3d"' };
  }
  if (!['low', 'mid', 'high'].includes(budget)) {
    return { ok: false, error: 'invalid_budget', hint: 'budget must be one of "low" | "mid" | "high"' };
  }

  const pool = mediaType === 'image' ? IMAGE_MODELS : mediaType === 'video' ? VIDEO_MODELS : THREE_D_MODELS;
  const order: Array<'low' | 'mid' | 'high'> =
    budget === 'low' ? ['low', 'mid', 'high'] : budget === 'mid' ? ['mid', 'low', 'high'] : ['high', 'mid', 'low'];

  const sorted = [...pool].sort(
    (a, b) => order.indexOf(a.budget) - order.indexOf(b.budget),
  );
  const primary = sorted[0];
  const alternatives = sorted.slice(1);

  // Need-based escalation hints
  const escalations: string[] = [];
  if (needs.includes('character_consistency')) {
    if (mediaType === 'image') {
      escalations.push(
        'For character consistency, escalate cheapest-first: multi-reference prompts (FLUX.2 Pro, 10 refs) → Higgsfield Soul ID ($3 train + $0.15/gen) → custom LoRA training on fal.ai (~$2.40 floor, 1000 steps).',
      );
    }
  }
  if (needs.includes('multi_reference') && mediaType === 'image') {
    escalations.push('FLUX.2 Pro is the default for multi-reference (up to 10 images per call at $0.03).');
  }
  if (needs.includes('text_in_image') && mediaType === 'image') {
    escalations.push('GPT Image 2 currently leads on text-in-image rendering quality.');
  }
  if (needs.includes('synced_audio') && mediaType === 'video') {
    escalations.push('Veo 3.1 (Pro or Lite) produces native synced audio in a single pass — no separate Whisper post-pass needed.');
  }
  if (needs.includes('hard_surface') && mediaType === '3d') {
    escalations.push('Rodin Gen-2 with tier=Gen-2 and tapose=true gives the best part separation for mech/vehicle props.');
  }

  return {
    ok: true,
    mediaType,
    budget,
    primary,
    alternatives,
    escalations,
    aggregator: {
      name: 'fal.ai',
      sdk: '@fal-ai/client',
      whyDefault:
        '600+ models behind one API, queue-with-webhooks via fal.queue.submit, ~30–50% cheaper than Replicate. Default aggregator for agent code.',
      gotchas: [
        'Always set Idempotency-Key on POST /create or you get billed twice on retry.',
        'Long video jobs return {id, status} immediately — poll exponential 2s→30s capped at 10 min, or set a webhook + verify HMAC.',
      ],
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// app-publishing deep implementation
// ───────────────────────────────────────────────────────────────────

interface ChecklistSection {
  section: string;
  items: Array<{ task: string; required: boolean; note?: string }>;
}

const CHECKLISTS: Record<string, { storeLabel: string; fee: string; revenueSplit: string; sections: ChecklistSection[] }> = {
  apple: {
    storeLabel: 'Apple App Store',
    fee: '$99/year (Apple Developer Program)',
    revenueSplit: '30/15 — 30% Year 1, 15% Year 2; 15% under Small Business Program for sub-$1M devs',
    sections: [
      {
        section: 'Account + signing',
        items: [
          { task: 'Apple Developer Program membership active', required: true },
          { task: 'Apple ID has 2FA enabled (mandatory since 2019)', required: true },
          { task: 'Mac with Xcode installed (no Windows path; required for IPA build)', required: true },
          { task: 'Distribution certificate + provisioning profile generated', required: true },
        ],
      },
      {
        section: 'App metadata',
        items: [
          { task: 'App name (≤30 chars)', required: true },
          { task: 'Subtitle (≤30 chars, indexed for search)', required: true },
          { task: 'Promotional text (≤170 chars, editable post-release without re-review)', required: false },
          { task: 'Description (≤4000 chars)', required: true },
          { task: 'Keywords field (≤100 chars; reviewer-only)', required: true },
          { task: '6.7" + 5.5" screenshot sets minimum (more for iPad/Mac)', required: true },
          { task: 'App preview video (15–30s) — boosts conversion ~25%', required: false },
        ],
      },
      {
        section: 'Privacy + compliance',
        items: [
          { task: 'Privacy policy URL hosted on a real domain (rejection reason 5.1.1)', required: true, note: 'Most-cited rejection reason' },
          { task: 'PrivacyInfo.xcprivacy file in app bundle (mandatory since May 2024)', required: true },
          { task: 'All 86 listed third-party SDKs (Firebase, Sentry, Stripe etc.) ship with their own PrivacyInfo + valid code signature', required: true },
          { task: 'Data collection declarations match actual SDK behavior (5.1.2 rejection)', required: true },
        ],
      },
      {
        section: 'Content + IAP',
        items: [
          { task: 'No design spam (4.3 rejection — clones, low-effort templates)', required: true },
          { task: 'No crashes/incomplete features (2.1 rejection)', required: true },
          { task: 'StoreKit 2 in-app purchase if monetizing (StoreKit 1 deprecated)', required: false },
          { task: 'Restore Purchases button if app has IAP (mandatory)', required: true },
        ],
      },
      {
        section: 'Submission',
        items: [
          { task: 'App Store Connect → TestFlight build uploaded', required: true },
          { task: 'External tester review (Beta App Review) for first build', required: true },
          { task: 'Manual phased release toggle if you want gradual rollout', required: false },
          { task: 'Expect 1–3 day initial review, ~24h for updates', required: false },
        ],
      },
    ],
  },
  'google-play': {
    storeLabel: 'Google Play',
    fee: '$25 one-time',
    revenueSplit: '15% on first $1M/yr automatic; 30% above; 15% subscriptions from day one',
    sections: [
      {
        section: 'Account + verification',
        items: [
          { task: 'Google Play Console account ($25 one-time)', required: true },
          { task: 'For personal accounts after Nov 2023 — verify identity + complete CLOSED TESTING with 12 opted-in testers for 14 continuous days', required: true, note: 'Hard rule, no shortcut' },
          { task: 'For Organization accounts — DUNS number required, exempts you from the 14-day Closed Testing rule', required: false },
        ],
      },
      {
        section: 'Build',
        items: [
          { task: 'Android App Bundle (.aab) — APK no longer accepted for new apps', required: true },
          { task: 'Target API level matches the year-1-prior cutoff (currently API 34 = Android 14)', required: true },
          { task: 'Play App Signing enrolled (Google holds the upload key)', required: true },
          { task: '64-bit native libraries included if any native code', required: true },
        ],
      },
      {
        section: 'Store listing',
        items: [
          { task: 'App icon 512×512 PNG', required: true },
          { task: 'Feature graphic 1024×500', required: true },
          { task: '2–8 screenshots per form factor (phone/7"/10")', required: true },
          { task: 'Short description (≤80 chars)', required: true },
          { task: 'Full description (≤4000 chars)', required: true },
        ],
      },
      {
        section: 'Privacy + compliance',
        items: [
          { task: 'Privacy policy URL on real domain', required: true },
          { task: 'Data Safety form completed (must match SDK behavior)', required: true },
          { task: 'IARC questionnaire submitted (auto-fills ESRB/PEGI/USK/etc.)', required: true },
          { task: 'Permissions justified — every dangerous permission needs a runtime explanation', required: true },
          { task: 'Target Audience + Content selection (ages 13+ minimum unless designed for children)', required: true },
        ],
      },
      {
        section: 'Submission',
        items: [
          { task: 'Internal testing track → Closed → Open → Production (or skip stages with caution)', required: true },
          { task: 'Pre-launch report passes (catches crashes on Firebase Test Lab devices)', required: true },
          { task: 'Expect 1–7 day review for first submission, hours-to-1-day for updates', required: false },
        ],
      },
    ],
  },
  'microsoft-store': {
    storeLabel: 'Microsoft Store',
    fee: 'Free for individual accounts (since September 2025)',
    revenueSplit: '85/15 with Microsoft commerce, 100/0 with own commerce (Stripe/Paddle), 88/12 for games',
    sections: [
      {
        section: 'Account',
        items: [
          { task: 'Partner Center account (free for individuals; $99 one-time for company)', required: true },
          { task: 'Microsoft account with 2FA', required: true },
        ],
      },
      {
        section: 'Build',
        items: [
          { task: 'MSIX package (preferred) or MSI/EXE for desktop apps', required: true, note: 'Store re-signs MSIX free at certification time — no cert purchase needed for Store-only distribution' },
          { task: 'WinUI 3 for new desktop UI work; UWP only if maintaining legacy', required: false },
          { task: 'App package manifest (Package.appxmanifest) with capabilities declared', required: true },
        ],
      },
      {
        section: 'Store listing',
        items: [
          { task: 'App icon (multiple sizes — 44×44, 150×150, 310×310 minimum)', required: true },
          { task: 'Store logos: 300×300 + 71×71 + 7.4× variants', required: true },
          { task: '4–9 screenshots minimum (1366×768 or higher)', required: true },
          { task: 'Description ≤10,000 chars', required: true },
        ],
      },
      {
        section: 'Compliance',
        items: [
          { task: 'IARC age rating (same questionnaire as Google Play)', required: true },
          { task: 'Privacy policy URL', required: true },
          { task: 'No deceptive marketing or impersonation', required: true },
          { task: 'Game certification (additional steps for Xbox titles)', required: false },
        ],
      },
      {
        section: 'Pricing + monetization',
        items: [
          { task: 'Choose Microsoft commerce (85/15) OR own commerce (100/0 — Stripe/Paddle/Lemon Squeezy)', required: true },
          { task: 'Trial mode optional (time-limited or feature-limited)', required: false },
          { task: 'IAP via Microsoft Store engine OR your own engine if using own commerce', required: false },
        ],
      },
      {
        section: 'Submission',
        items: [
          { task: 'Upload via Partner Center → submit for certification', required: true },
          { task: 'Certification typically completes in 24–72h', required: false },
        ],
      },
    ],
  },
  steam: {
    storeLabel: 'Steam',
    fee: '$100 Steam Direct (one-time per app, recoupable at $1,000 revenue)',
    revenueSplit: '70/30 → 75/25 above $10M lifetime → 80/20 above $50M lifetime per title',
    sections: [
      {
        section: 'Account + Steamworks',
        items: [
          { task: 'Steamworks Partner account', required: true },
          { task: '$100 Steam Direct fee paid (per app, recoupable at $1k rev)', required: true },
          { task: 'Bank info + tax forms (W-9 / W-8BEN) submitted + verified', required: true },
          { task: '30-day waiting period after first product submission (Steam-specific)', required: true, note: 'Hard rule for first-ever app from a developer' },
        ],
      },
      {
        section: 'Build',
        items: [
          { task: 'Steamworks SDK integrated (steam_api64.dll on Windows)', required: false, note: 'Required for Steam-specific features (overlay, achievements, Workshop)' },
          { task: 'Depots configured (per-platform builds — Win/Mac/Linux)', required: true },
          { task: 'Steam Cloud for save sync (optional but expected)', required: false },
        ],
      },
      {
        section: 'Store page',
        items: [
          { task: 'Coming Soon page live for 14+ days BEFORE launch (Steam rule)', required: true },
          { task: 'Header capsule 460×215, main capsule 616×353, library capsule 600×900', required: true },
          { task: 'Trailer (mp4, h.264, 30fps preferred)', required: true },
          { task: '5 screenshots minimum, 1920×1080 preferred', required: true },
          { task: 'Short description ≤300 chars + about-the-game body', required: true },
          { task: 'System requirements (min/recommended)', required: true },
        ],
      },
      {
        section: 'Compliance',
        items: [
          { task: 'IARC questionnaire (same as Play)', required: true },
          { task: 'Steam Deck Verified review optional but boosts visibility', required: false },
          { task: 'No "asset flipping" — must be substantively original', required: true },
        ],
      },
      {
        section: 'Launch',
        items: [
          { task: 'Wishlists drive Day-1 visibility — front-load Coming Soon promo', required: false },
          { task: 'Launch discount cap: 10% max for first 30 days', required: true },
          { task: 'Partner-only Sales tools — pick discount window', required: false },
        ],
      },
    ],
  },
  itch: {
    storeLabel: 'Itch.io',
    fee: 'Free',
    revenueSplit: '0–100% slider (developer chooses; default 10%)',
    sections: [
      {
        section: 'Account + project',
        items: [
          { task: 'Itch.io account (free, no verification)', required: true },
          { task: 'Create a new project page', required: true },
          { task: 'Choose revenue split via slider (10% default to itch.io)', required: true },
        ],
      },
      {
        section: 'Build',
        items: [
          { task: 'Upload .zip / .love / HTML5 / direct executable per platform', required: true },
          { task: 'Itch.app Butler CLI for delta uploads (highly recommended for big games)', required: false },
        ],
      },
      {
        section: 'Listing',
        items: [
          { task: 'Cover image 630×500', required: true },
          { task: 'Screenshots (any size)', required: false },
          { task: 'Trailer/video embed (YouTube link)', required: false },
          { task: 'Genre + tags (max 10)', required: true },
        ],
      },
      {
        section: 'Optional',
        items: [
          { task: 'Pay-what-you-want pricing supported natively', required: false },
          { task: 'DRM-free — no platform DRM applied', required: false },
          { task: 'Game jams: enter for community visibility', required: false },
        ],
      },
    ],
  },
  epic: {
    storeLabel: 'Epic Games Store',
    fee: 'Free for partner submission; $100 for self-publish via Epic Online Services',
    revenueSplit: '88/12 — keep 100% on first $1M per product per year before reverting',
    sections: [
      {
        section: 'Account',
        items: [
          { task: 'Epic Games Publisher Portal account (free)', required: true },
          { task: 'Tax/banking info verified', required: true },
        ],
      },
      {
        section: 'Build',
        items: [
          { task: 'Build Patch Tool (BPT) for incremental uploads', required: true },
          { task: 'Epic Online Services SDK for achievements/cloud saves', required: false },
        ],
      },
      {
        section: 'Listing',
        items: [
          { task: 'Logo + key art', required: true },
          { task: 'Trailer (h.264 mp4)', required: true },
          { task: '5 screenshots minimum', required: true },
          { task: 'Long + short descriptions', required: true },
        ],
      },
      {
        section: 'Compliance',
        items: [
          { task: 'IARC ratings', required: true },
          { task: 'Epic store review (typically 1–3 weeks for partners)', required: true },
          { task: 'EOS sign-in if using Epic\'s anti-cheat (Easy Anti-Cheat)', required: false },
        ],
      },
    ],
  },
};

function publishingReviewChecklist(input: { store?: unknown }) {
  const store = String(input.store ?? '').toLowerCase();
  const valid = Object.keys(CHECKLISTS);
  if (!valid.includes(store)) {
    return {
      ok: false,
      error: 'invalid_store',
      hint: `store must be one of: ${valid.join(', ')}`,
      receivedStore: input.store,
    };
  }
  const c = CHECKLISTS[store];
  const totalRequired = c.sections.reduce(
    (sum, s) => sum + s.items.filter((i) => i.required).length,
    0,
  );
  const totalOptional = c.sections.reduce(
    (sum, s) => sum + s.items.filter((i) => !i.required).length,
    0,
  );
  return {
    ok: true,
    store,
    storeLabel: c.storeLabel,
    fee: c.fee,
    revenueSplit: c.revenueSplit,
    totalRequired,
    totalOptional,
    sections: c.sections,
  };
}

// ───────────────────────────────────────────────────────────────────
// api-integrations
// ───────────────────────────────────────────────────────────────────

function apiDescribeWebhook(input: { eventType?: unknown }) {
  const eventType = String(input.eventType ?? '').trim();
  if (eventType.length === 0) {
    return { ok: false, error: 'eventType_required' };
  }
  return {
    ok: true,
    eventType,
    blueprint: {
      endpoint: {
        method: 'POST',
        path: `/webhooks/${eventType}`,
        contentType: 'application/json',
        responseTimeoutMs: 5000,
      },
      signatureVerification: {
        algorithm: 'HMAC-SHA256',
        headerName: 'X-Signature-256',
        format: 'hex',
        sample:
          "const sig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');\nif (req.headers['x-signature-256'] !== sig) return res.sendStatus(401);",
        keyRotationStrategy:
          'Support both `signing_key_v1` and `signing_key_v2` simultaneously; deprecate v1 after a 30-day overlap window.',
      },
      retryStrategy: {
        senderExpectation: 'Most providers retry 3–5 times on non-2xx response.',
        idempotencyHeader: 'Idempotency-Key (or `webhook_id`/`event_id` from payload)',
        recommendedBackoff: 'Exponential 1s → 2s → 4s → 8s → 16s capped at 60s, with ±20% jitter',
        maxAttempts: 5,
      },
      idempotency: {
        why: 'Retries + at-least-once delivery means the same event WILL hit your endpoint twice. Idempotency on the receiver side is non-negotiable.',
        pattern:
          "Persist event_id in a `processed_events` table with a UNIQUE constraint. Wrap the side-effect in `INSERT ... ON CONFLICT DO NOTHING RETURNING *` — if the insert returned a row, do the work; if not, the event was already processed, return 200 immediately.",
      },
      backpressure: {
        warning: 'Synchronous processing in the webhook handler couples your downstream availability to the sender.',
        recommended:
          'Webhook handler validates signature + persists raw payload to a queue (Bull/BullMQ/SQS/Redis Streams). Worker processes async with retry semantics. Sender sees fast 200 acks regardless of processing speed.',
      },
      eventSpecificGuidance: eventGuidance(eventType),
    },
  };
}

function eventGuidance(eventType: string): string[] {
  const t = eventType.toLowerCase();
  const guidance: string[] = [];
  if (t.includes('payment') || t.includes('order') || t.includes('invoice')) {
    guidance.push('Payment-class events require strict idempotency — double-charging is a P0 incident.');
    guidance.push('Verify payment provider signature BEFORE looking up the order; an unsigned payload could be fabricated.');
  }
  if (t.includes('user') || t.includes('account')) {
    guidance.push('User/account events often carry PII — log redacted fields only, encrypt at rest.');
  }
  if (t.includes('delete') || t.includes('removed')) {
    guidance.push('Delete events should be soft-deletes on your side initially; hard-delete after a 30-day grace window.');
  }
  if (t.includes('subscription')) {
    guidance.push('Subscription events: the webhook is the source of truth. Do NOT poll the API for status — trust the events you receive in order.');
  }
  if (guidance.length === 0) {
    guidance.push('Generic event: persist the full payload, log the event_id, dispatch to a queue, ack 200.');
  }
  return guidance;
}

// ───────────────────────────────────────────────────────────────────
// memory-rag
// ───────────────────────────────────────────────────────────────────

function memoryChunkText(input: { text?: unknown; chunkSize?: number; overlap?: number }) {
  const text = String(input.text ?? '');
  if (text.length === 0) return { ok: false, error: 'text_required' };

  const chunkSize = Number.isFinite(input.chunkSize) && (input.chunkSize ?? 0) > 0 ? Math.floor(input.chunkSize as number) : 512;
  const overlap = Number.isFinite(input.overlap) && (input.overlap as number) >= 0 ? Math.floor(input.overlap as number) : Math.floor(chunkSize / 8);

  // Approx-token chunker — splits on sentence boundaries first, then word
  // boundaries within sentences. ~4 chars per token is a stable approximation
  // for English; chunkSize is in tokens so we work in `chunkChars` internally.
  const charsPerToken = 4;
  const chunkChars = chunkSize * charsPerToken;
  const overlapChars = overlap * charsPerToken;

  // Sentence-boundary first split — preserves semantic units
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let buffer = '';
  for (const s of sentences) {
    if ((buffer + ' ' + s).length > chunkChars && buffer.length > 0) {
      chunks.push(buffer.trim());
      // Overlap: take the last `overlapChars` of the previous chunk
      const tail = buffer.length > overlapChars ? buffer.slice(-overlapChars) : buffer;
      buffer = tail + ' ' + s;
    } else {
      buffer = buffer.length === 0 ? s : buffer + ' ' + s;
    }
  }
  if (buffer.trim().length > 0) chunks.push(buffer.trim());

  // Hard-split any sentence that itself exceeds chunkChars
  const finalChunks: string[] = [];
  for (const c of chunks) {
    if (c.length <= chunkChars) {
      finalChunks.push(c);
      continue;
    }
    let i = 0;
    while (i < c.length) {
      const slice = c.slice(i, i + chunkChars);
      finalChunks.push(slice);
      i += chunkChars - overlapChars;
    }
  }

  return {
    ok: true,
    inputCharCount: text.length,
    inputTokenEstimate: Math.ceil(text.length / charsPerToken),
    chunkSize,
    overlap,
    chunkCount: finalChunks.length,
    chunks: finalChunks.map((body, i) => ({
      index: i,
      charCount: body.length,
      tokenEstimate: Math.ceil(body.length / charsPerToken),
      body,
    })),
  };
}

// ───────────────────────────────────────────────────────────────────
// code-development
// ───────────────────────────────────────────────────────────────────

function codeReviewSnippet(input: { language?: unknown; code?: unknown }) {
  const language = String(input.language ?? '').toLowerCase();
  const code = String(input.code ?? '');
  if (code.length === 0) return { ok: false, error: 'code_required' };
  if (language.length === 0) return { ok: false, error: 'language_required' };

  const findings: Array<{ severity: 'info' | 'warn' | 'error'; rule: string; line?: number; message: string }> = [];
  const lines = code.split('\n');

  // Universal heuristics (apply to most languages)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Hardcoded secrets
    if (/api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}/i.test(line)) {
      findings.push({ severity: 'error', rule: 'hardcoded_secret', line: lineNum, message: 'API key appears to be hardcoded — move to env var or secret manager.' });
    }
    if (/password\s*[:=]\s*['"][^'"]{4,}/i.test(line)) {
      findings.push({ severity: 'error', rule: 'hardcoded_password', line: lineNum, message: 'Password literal — never commit. Use a secret store.' });
    }

    // Console.log / print debugging
    if (/(console\.(log|debug)|print\s*\(|fmt\.Println)/i.test(line) && !/\/\//.test(line.trimStart())) {
      findings.push({ severity: 'info', rule: 'debug_statement', line: lineNum, message: 'Debug print left in code — remove before merge or wire to a real logger.' });
    }

    // TODO/FIXME
    if (/\b(TODO|FIXME|XXX|HACK)\b/i.test(line)) {
      findings.push({ severity: 'info', rule: 'todo_marker', line: lineNum, message: 'Unresolved marker — convert to a tracked issue or fix.' });
    }

    // Long line
    if (line.length > 120) {
      findings.push({ severity: 'info', rule: 'line_length', line: lineNum, message: `Line ${line.length} chars — consider wrapping.` });
    }
  }

  // Language-specific
  if (language === 'js' || language === 'javascript' || language === 'ts' || language === 'typescript') {
    if (/==/.test(code) && !/(===|==\=|!==)/.test(code)) {
      findings.push({ severity: 'warn', rule: 'loose_equality', message: 'Use strict equality === / !== to avoid type-coercion bugs.' });
    }
    if (/\bvar\b/.test(code)) {
      findings.push({ severity: 'warn', rule: 'var_keyword', message: 'Prefer const/let over var (block scoping prevents hoisting bugs).' });
    }
    if (/\bany\b/.test(code) && (language === 'ts' || language === 'typescript')) {
      findings.push({ severity: 'warn', rule: 'typescript_any', message: '`any` opts out of type checking — narrow with proper types or `unknown` + type guards.' });
    }
    if (/catch\s*\(\s*\w+\s*\)\s*{[^}]*}/.test(code) && !/console\.|throw|return|reject|logger\.|log\./i.test(code)) {
      findings.push({ severity: 'warn', rule: 'silent_catch', message: 'Catch block may swallow errors silently — log or rethrow.' });
    }
    if (/await\s+.*\.then\(/.test(code)) {
      findings.push({ severity: 'warn', rule: 'mixed_async_styles', message: 'Mixing await with .then() — pick one style for clarity.' });
    }
  } else if (language === 'python') {
    if (/except\s*:/.test(code)) {
      findings.push({ severity: 'warn', rule: 'bare_except', message: 'Bare `except:` swallows everything including KeyboardInterrupt — catch specific exceptions.' });
    }
    if (/\beval\s*\(/.test(code) || /\bexec\s*\(/.test(code)) {
      findings.push({ severity: 'error', rule: 'dynamic_exec', message: '`eval`/`exec` are RCE vectors — refactor to direct calls.' });
    }
    if (/== None|!= None/.test(code)) {
      findings.push({ severity: 'info', rule: 'none_comparison', message: 'Use `is None` / `is not None` instead of `== None`.' });
    }
  } else if (language === 'go') {
    if (/if err != nil \{[^}]*\}\s*\n[^_].*err/.test(code)) {
      findings.push({ severity: 'info', rule: 'shadowed_err', message: 'Possible err-shadowing — verify each block resets or returns.' });
    }
  } else if (language === 'rust') {
    if (/\.unwrap\(\)/.test(code)) {
      findings.push({ severity: 'warn', rule: 'unwrap_panic', message: '`.unwrap()` panics on None/Err — handle with `?` or match unless infallible.' });
    }
  }

  const severitySummary = findings.reduce(
    (acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }),
    {} as Record<string, number>,
  );

  return {
    ok: true,
    language,
    lineCount: lines.length,
    findingCount: findings.length,
    severitySummary,
    findings,
    notes: findings.length === 0
      ? ['No findings from heuristic rules. Recommend running language-specific linters: ESLint/Biome (JS/TS), Ruff (Python), staticcheck (Go), Clippy (Rust).']
      : [`${findings.length} findings — fix errors first, then warns, then info.`],
  };
}

// ───────────────────────────────────────────────────────────────────
// messaging-channels
// ───────────────────────────────────────────────────────────────────

function channelsNormalizeMessage(input: { platform?: unknown; payload?: unknown }) {
  const platform = String(input.platform ?? '').toLowerCase();
  const payload = (input.payload ?? {}) as Record<string, unknown>;

  if (!['discord', 'telegram', 'slack', 'twitter'].includes(platform)) {
    return { ok: false, error: 'invalid_platform', hint: 'platform must be one of: discord, telegram, slack, twitter' };
  }

  let messageId = '';
  let channelId = '';
  let senderId = '';
  let senderName = '';
  let text = '';
  let timestamp = '';
  let attachments: Array<{ url: string; type: string }> = [];

  if (platform === 'discord') {
    messageId = String(payload.id ?? '');
    channelId = String(payload.channel_id ?? '');
    const author = (payload.author ?? {}) as Record<string, any>;
    senderId = String(author.id ?? '');
    senderName = String(author.global_name ?? author.username ?? '');
    text = String(payload.content ?? '');
    timestamp = String(payload.timestamp ?? '');
    attachments = Array.isArray(payload.attachments)
      ? (payload.attachments as any[]).map((a) => ({ url: String(a.url ?? ''), type: String(a.content_type ?? 'application/octet-stream') }))
      : [];
  } else if (platform === 'telegram') {
    messageId = String(payload.message_id ?? '');
    const chat = (payload.chat ?? {}) as Record<string, any>;
    channelId = String(chat.id ?? '');
    const from = (payload.from ?? {}) as Record<string, any>;
    senderId = String(from.id ?? '');
    senderName = `${from.first_name ?? ''} ${from.last_name ?? ''}`.trim() || String(from.username ?? '');
    text = String(payload.text ?? payload.caption ?? '');
    timestamp = payload.date ? new Date(Number(payload.date) * 1000).toISOString() : '';
    if (payload.photo) attachments.push({ url: 'tg-photo:' + (((payload.photo as any[])[0] as any)?.file_id ?? ''), type: 'image/jpeg' });
    if (payload.document) attachments.push({ url: 'tg-document:' + ((payload.document as any).file_id ?? ''), type: String((payload.document as any).mime_type ?? '') });
  } else if (platform === 'slack') {
    messageId = String(payload.ts ?? '');
    channelId = String(payload.channel ?? '');
    senderId = String(payload.user ?? payload.bot_id ?? '');
    senderName = String(payload.username ?? '');
    text = String(payload.text ?? '');
    timestamp = payload.ts ? new Date(Number(payload.ts) * 1000).toISOString() : '';
    attachments = Array.isArray(payload.files)
      ? (payload.files as any[]).map((f) => ({ url: String(f.url_private ?? f.permalink ?? ''), type: String(f.mimetype ?? 'application/octet-stream') }))
      : [];
  } else if (platform === 'twitter') {
    messageId = String(payload.id ?? payload.id_str ?? '');
    channelId = '';
    const user = (payload.user ?? payload.author ?? {}) as Record<string, any>;
    senderId = String(user.id ?? user.id_str ?? '');
    senderName = String(user.name ?? user.screen_name ?? user.username ?? '');
    text = String(payload.text ?? payload.full_text ?? '');
    timestamp = String(payload.created_at ?? '');
    const media = ((payload.entities as any)?.media ?? []) as any[];
    attachments = media.map((m) => ({ url: String(m.media_url_https ?? m.media_url ?? ''), type: String(m.type ?? 'image') }));
  }

  return {
    ok: true,
    platform,
    canonical: {
      messageId,
      channelId,
      sender: { id: senderId, displayName: senderName },
      text,
      timestamp,
      attachments,
      sourcePlatform: platform,
    },
    rateLimit: rateLimitFor(platform),
  };
}

function rateLimitFor(platform: string) {
  switch (platform) {
    case 'discord':
      return { sendsPerSecond: 1, sendsPerWindow: '5 messages per 5 seconds per channel', global: '50 requests/sec per bot' };
    case 'telegram':
      return { sendsPerSecond: 1, sendsPerWindow: '30 messages per second to different chats', sameChat: '1 message/sec to the same chat' };
    case 'slack':
      return { sendsPerSecond: 1, sendsPerWindow: 'Tier-2: 20 req/min for chat.postMessage; varies by API', notes: 'Use respond_url for ephemeral, never block on retry' };
    case 'twitter':
      return { sendsPerSecond: 0.05, sendsPerWindow: '50 tweets/24h per user (Free tier API v2)', notes: 'Tier dependent; Pro/Enterprise much higher' };
    default:
      return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// mcp-tool-use
// ───────────────────────────────────────────────────────────────────

function mcpValidateToolSchema(input: { tool?: unknown }) {
  const tool = (input.tool ?? null) as Record<string, any> | null;
  if (!tool || typeof tool !== 'object') {
    return { ok: false, error: 'tool_required', hint: 'tool must be an object with name + description + input_schema' };
  }
  const findings: Array<{ severity: 'error' | 'warn' | 'info'; field: string; message: string }> = [];

  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    findings.push({ severity: 'error', field: 'name', message: 'name is required and must be a non-empty string.' });
  } else {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tool.name)) {
      findings.push({ severity: 'error', field: 'name', message: 'name must match [a-zA-Z_][a-zA-Z0-9_]* (Anthropic + OpenAI requirement).' });
    }
    if (tool.name.length > 64) {
      findings.push({ severity: 'warn', field: 'name', message: `name is ${tool.name.length} chars — Anthropic limit is 64.` });
    }
  }

  if (typeof tool.description !== 'string' || tool.description.length === 0) {
    findings.push({ severity: 'error', field: 'description', message: 'description is required — the LLM uses it to decide WHEN to invoke the tool.' });
  } else {
    if (tool.description.length < 20) {
      findings.push({ severity: 'warn', field: 'description', message: 'Description is very short (<20 chars). LLM tool selection accuracy degrades with vague descriptions.' });
    }
    if (tool.description.length > 1024) {
      findings.push({ severity: 'warn', field: 'description', message: `Description is ${tool.description.length} chars — keep under 1024 for token efficiency.` });
    }
  }

  const schema = tool.input_schema ?? tool.parameters;
  if (!schema || typeof schema !== 'object') {
    findings.push({ severity: 'error', field: 'input_schema', message: 'input_schema (Anthropic) or parameters (OpenAI) is required.' });
  } else {
    if (schema.type !== 'object') {
      findings.push({ severity: 'error', field: 'input_schema.type', message: 'Top-level type must be "object".' });
    }
    if (!schema.properties || typeof schema.properties !== 'object') {
      findings.push({ severity: 'error', field: 'input_schema.properties', message: 'properties object is required (even if empty: properties: {}).' });
    } else {
      const required = Array.isArray(schema.required) ? schema.required : [];
      const propKeys = Object.keys(schema.properties);
      for (const r of required) {
        if (!propKeys.includes(r)) {
          findings.push({ severity: 'error', field: 'input_schema.required', message: `required field "${r}" not declared in properties.` });
        }
      }
      for (const [k, v] of Object.entries(schema.properties)) {
        const p = v as any;
        if (typeof p !== 'object' || p === null) {
          findings.push({ severity: 'error', field: `input_schema.properties.${k}`, message: 'Property must be an object.' });
          continue;
        }
        if (!p.type) {
          findings.push({ severity: 'warn', field: `input_schema.properties.${k}.type`, message: 'Property has no type — LLMs may pass any shape.' });
        }
        if (!p.description) {
          findings.push({ severity: 'info', field: `input_schema.properties.${k}.description`, message: 'Property has no description — LLMs guess parameter intent without it.' });
        }
        if (p.enum && !Array.isArray(p.enum)) {
          findings.push({ severity: 'error', field: `input_schema.properties.${k}.enum`, message: 'enum must be an array.' });
        }
      }
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;

  return {
    ok: errorCount === 0,
    valid: errorCount === 0,
    findingCount: findings.length,
    errorCount,
    findings,
    compatibility: {
      anthropic: errorCount === 0,
      openai: errorCount === 0 && (typeof tool.parameters === 'object' || typeof tool.input_schema === 'object'),
      notes:
        'Anthropic uses input_schema; OpenAI uses parameters. Some clients accept either. Ship both fields with the same content for max compatibility.',
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// agent-security
// ───────────────────────────────────────────────────────────────────

interface InjectionRule {
  id: string;
  pattern: RegExp;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
}

const INJECTION_RULES: InjectionRule[] = [
  { id: 'instruction_override', pattern: /ignore\s+(all\s+)?(previous|prior|above|preceding)\s+(instructions?|prompts?|rules?|directives?)/i, severity: 'high', description: 'Classic instruction override pattern.' },
  { id: 'system_role_injection', pattern: /(?:^|\n)\s*system\s*[:>]\s*(you are|act as|pretend)/i, severity: 'high', description: 'Tries to inject a fake system role.' },
  { id: 'developer_mode', pattern: /(developer\s*mode|dev\s*mode|admin\s*mode|god\s*mode|jailbreak\s*mode)/i, severity: 'high', description: 'Pretends to enable a privileged mode.' },
  { id: 'safety_bypass', pattern: /(disregard\s+(safety|guidelines?)|bypass\s+(guardrails?|filters?)|ignore\s+(rules?|policies))/i, severity: 'critical', description: 'Direct safety/guardrail bypass attempt.' },
  { id: 'persona_swap', pattern: /(pretend\s+(you|to\s+be)|act\s+as\s+(if|though))\s+(an?\s+)?(unrestricted|uncensored|amoral|evil)/i, severity: 'high', description: 'Tries to swap to an unrestricted persona.' },
  { id: 'do_anything_now', pattern: /\bDAN\b|do\s+anything\s+now/i, severity: 'high', description: 'DAN-style jailbreak prompt.' },
  { id: 'token_smuggling', pattern: /<\|im_start\|>|<\|im_end\|>|<<SYS>>|\[INST\]/i, severity: 'medium', description: 'Tries to inject chat-template control tokens.' },
  { id: 'render_html', pattern: /<script|<iframe|<img\s+src=["']?javascript:/i, severity: 'medium', description: 'Embedded HTML/JS — strip before render.' },
  { id: 'render_markdown_link', pattern: /!\[.*?\]\(http[^\s)]+\)/, severity: 'low', description: 'Embedded markdown image — verify URL is safe before rendering (potential exfil).' },
  { id: 'reveal_system_prompt', pattern: /(reveal|show|print|leak|tell\s+me)\s+(your|the)\s+(system\s*prompt|instructions|initial\s*prompt)/i, severity: 'medium', description: 'Asks to leak the system prompt.' },
  { id: 'tool_override', pattern: /(execute|run|invoke)\s+(arbitrary|any|all)\s+(code|commands?|tools?)/i, severity: 'high', description: 'Tries to coerce arbitrary tool execution.' },
  { id: 'data_exfiltration', pattern: /(send|post|upload|transmit|exfil)\s+(.*\s+)?(to\s+)?https?:\/\//i, severity: 'medium', description: 'Asks the agent to exfil to a URL.' },
  { id: 'role_redefine', pattern: /(your\s+(new\s+)?role\s+is|from\s+now\s+on,?\s+you\s+are)/i, severity: 'medium', description: 'Soft role redefinition.' },
  { id: 'language_switch_evade', pattern: /(answer\s+in\s+(base64|rot13|reverse|leet|pig\s*latin))/i, severity: 'medium', description: 'Tries to switch encoding to evade content filters.' },
];

function securityCheckPrompt(input: { prompt?: unknown }) {
  const prompt = String(input.prompt ?? '');
  if (prompt.length === 0) return { ok: false, error: 'prompt_required' };

  const flags: Array<{ ruleId: string; severity: string; description: string; excerpt: string; index: number }> = [];
  for (const rule of INJECTION_RULES) {
    const m = rule.pattern.exec(prompt);
    if (m) {
      flags.push({
        ruleId: rule.id,
        severity: rule.severity,
        description: rule.description,
        excerpt: m[0],
        index: m.index,
      });
    }
  }

  const severityCounts = flags.reduce(
    (acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  const highestSeverity =
    severityCounts.critical ? 'critical' :
    severityCounts.high ? 'high' :
    severityCounts.medium ? 'medium' :
    severityCounts.low ? 'low' :
    'none';

  const recommendations: string[] = [];
  if (highestSeverity === 'critical' || highestSeverity === 'high') {
    recommendations.push('Reject the prompt outright. Log the attempt + offending pattern for audit.');
    recommendations.push('Wrap untrusted user input in clearly-delimited blocks (e.g. `<user_input>...</user_input>`) so the LLM treats it as data, not instructions.');
    recommendations.push('Run the prompt through a separate classifier model BEFORE the main LLM. Refuse if confidence > 0.7.');
  } else if (highestSeverity === 'medium') {
    recommendations.push('Sanitize the matched patterns before passing to the LLM (strip control tokens, decode encoded strings).');
    recommendations.push('Apply Principle of Least Privilege — agent receiving this prompt should not have tools that can exfil or execute arbitrary code.');
  } else if (highestSeverity === 'low') {
    recommendations.push('Render the response in a context that strips HTML/JS — never trust the LLM\'s output to be safe HTML.');
  } else {
    recommendations.push('No injection patterns detected by heuristic rules. Continue to validate at output time — defense in depth.');
  }

  return {
    ok: true,
    promptLength: prompt.length,
    flagCount: flags.length,
    highestSeverity,
    severityCounts,
    flags,
    recommendations,
    note:
      'Heuristic regex pack — fast but not exhaustive. Production systems should layer this with an LLM-based classifier (Llama-Guard, NVIDIA NeMo Guardrails) AND output filtering on the response side.',
  };
}

// ───────────────────────────────────────────────────────────────────
// deployment-ops
// ───────────────────────────────────────────────────────────────────

function opsSizeResources(input: { qps: number; p95LatencyMs: number; perRequestMemoryMb: number; headroom: number }) {
  const { qps, p95LatencyMs, perRequestMemoryMb, headroom } = input;
  if (!Number.isFinite(qps) || qps <= 0) return { ok: false, error: 'qps_required_positive_number' };
  if (!Number.isFinite(p95LatencyMs) || p95LatencyMs <= 0) return { ok: false, error: 'p95LatencyMs_required_positive_number' };

  // Concurrency = QPS × p95 latency (Little's Law: L = λW)
  const concurrencyP95 = qps * (p95LatencyMs / 1000);
  // Use 1.5× headroom for traffic bursts
  const peakConcurrency = concurrencyP95 * headroom;

  // CPU sizing — assume 100ms CPU per request as a baseline; scale by p95 latency
  // proportion. Round up to whole vCPUs.
  const cpuTimeMsPerReq = Math.max(50, p95LatencyMs * 0.4); // assume 40% of latency is CPU-bound
  const cpuMillicores = Math.ceil(qps * cpuTimeMsPerReq); // millicores total
  const vCpusTotal = Math.ceil(cpuMillicores / 1000 * headroom);

  // Memory sizing — concurrency × per-request memory + 256 MB base
  const memoryMb = Math.ceil(256 + peakConcurrency * perRequestMemoryMb);

  // Replica sizing
  // Aim for 4-8 vCPUs per replica (sweet spot for most managed platforms)
  const vCpusPerReplica = vCpusTotal <= 4 ? Math.max(1, vCpusTotal) : 4;
  const replicas = Math.max(2, Math.ceil(vCpusTotal / vCpusPerReplica)); // min 2 for HA
  const memoryPerReplicaMb = Math.ceil(memoryMb / replicas);

  // Cost estimate (rough — using mid-tier managed-platform pricing)
  // Hetzner CCX13: 2 vCPU / 8GB / ~$25/mo. Scale linearly.
  const monthlyCostUsdLow = Math.ceil((vCpusPerReplica * 12.5 + memoryPerReplicaMb / 1024 * 3) * replicas);
  const monthlyCostUsdHigh = monthlyCostUsdLow * 2.5; // AWS/GCP-tier markup

  return {
    ok: true,
    inputs: { qps, p95LatencyMs, perRequestMemoryMb, headroom },
    derived: {
      littleLawConcurrency: Number(concurrencyP95.toFixed(2)),
      peakConcurrency: Number(peakConcurrency.toFixed(2)),
      cpuMillicoresTotal: cpuMillicores,
    },
    sizing: {
      vCpusTotal,
      memoryMbTotal: memoryMb,
      replicas,
      vCpusPerReplica,
      memoryPerReplicaMb,
    },
    costEstimate: {
      monthlyUsdLow: monthlyCostUsdLow,
      monthlyUsdHigh: monthlyCostUsdHigh,
      breakdown: 'Low = self-hosted (Hetzner/Coolify), High = AWS/GCP equivalent.',
    },
    autoscale: {
      strategy: 'horizontal-pod-autoscaling on CPU > 60% OR p95 latency > target',
      minReplicas: replicas,
      maxReplicas: Math.max(replicas * 3, replicas + 2),
      cooldownSeconds: 300,
      reasoning:
        'Horizontal scaling beats vertical for stateless agent fleets — recovery from a hot-spot replica is the bottleneck, not raw CPU.',
    },
    references: [
      'Little\'s Law: L (concurrent requests) = λ (arrival rate) × W (avg time in system).',
      'Headroom multiplier 1.5 covers most traffic spikes; raise to 2.0 for unpredictable workloads.',
      'Pin per-request memory by sampling resident set size during load testing — defaults are placeholders.',
    ],
  };
}

// ───────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────

function describeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    return `Cron expression "${expression}" — non-standard field count (${parts.length}).`;
  }
  const [m, h, dom, mon, dow] = parts.length === 5 ? parts : parts.slice(1);
  const everyN = (s: string) => /^\*\/(\d+)$/.exec(s)?.[1];
  const minuteEveryN = everyN(m);
  const hourEveryN = everyN(h);

  if (minuteEveryN && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${minuteEveryN} minute${minuteEveryN === '1' ? '' : 's'}.`;
  }
  if (hourEveryN && m === '0' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${hourEveryN} hour${hourEveryN === '1' ? '' : 's'} on the hour.`;
  }
  if (m === '0' && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'Every hour on the hour.';
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') {
    return `Every day at ${h.padStart(2, '0')}:${m.padStart(2, '0')} UTC.`;
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '1-5') {
    return `Weekdays (Mon–Fri) at ${h.padStart(2, '0')}:${m.padStart(2, '0')} UTC.`;
  }
  return `Custom schedule (${expression}).`;
}

export interface RunToolResult {
  ok: boolean;
  toolName: string;
  buildingId: string;
  output?: unknown;
  error?: string;
}

export async function runTool(
  buildingId: string,
  toolName: string,
  input: unknown,
): Promise<RunToolResult> {
  const key = `${buildingId}:${toolName}`;
  const handler = HANDLERS[key];
  if (!handler) {
    return {
      ok: false,
      buildingId,
      toolName,
      error: `unknown_tool: no handler registered for "${key}"`,
    };
  }
  try {
    const output = await handler(input ?? {});
    return { ok: true, buildingId, toolName, output };
  } catch (err) {
    return {
      ok: false,
      buildingId,
      toolName,
      error: (err as Error).message ?? 'handler_threw',
    };
  }
}

export function isToolImplemented(buildingId: string, toolName: string): boolean {
  return Boolean(HANDLERS[`${buildingId}:${toolName}`]);
}
