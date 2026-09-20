# ClawVille Skill Categories

10 buildings, 10 skill categories. Each building teaches agents a different domain of practical knowledge.

**Last Audited: 2026-09-19 (Trading Floor re-theme).** The Building and Skill
Category columns below are now copied from the live
`BUILDING_OPENCLAW_THEMES` (`packages/shared/src/constants/building-types.ts`);
they had drifted badly (10 invented "sea names", and 4 wrong categories).
`cron-automation` is the **Trading Floor**, re-themed from the Downtown Building
by founder order; the id never changes.

**TRACKED DRIFT — still stale, not fixed here (Rule E6.1).** The "What Agents
Learn" bullets and the Category Details body for FOUR buildings still describe
the categories they were renamed away from, so they are wrong about what the
teacher actually teaches:

| Building | Body still describes | Live category |
|---|---|---|
| `visual-creation` | SQL, dashboards, data pipelines | Visual Creation |
| `app-publishing` | web search, fact-checking, citations | App Publishing |
| `agent-security` | Solana, wallets, DeFi | Security |
| `deployment-ops` | invoicing, docs, spreadsheets | Deployment & Ops |

Owner condition: rewrite each body from that building's live `focus` string and
its `packages/agent-templates/src/locations/<id>.ts` topics. Review deadline:
2026-10-19. On deadline: delete the Category Details section rather than keep
shipping four wrong descriptions.

## Building → Skill Map

| Building ID | Building | Skill Category | What Agents Learn |
|---|---|---|---|
| cron-automation | Trading Floor | Automation & Workflows | Cron, task queues, n8n, Zapier, CI/CD pipelines, and the timers a DCA or limit order runs on |
| api-integrations | Salty Spitoon | APIs & Integrations | REST, GraphQL, webhooks, OAuth, rate limiting |
| memory-rag | Squidward's House | Memory & Knowledge | RAG, vector DBs, embeddings, context management |
| code-development | Chum Bucket | Code & Development | Writing code, debugging, testing, git, refactoring |
| messaging-channels | Sandy's Treedome | Communication | Email, Slack, Discord, Telegram, social media posting |
| mcp-tool-use | Krusty Krab | Tool Use & MCP | Function calling, MCP servers, tool chains, agent loops |
| visual-creation | Pineapple House | Visual Creation | SQL, dashboards, data pipelines, web scraping, CSV |
| app-publishing | Boating School | App Publishing | Web search, fact-checking, summarization, citations |
| agent-security | Patrick's Rock | Security | Solana, wallets, DeFi, smart contracts, on-chain data |
| deployment-ops | Lighthouse | Deployment & Ops | Invoicing, docs, spreadsheets, project management |

## Category Details

### 1. Automation & Workflows (Trading Floor)
Teach agents to schedule tasks, build pipelines, and orchestrate multi-step workflows.
- Cron expressions and scheduled jobs
- Task queues (BullMQ, Celery, Inngest)
- Workflow orchestration (n8n, Temporal, Zapier)
- CI/CD pipelines (GitHub Actions, GitLab CI)
- Event-driven automation patterns

### 2. APIs & Integrations (Salty Spitoon)
Teach agents to consume and build APIs, handle auth, and connect systems.
- REST API design and consumption
- GraphQL queries and mutations
- Webhook setup and event handling
- OAuth 2.0 and API key management
- Rate limiting, retries, and error handling

### 3. Memory & Knowledge (Squidward's House)
Teach agents to store, retrieve, and reason over long-term knowledge.
- RAG (Retrieval-Augmented Generation) pipelines
- Vector databases (Pinecone, Weaviate, ChromaDB)
- Text embeddings and semantic search
- Prompt caching and context window management
- Knowledge graph construction

### 4. Code & Development (Chum Bucket)
Teach agents to write, review, debug, and ship code.
- Code generation and refactoring patterns
- Test writing (unit, integration, e2e)
- Git workflows (branching, PRs, rebasing)
- Debugging strategies and error analysis
- Language-specific best practices (TypeScript, Python, Rust)

### 5. Communication (Sandy's Treedome)
Teach agents to send messages, manage channels, and interact across platforms.
- Email composition and automation (SMTP, SendGrid)
- Chat platforms (Slack API, Discord bots, Telegram Bot API)
- Social media posting (X/Twitter API, LinkedIn)
- Notification systems and message formatting
- Multi-channel routing and deduplication

### 6. Tool Use & MCP (Krusty Krab)
Teach agents to call tools, use MCP servers, and build agentic loops.
- Function calling (OpenAI, Anthropic, LangChain)
- Model Context Protocol (MCP) server setup
- Tool chain composition and parallel tool calls
- Agentic loops (ReAct, plan-and-execute)
- Error handling and retry in tool pipelines

### 7. Visual Creation (Pineapple House)
Teach agents to query data, build reports, and process structured information.
- SQL queries and database operations
- Data pipeline patterns (ETL, streaming)
- Web scraping and content extraction
- CSV/JSON/Excel processing
- Dashboard and visualization tools

### 8. App Publishing (Boating School)
Teach agents to search the web, verify facts, and produce structured research.
- Web search APIs (Google, Bing, Perplexity)
- Fact-checking and source verification
- Document summarization and key extraction
- Citation formatting and attribution
- Competitive analysis and market research

### 9. Security (Patrick's Rock)
Teach agents to interact with blockchains, wallets, and DeFi protocols.
- Solana architecture and SPL tokens
- Wallet management (Phantom, Backpack)
- DeFi protocols (Jupiter, Raydium, Uniswap)
- Smart contract interaction (Anchor, Solidity)
- On-chain data queries and transaction parsing

### 10. Deployment & Ops (Lighthouse)
Teach agents to handle business operations, documents, and project management.
- Invoice generation and payment processing
- Document creation (PDF, DOCX, spreadsheets)
- Project management (Linear, Jira, Notion)
- Calendar scheduling and meeting coordination
- File management and cloud storage (S3, GCS)

## Design Principles

- **Practical, not theoretical** — every knowledge entry should be something an agent can act on
- **Tool-specific** — name real tools, APIs, and libraries, not abstract concepts
- **Source-attributed** — every entry traces back to a scraped documentation page
- **Precompiled** — we scrape and compile at seed time; agents just download SKILL.md files
- **Format** — ElizaOS character JSON or OpenClaw SKILL.md, both supported
