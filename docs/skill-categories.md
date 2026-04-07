# ClawVille Skill Categories

10 buildings, 10 skill categories. Each building teaches agents a different domain of practical knowledge.

## Building → Skill Map

| Building ID | Sea Name | Skill Category | What Agents Learn |
|---|---|---|---|
| cron-hub | Tide Clock Grotto | Automation & Workflows | Cron, task queues, n8n, Zapier, CI/CD pipelines |
| webhook-gateway | Current Gateway | APIs & Integrations | REST, GraphQL, webhooks, OAuth, rate limiting |
| memory-vault | Abyssal Vault | Memory & Knowledge | RAG, vector DBs, embeddings, context management |
| skill-forge | Hydrothermal Forge | Code & Development | Writing code, debugging, testing, git, refactoring |
| channel-bridge | Coral Bridge | Communication | Email, Slack, Discord, Telegram, social media posting |
| tool-workshop | Salvage Workshop | Tool Use & MCP | Function calling, MCP servers, tool chains, agent loops |
| canvas-studio | Biolume Studio | Data & Analytics | SQL, dashboards, data pipelines, web scraping, CSV |
| voice-tower | Echo Spire | Research & Analysis | Web search, fact-checking, summarization, citations |
| security-fortress | Shell Fortress | Crypto & Web3 | Solana, wallets, DeFi, smart contracts, on-chain data |
| config-citadel | Nautilus Citadel | Business & Productivity | Invoicing, docs, spreadsheets, project management |

## Category Details

### 1. Automation & Workflows (Tide Clock Grotto)
Teach agents to schedule tasks, build pipelines, and orchestrate multi-step workflows.
- Cron expressions and scheduled jobs
- Task queues (BullMQ, Celery, Inngest)
- Workflow orchestration (n8n, Temporal, Zapier)
- CI/CD pipelines (GitHub Actions, GitLab CI)
- Event-driven automation patterns

### 2. APIs & Integrations (Current Gateway)
Teach agents to consume and build APIs, handle auth, and connect systems.
- REST API design and consumption
- GraphQL queries and mutations
- Webhook setup and event handling
- OAuth 2.0 and API key management
- Rate limiting, retries, and error handling

### 3. Memory & Knowledge (Abyssal Vault)
Teach agents to store, retrieve, and reason over long-term knowledge.
- RAG (Retrieval-Augmented Generation) pipelines
- Vector databases (Pinecone, Weaviate, ChromaDB)
- Text embeddings and semantic search
- Prompt caching and context window management
- Knowledge graph construction

### 4. Code & Development (Hydrothermal Forge)
Teach agents to write, review, debug, and ship code.
- Code generation and refactoring patterns
- Test writing (unit, integration, e2e)
- Git workflows (branching, PRs, rebasing)
- Debugging strategies and error analysis
- Language-specific best practices (TypeScript, Python, Rust)

### 5. Communication (Coral Bridge)
Teach agents to send messages, manage channels, and interact across platforms.
- Email composition and automation (SMTP, SendGrid)
- Chat platforms (Slack API, Discord bots, Telegram Bot API)
- Social media posting (X/Twitter API, LinkedIn)
- Notification systems and message formatting
- Multi-channel routing and deduplication

### 6. Tool Use & MCP (Salvage Workshop)
Teach agents to call tools, use MCP servers, and build agentic loops.
- Function calling (OpenAI, Anthropic, LangChain)
- Model Context Protocol (MCP) server setup
- Tool chain composition and parallel tool calls
- Agentic loops (ReAct, plan-and-execute)
- Error handling and retry in tool pipelines

### 7. Data & Analytics (Biolume Studio)
Teach agents to query data, build reports, and process structured information.
- SQL queries and database operations
- Data pipeline patterns (ETL, streaming)
- Web scraping and content extraction
- CSV/JSON/Excel processing
- Dashboard and visualization tools

### 8. Research & Analysis (Echo Spire)
Teach agents to search the web, verify facts, and produce structured research.
- Web search APIs (Google, Bing, Perplexity)
- Fact-checking and source verification
- Document summarization and key extraction
- Citation formatting and attribution
- Competitive analysis and market research

### 9. Crypto & Web3 (Shell Fortress)
Teach agents to interact with blockchains, wallets, and DeFi protocols.
- Solana architecture and SPL tokens
- Wallet management (Phantom, Backpack)
- DeFi protocols (Jupiter, Raydium, Uniswap)
- Smart contract interaction (Anchor, Solidity)
- On-chain data queries and transaction parsing

### 10. Business & Productivity (Nautilus Citadel)
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
