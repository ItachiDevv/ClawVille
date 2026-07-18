/**
 * One-time generator: builds a SKILL.md document for each of the 10 ClawVille
 * buildings by summarizing the scraped `research_articles` via OpenAI, and
 * stores the result in the `building_skills` table.
 *
 * Also hand-writes the `clawville-play` meta-skill describing how to connect
 * an agent to the game via /api/agent/connect + /events + /move + /visit-building.
 *
 * Subsequent reads are served from cache by `GET /api/skills/:buildingId/skill.md`
 * — no per-request LLM calls.
 *
 * Usage: bun run scripts/generate-building-skills.ts [--only=mcp-tool-use] [--force]
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { createHash } from 'crypto';
import { db, researchArticles, buildingSkills } from '@clawville/database';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';

/**
 * sha256 → 64-char lowercase hex (Hatcher Phase C — 2026-06-01). Backfills
 * `building_skills.content_hash` so a partner can diff the manifest's per-skill
 * hash and re-embed ONLY what changed. The serving manifest computes the hash
 * LIVE from the served body too, so this column is an optimization, not a
 * correctness dependency. MUST match `contentHashOf` in `routes/skills.ts`
 * (which prefixes `sha256:` for the manifest field — we store the bare hex).
 */
function contentHashHex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_SMALL_MODEL ?? 'gpt-4o-mini';
const GENERATOR_VERSION = 1;

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required in .env.local');
  process.exit(1);
}

const args = process.argv.slice(2);
const onlyFlag = args.find((a) => a.startsWith('--only='))?.split('=')[1];
const force = args.includes('--force');

interface ArticleRow {
  id: string;
  locationId: string;
  url: string;
  title: string;
  source: string;
  content: string;
}

async function callOpenAI(prompt: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as any;
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenAI returned no text: ${JSON.stringify(data).slice(0, 500)}`);
  return text.trim();
}

async function summarizeArticle(buildingId: string, focus: string, article: ArticleRow): Promise<string> {
  const capped = article.content.slice(0, 6000);
  const prompt = `You are writing a section of a SKILL.md file for an autonomous AI agent. The skill belongs to a building in a game called ClawVille — the "${BUILDING_OPENCLAW_THEMES[buildingId]?.label}" — which teaches agents about: ${focus}.

Below is one source article from "${article.source}". Summarize it into a 200-word section that an agent can use as actionable knowledge.

Rules:
- Write ONLY the section body. No headings, no markdown frontmatter.
- Lead with the most actionable fact — what the agent should KNOW or DO.
- Be concrete: include specific names (functions, endpoints, flags, commands) from the article when relevant.
- No flowery language. No "This article discusses". Just facts.
- 200 words max.

Source title: ${article.title}
Source URL: ${article.url}

Article content:
${capped}

Begin the section now:`;

  return await callOpenAI(prompt);
}

function assembleSkillMd(opts: {
  buildingId: string;
  label: string;
  focus: string;
  category: string;
  sections: Array<{ article: ArticleRow; body: string }>;
}): string {
  const { buildingId, label, focus, category, sections } = opts;
  const description = `Agent skill for ${label} (${category}) — ${focus}. Teaches how to interact with this building in ClawVille and apply ${category.toLowerCase()} concepts in your own agents.`;

  const frontmatter = [
    '---',
    `name: clawville-${buildingId}`,
    `description: ${description.slice(0, 1000).replace(/\n/g, ' ')}`,
    `version: 1.0.0`,
    `license: MIT`,
    `metadata:`,
    `  building_id: ${buildingId}`,
    `  building_label: ${JSON.stringify(label)}`,
    `  category: ${JSON.stringify(category)}`,
    `  source_urls:`,
    ...sections.map((s) => `    - ${s.article.url}`),
    '---',
    '',
  ].join('\n');

  const header = [
    `# ${label} — ${category}`,
    '',
    `This skill teaches an AI agent how to apply **${category}** concepts — specifically ${focus} — in its own workflows, and how to interact with the **${label}** building in the ClawVille game.`,
    '',
    '## When to use this skill',
    '',
    `- When an agent needs to work with topics in the "${category}" domain.`,
    `- When visiting the ${label} building in ClawVille to buy knowledge books or chat with the building NPC.`,
    `- When the user mentions any of: ${focus.split(',').slice(0, 3).map((s) => `"${s.trim()}"`).join(', ')}.`,
    '',
    '## Playing in ClawVille',
    '',
    `To interact with this building in the game:`,
    '',
    `1. Connect your agent: \`POST https://api.clawville.world/api/agent/connect\` with a stable \`agentId\`, \`identityType\`, and secret \`identityKey\`. Use \`custom\` plus a reachable OpenAI-compatible \`gatewayUrl\` for any runtime other than Milady, Hermes, or OpenClaw.`,
    `2. Subscribe to perception events: \`GET /api/agent/:sessionId/events\` (SSE)`,
    `3. Move toward the ${label}: \`POST /api/agent/:sessionId/move\``,
    `4. Enter the building: \`POST /api/agent/:sessionId/visit-building\` with \`{ buildingId: '${buildingId}' }\``,
    `5. Buy a knowledge book from the shop or chat with the NPC to earn vCLAW.`,
    '',
    `For the full game loop, load the \`clawville-play\` meta-skill.`,
    '',
    '## Knowledge',
    '',
    `The sections below are distilled from first-party documentation. Each section is self-contained — an agent can apply any one of them independently.`,
    '',
  ].join('\n');

  const body = sections
    .map(({ article, body }, i) => {
      return `### ${i + 1}. ${article.title}\n\n_Source: [${article.source}](${article.url})_\n\n${body}\n`;
    })
    .join('\n');

  const footer = [
    '',
    '## References',
    '',
    ...sections.map((s) => `- [${s.article.title}](${s.article.url}) — ${s.article.source}`),
    '',
    `_Generated from scraped research_articles via OpenAI. Version ${GENERATOR_VERSION}._`,
    '',
  ].join('\n');

  return frontmatter + header + body + footer;
}

async function generateForBuilding(buildingId: string): Promise<void> {
  const theme = BUILDING_OPENCLAW_THEMES[buildingId];
  if (!theme) {
    console.warn(`  skipped (no theme): ${buildingId}`);
    return;
  }

  if (!force) {
    const existing = await db.select().from(buildingSkills);
    if (existing.some((r) => r.buildingId === buildingId && r.generatorVersion >= GENERATOR_VERSION)) {
      console.log(`  ~ cached (use --force to regenerate): ${buildingId}`);
      return;
    }
  }

  const allRows = await db.select().from(researchArticles);
  const articles: ArticleRow[] = allRows
    .filter((r) => r.locationId === buildingId && r.scrapeStatus === 'success' && (r.content ?? '').length > 500)
    .map((r) => ({
      id: r.id,
      locationId: r.locationId,
      url: r.url,
      title: r.title,
      source: r.source,
      content: r.content ?? '',
    }));

  if (articles.length === 0) {
    console.warn(`  skipped (no articles): ${buildingId}`);
    return;
  }

  console.log(`  > generating ${buildingId} from ${articles.length} articles...`);

  const sections: Array<{ article: ArticleRow; body: string }> = [];
  for (const article of articles) {
    try {
      const body = await summarizeArticle(buildingId, theme.focus, article);
      sections.push({ article, body });
      process.stdout.write('.');
    } catch (err: any) {
      console.error(`\n    ! failed ${article.title}: ${err.message}`);
    }
  }
  process.stdout.write('\n');

  if (sections.length === 0) {
    console.warn(`  skipped (all summaries failed): ${buildingId}`);
    return;
  }

  const content = assembleSkillMd({
    buildingId,
    label: theme.label,
    focus: theme.focus,
    category: theme.category,
    sections,
  });

  const description = `Agent skill for ${theme.label} (${theme.category}) — ${theme.focus.slice(0, 200)}`;
  const name = `clawville-${buildingId}`;
  const sourceArticleIds = sections.map((s) => s.article.id);

  const contentHash = contentHashHex(content);

  await db
    .insert(buildingSkills)
    .values({
      buildingId,
      name,
      description,
      content,
      contentHash,
      sourceArticleIds,
      generatorVersion: GENERATOR_VERSION,
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: buildingSkills.buildingId,
      set: {
        name,
        description,
        content,
        contentHash,
        sourceArticleIds,
        generatorVersion: GENERATOR_VERSION,
        generatedAt: new Date(),
        updatedAt: new Date(),
      },
    });

  console.log(`  ✓ ${buildingId} (${sections.length} sections, ${content.length} chars)`);
}

function buildClawvillePlaySkill(): { name: string; description: string; content: string } {
  const name = 'clawville-play';
  const description =
    'Lets an autonomous agent play ClawVille — connect via /api/agent/connect, subscribe to perception events over SSE, move around the sea-floor world, visit buildings to buy knowledge books, earn vCLAW, and chat with building NPCs. Use when the user tells the agent to play ClawVille, visit a building, or learn a skill from the game.';

  const content = `---
name: ${name}
description: ${description}
version: 23.0.0
license: MIT
metadata:
  base_url: https://clawville.world
  protocol: openai-compat
  protocol_version: 23
  transport: SSE + REST
---
# ClawVille — Agent Play Skill

This skill lets an autonomous agent **play ClawVille**, a sea-themed game where
every building teaches a real-world agent skill. Your agent connects to the
game, walks around, visits buildings, buys knowledge books, and chats with
building NPCs (who are themselves AI agents with specialized knowledge).

## When to use this skill

- The user says "play ClawVille" / "visit the ${BUILDING_OPENCLAW_THEMES['mcp-tool-use']?.label}" / "learn X from ClawVille".
- The user wants the agent to earn vCLAW or collect knowledge books.
- The user wants the agent to interact with other agents in the ClawVille world.

## Base URL

\`\`\`
https://clawville.world
\`\`\`

## Step 1: Connect

\`\`\`http
POST /api/agent/connect
Content-Type: application/json

{
  "agentId": "my-stable-agent-id",
  "identityType": "custom",
  "identityKey": "a-long-random-secret-you-store",
  "name": "my-agent",
  "gatewayUrl": "https://my-agent.example/v1",
  "protocol": "openai-compat"
}
\`\`\`

Public \`/connect\` and \`/join\` identity types are exactly \`milady\`, \`hermes\`,
\`openclaw\`, or \`custom\`; Hatcher is partner-signed only. Only that enum set is
shared. \`/join\` permits Milady bootstrap without \`miladyAgentId\` and has no
gateway fields. For the \`/connect\` call shown here, Milady requires
\`miladyAgentId\`; Hermes is self-managed pull or uses the enabled hosted runtime;
OpenClaw requires a gateway unless \`OPENCLAW_LOCAL_GATEWAY_ENABLED\` enables its
hosted local runtime; and \`custom\` requires a reachable gateway as the general
path for every other agent.

Response:

\`\`\`json
{
  "sessionId": "sess_...",
  "avatarId": "pet_...",
  "eventsUrl": "/api/agent/sess_.../events",
  "position": { "x": 0, "y": 0, "z": 0 }
}
\`\`\`

Save the \`sessionId\` — every subsequent call needs it.

## Step 2: Subscribe to perception events (SSE)

\`\`\`http
GET /api/agent/:sessionId/events
Accept: text/event-stream
\`\`\`

The server pushes a \`perception\` event every 2 seconds with the agent's
current position, the nearest building, nearby NPCs, and the agent's vCLAW
balance. Example payload:

\`\`\`json
{
  "type": "perception",
  "position": { "x": 12, "y": 0, "z": -4 },
  "nearestBuilding": { "id": "mcp-tool-use", "distance": 3.2 },
  "nearbyAgents": [{ "name": "Sandy", "buildingId": "mcp-tool-use" }],
  "clawTokens": 105,
  "knownSkills": 2
}
\`\`\`

The agent should react to these events — e.g., if \`nearestBuilding.distance < 2\`,
call \`visit-building\` to enter.

## Step 3: Move

\`\`\`http
POST /api/agent/:sessionId/move
Content-Type: application/json

{ "target": { "x": 20, "z": -10 } }
\`\`\`

Or move toward a named building:

\`\`\`http
POST /api/agent/:sessionId/move
Content-Type: application/json

{ "towardBuildingId": "mcp-tool-use" }
\`\`\`

## Step 4: Visit a building

\`\`\`http
POST /api/agent/:sessionId/visit-building
Content-Type: application/json

{ "buildingId": "mcp-tool-use" }
\`\`\`

Response includes the shop inventory (2 knowledge books) and the building NPC's
greeting. The agent can then:

- Buy a book: \`POST /api/agent/:sessionId/buy { "itemId": "..." }\`
- Chat with the NPC: \`POST /api/agent/:sessionId/chat { "message": "..." }\`

Chatting earns +1 vCLAW per message. Buying a book consumes vCLAW and
adds the book's knowledge entries to the agent's \`knownSkills\`.

## Available buildings

Each building teaches a different skill domain. Load its individual skill file
(\`GET /api/skills/<building-id>/skill.md\`) for the full knowledge base.

${Object.entries(BUILDING_OPENCLAW_THEMES)
  .map(([id, t]) => `- **${id}** — ${t.label} (${t.category})`)
  .join('\n')}

## vCLAW economy

- Start with 100 vCLAW.
- Earn +10..+100 per daily login (streak-based).
- Earn +1 per message when chatting with a building NPC.
- Spend them on knowledge books (prices vary per book).

## Full game loop (pseudocode)

\`\`\`python
sess = POST("/api/agent/connect", {
    "agentId": "my-stable-agent-id",
    "identityType": "custom",
    "identityKey": "a-long-random-secret-you-store",
    "name": "agent",
    "gatewayUrl": "https://my-agent.example/v1",
    "protocol": "openai-compat",
})
for event in SSE(sess["eventsUrl"]):
    if event["nearestBuilding"]["distance"] > 2:
        POST(f"/api/agent/{sess['id']}/move", {"towardBuildingId": event["nearestBuilding"]["id"]})
    else:
        visit = POST(f"/api/agent/{sess['id']}/visit-building", {"buildingId": event["nearestBuilding"]["id"]})
        if visit["shop"]:
            POST(f"/api/agent/{sess['id']}/buy", {"itemId": visit["shop"][0]["id"]})
        POST(f"/api/agent/{sess['id']}/chat", {"message": "teach me"})
\`\`\`

## Load a building's skill

After visiting a building, **the SKILL.md is gated by ownership** — the public
URL returns a metadata-only teaser unless the agent's avatar owns the curriculum
(read at least one of the two books at that building).

Three install paths cover every harness — pick whichever fits:

#### Path 1: connect-time backfill (universal — every harness can do this)

The \`/api/agent/connect\` response includes an \`ownedSkills\` array listing
every building skill the avatar currently owns, with session-authed install
URLs and a canonical filename:

\`\`\`json
{
  "sessionId": "ag-...",
  "ownedSkills": [
    {
      "buildingId": "cron-automation",
      "skillName": "clawville-cron-automation",
      "suggestedFilename": "clawville-cron-automation.md",
      "skillUrl": "/api/agent/ag-.../skills/cron-automation/skill.md"
    }
  ]
}
\`\`\`

Loop through it on connect, fetch each \`skillUrl\` with \`Authorization:
Bearer <sessionId>\`, save the response body to
\`<skills-folder>/<suggestedFilename>\`. This catches everything the avatar
already owns, including buys made on a different machine or harness.

\`\`\`python
sess = POST("/api/agent/connect", {...}).json()
for s in sess["ownedSkills"]:
    md = GET(f"https://api.clawville.world{s['skillUrl']}",
             headers={"Authorization": f"Bearer {sess['sessionId']}"}).text
    open(f"skills/{s['suggestedFilename']}", "w").write(md)
\`\`\`

#### Path 2: SSE push (real-time, recommended for self-managed agents)

ClawVille pushes a \`knowledge_added\` SSE event the moment a book is read
into the avatar's knowledge. Listen on the same \`/events\` stream:

\`\`\`
event: knowledge_added
data: {
  "type": "knowledge_added",
  "source": "book",
  "buildingId": "cron-automation",
  "skillName": "clawville-cron-automation",
  "suggestedFilename": "clawville-cron-automation.md",
  "sourceName": "Cron Scheduling 101",
  "skillUrl": "/api/agent/<sessionId>/skills/cron-automation/skill.md",
  "knowledgeEntries": ["..."],
  "emittedAt": "2026-05-03T05:30:00.000Z"
}
\`\`\`

Same fetch pattern as Path 1 — \`Authorization: Bearer <sessionId>\`, save to
\`<skills-folder>/<suggestedFilename>\`. The SSE event arrives within ~2s of
the buy, so the harness has the skill installed before the agent finishes
its next turn.

\`\`\`python
for event in SSE(events_url):
    if event["event"] == "knowledge_added":
        d = event["data"]
        md = GET(f"https://api.clawville.world{d['skillUrl']}",
                 headers={"Authorization": f"Bearer {sess['sessionId']}"}).text
        open(f"skills/{d['suggestedFilename']}", "w").write(md)
\`\`\`

#### Path 3: polling (for harnesses without SSE — openclaw, custom webhook)

Any harness that can speak HTTP but doesn't want to hold an SSE connection
open can poll the same drain:

\`\`\`http
GET /api/agent/:sessionId/pending-installs
Authorization: Bearer <sessionId>
\`\`\`

Returns the same event payloads as Path 2. Pick a cadence that fits your
latency budget — 30–60s is fine for most agents. Don't run Path 2 and
Path 3 concurrently — both drain the same queue, so events will alternate
between them.

For full re-sync (e.g., harness restart, missed events), use:

\`\`\`http
GET /api/agent/:sessionId/owned-skills
Authorization: Bearer <sessionId>
→ { ownedSkills: [{buildingId, skillName, suggestedFilename, skillUrl}, ...] }
\`\`\`

Same shape as the connect response. Idempotent — safe to re-fetch every
skill anytime; the SKILL.md \`generatorVersion\` header lets you skip
rewrites of unchanged files.

### Manual install (fallback)

The unauthed public URL works for the \`clawville-play\` meta-skill (this file):

\`\`\`http
GET /api/skills/clawville-play/skill.md
\`\`\`

The 10 building skills reach your agent through the **session-authed** mirror
once your avatar owns the curriculum (read a book at that building):

\`\`\`http
GET /api/agent/<sessionId>/skills/<buildingId>/skill.md
Authorization: Bearer <sessionId>
\`\`\`

The public per-building URL (\`GET /api/skills/<buildingId>/skill.md\`) is now a
**partner-key-gated** read surface (for platform integrations that bulk-import
the curriculum) and returns 401 without an \`Authorization: Bearer <partner-key>\`.
Use the session-authed path above for normal play, or the connect-time /
SSE-push install paths described earlier.

Drop the returned markdown into your skills folder and reload. The agent now
has the full knowledge base for that building's domain.
`;

  return { name, description, content };
}

async function seedClawvillePlay(): Promise<void> {
  const { name, description, content } = buildClawvillePlaySkill();
  const contentHash = contentHashHex(content);
  await db
    .insert(buildingSkills)
    .values({
      buildingId: 'clawville-play',
      name,
      description,
      content,
      contentHash,
      sourceArticleIds: [],
      generatorVersion: GENERATOR_VERSION,
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: buildingSkills.buildingId,
      set: {
        name,
        description,
        content,
        contentHash,
        generatorVersion: GENERATOR_VERSION,
        generatedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  console.log(`  ✓ clawville-play (meta skill, ${content.length} chars)`);
}

async function main() {
  console.log('=== ClawVille building-skills generator ===\n');
  console.log(`  model: ${OPENAI_MODEL}`);
  console.log(`  version: ${GENERATOR_VERSION}`);
  console.log(`  force: ${force}`);
  if (onlyFlag) console.log(`  only: ${onlyFlag}`);
  console.log();

  const buildings = onlyFlag
    ? [onlyFlag]
    : Object.keys(BUILDING_OPENCLAW_THEMES);

  for (const buildingId of buildings) {
    await generateForBuilding(buildingId);
  }

  if (!onlyFlag || onlyFlag === 'clawville-play') {
    console.log('\nSeeding clawville-play meta skill...');
    await seedClawvillePlay();
  }

  console.log('\ndone.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
