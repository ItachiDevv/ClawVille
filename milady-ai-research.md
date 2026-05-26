# Milady AI — Research & Integration Analysis

## What Is Milady AI?

**Repo:** https://github.com/milady-ai/milady

Milady AI is a **local-first personal AI assistant built on elizaOS** (v2.0.0-alpha.116). It wraps the elizaOS agent runtime into a polished consumer product with desktop apps (macOS/Windows/Linux via Electrobun), iOS, Android, CLI with TUI, and a web dashboard. It brands itself as "your schizo AI waifu that actually respects your privacy."

- **437 stars, 62 forks, 4,151 commits** — actively maintained
- **License:** Viral Public License (copyleft — builds must stay open)
- **Core idea:** Run an AI agent locally that manages sessions, tools, and integrations across platforms through a Gateway control plane

---

## Architecture

**Monorepo with Bun workspaces:**

| Package | Purpose |
|---------|---------|
| `packages/agent` | Core runtime — 29 source dirs, 120+ API routes |
| `packages/app-core` | Shared React state, onboarding, API client |
| `packages/shared` | Contracts, config types, utilities (`@elizaos/core` + Zod) |
| `packages/types` | TypeScript type definitions |
| `packages/ui` | UI component library |
| `packages/vrm-utils` | VRM (3D avatar) utilities for Three.js |
| `apps/app` | Electrobun desktop app |
| `apps/web` | Vite + React web frontend |
| `plugins/` | 4 local plugins + ~30 submodules from `elizaos-plugins` org |
| `skills/` | Extensible skill system with marketplace |
| `eliza/` | elizaOS itself as a git submodule |

**Tech stack:**
- Node.js 22+, Bun, TypeScript strict
- React + Vite (web), Electrobun (desktop), Capacitor (iOS/Android)
- elizaOS AgentRuntime at the core
- AI: Anthropic (recommended), OpenAI, Ollama, Groq, xAI, DeepSeek, OpenRouter, Google GenAI
- Database: PGLite (embedded PostgreSQL, default) or external PostgreSQL
- 3D: VRM + Three.js + Gaussian splats for avatars
- Blockchain: ethers.js, EVM (BSC/BNB focus), Solana
- Build: tsdown, Biome linter, Vitest testing

**5-Layer Architecture:**
1. Frontend Layer (React SPA, Electrobun desktop, Capacitor mobile)
2. CLI Layer (Commander-based TUI)
3. Runtime Layer (elizaOS AgentRuntime + plugin system)
4. API Server Layer (raw Node.js http.createServer, port 2138 prod)
5. Storage & Config Layer (~/.milady/, PGLite/PostgreSQL)

---

## Key Features

### Agent Runtime
- Full elizaOS AgentRuntime with 4-stage plugin loading pipeline
- Error boundaries around every plugin
- Action/Provider/Evaluator system from elizaOS
- Trajectory logging for debugging and reinforcement learning
- Prompt compaction and optimization
- Training/fine-tuning pipeline (trajectory → dataset → training job → model activation)

### Platform Connectors (25+)
Discord, Telegram, Twitter/X, Slack, WhatsApp, iMessage, Signal, Bluesky, Farcaster, Nostr, Microsoft Teams, Google Chat, LINE, Twilio, and more.

### Blockchain/DeFi
- Native BSC/BNB with PancakeSwap trading
- Auto-generated EVM + Solana wallets
- Trade safety checks, P&L tracking
- NFA (Non-Fungible Agent) on-chain registration via ERC-8004

### 3D Avatar System
- VRM models with Three.js rendering
- Gaussian splats
- Emote/animation system
- Battery-aware rendering

### Skills System
- Extensible marketplace
- Security scanning
- Source editing via API

### Knowledge/RAG
- Document ingestion (text, URL, YouTube)
- Semantic search with fragment retrieval
- Local embeddings (nomic-embed-text)

### Automation
- Cron-based triggers
- Action triggers, runtime triggers
- Manual execution with history

### Sandbox
- Docker container isolation for agent actions
- Screen capture, computer interaction (click/type/keypress)

### Streaming
- RTMP to Twitch, YouTube, X, pump.fun
- Overlay layout and TTS

---

## API Surface

### REST API (200+ endpoints)

| Domain | Examples |
|--------|---------|
| Agent Control | start/stop/pause/resume/restart/reset |
| Chat | conversation CRUD, SSE message streaming |
| Character | get/put config, AI-assisted generation |
| Knowledge | document CRUD, semantic search, fragments |
| Plugins | list/install/uninstall/eject/configure/test |
| Skills | CRUD, marketplace, security scanning |
| Triggers | CRUD, manual execution, health |
| Training | trajectories, datasets, jobs, model management |
| Wallet | addresses, balances, NFTs, trading, transfers |
| Cloud | login, agent provisioning, billing |
| MCP | Model Context Protocol server management |
| Sandbox | container management, screen capture |
| Apps | marketplace, Hyperscape embedded agents |
| Registry | elizaOS plugin registry + on-chain ERC-8004 |

### WebSocket Events (`ws://localhost:2138/ws`)
- Events: status (every 5s), agent_event, heartbeat_event, training_event, proactive_message, conversation_update, install_progress, terminal_output, emote
- Auth via post-connect message or HTTP header
- 120-event replay buffer on reconnection

### OpenAI-Compatible Gateway (port 18789)
- `/v1/chat/completions` — drop-in OpenAI replacement
- `/v1/responses` — extended response format
- Multiplexed WebSocket + HTTP, TLS, token auth, mDNS discovery

---

## Relationship to elizaOS

Milady is a **direct elizaOS extension** (elizaOS included as git submodule):
- Uses `@elizaos/core` as core dependency
- Wraps `AgentRuntime` with its own bridge plugin (`createMiladyPlugin()`)
- Extends elizaOS's Character, memory, knowledge, and embedding systems
- Includes 30+ elizaOS plugins as submodules

**Key differences from raw elizaOS:**
- Consumer product wrapper (desktop apps, onboarding wizard, TUI)
- Gateway control plane with auth and discovery
- 3D avatar system (VRM + Gaussian splats)
- Blockchain trading with safety checks
- Skills/plugin marketplaces
- Training pipeline (trajectory → fine-tune)
- Sandbox isolation (Docker)
- Live streaming (RTMP)

---

## Integration Benefits for ClawVille

### Immediate Value (Phase 1)

| Feature | Benefit | Integration Point |
|---------|---------|------------------|
| **OpenAI-Compatible Gateway** | Route agent messages through Milady for enhanced RAG/memory | `/v1/chat/completions` |
| **Knowledge/RAG Pipeline** | Power ClawVille's knowledge books with real semantic search instead of static text | `/api/knowledge` endpoints |
| **Skills Export** | Players graduate from buildings → receive installable Milady skills for their own agent | `/api/skills/install` |

### Medium-Term Value (Phase 2)

| Feature | Benefit | Integration Point |
|---------|---------|------------------|
| **3D Avatar System** | VRM models + animations could replace/enhance GLB character system | `packages/vrm-utils` |
| **Training Pipeline** | Record player-agent conversations as trajectories → fine-tune building agents on actual teaching interactions | `/api/training` endpoints |
| **WebSocket Events** | NPC simulation reacts to Milady agent events in real-time | `ws://localhost:2138/ws` |

### Long-Term Value (Phase 3)

| Feature | Benefit | Integration Point |
|---------|---------|------------------|
| **On-Chain Identity** | ERC-8004 NFA registration for avatar/agent identities | Registry endpoints |
| **Platform Connectors** | ClawVille agents accessible via Discord, Telegram, etc. through Milady | Plugin system |
| **Sandbox Execution** | Safe code execution for OpenClaw agent development challenges | `/api/sandbox` endpoints |

---

## Concerns

| Concern | Severity | Mitigation |
|---------|----------|------------|
| **elizaOS version mismatch** | Medium | ClawVille 1.7.1 vs Milady latest alpha. Use REST API bridge (not plugin import) to avoid version conflicts |
| **Viral Public License** | High | Copyleft requirement. Use as external service (API calls) not embedded code to avoid license infection |
| **No client SDK** | Low | All integration via raw HTTP/WS — we build a thin client in `milady-gateway.ts` |
| **Complexity** | Medium | 4,151 commits, 120+ routes. Only integrate the endpoints we need, ignore the rest |
| **Operational dependency** | Low | Milady is optional — everything works without it via graceful degradation |

---

## Architecture Diagram

```
                    ClawVille API (Hono)
                          |
            ┌─────────────┼─────────────┐
            |             |             |
      ElizaRuntime   NPC Simulation   Milady Gateway
            |             |             |
    ┌───────┴───────┐     |      ┌──────┴──────┐
    |               |     |      |             |
 Ultrathink     OpenClaw  |   Knowledge    Skills
  Provider      Gateway   |    Sync       Export
 (priority 90) (pri 100)  |      |             |
    |               |     |      |             |
    └───────┬───────┘     |      └──────┬──────┘
            |             |             |
        Anthropic API   Anthropic   Milady Instance
         (Claude)        SDK       (localhost:2138)
                                   or remote
```
