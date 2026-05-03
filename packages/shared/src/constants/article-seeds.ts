import type { ResearchArticleSeed } from '../types/research';

/**
 * Curated documentation URLs per building (4-5 per building).
 * Pre-scraped and cached in the research_articles table.
 *
 * SECURITY: All sources are official documentation from trusted first-party domains.
 * No blogs, no user-generated wikis, no ad-supported content sites.
 * This prevents prompt injection via scraped content.
 *
 * ClawVille buildings teach general-purpose agent skills across 10 categories.
 *
 * NOTE 2026-05-03: visual-creation and app-publishing URLs below are legacy
 * stubs from when these buildings taught Data & Analytics and Research &
 * Analysis respectively. New URLs aligned with the rebrand will be staged in
 * a follow-up scrape pass; the BUILDING_OPENCLAW_THEMES focus strings drive
 * NPC behavior in the meantime.
 */
export const LOCATION_ARTICLE_SEEDS: Record<string, ResearchArticleSeed[]> = {
  // ─── Automation & Workflows ───────────────────────────────────────────
  'cron-automation': [
    { url: 'https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule', title: 'GitHub Actions: Scheduled Workflows with Cron', source: 'GitHub Docs' },
    { url: 'https://docs.temporal.io/workflows', title: 'Temporal: Durable Workflow Execution', source: 'Temporal Docs' },
    { url: 'https://docs.n8n.io/workflows/', title: 'n8n: Workflow Automation Concepts', source: 'n8n Docs' },
    { url: 'https://docs.inngest.com/docs/guides/scheduled-functions', title: 'Inngest: Scheduled Functions for Pipelines', source: 'Inngest Docs' },
    { url: 'https://docs.bullmq.io/guide/introduction', title: 'BullMQ: Task Queue and Job Processing', source: 'BullMQ Docs' },
  ],

  // ─── APIs & Integrations ──────────────────────────────────────────────
  'api-integrations': [
    { url: 'https://docs.github.com/en/webhooks/about-webhooks', title: 'GitHub Webhooks: Event-Driven Architecture', source: 'GitHub Docs' },
    { url: 'https://docs.stripe.com/webhooks', title: 'Stripe Webhooks: Event Handling Best Practices', source: 'Stripe Docs' },
    { url: 'https://graphql.org/learn/', title: 'GraphQL: Query Language for APIs', source: 'GraphQL Foundation' },
    { url: 'https://docs.svix.com/overview', title: 'Svix: Enterprise Webhook Delivery', source: 'Svix Docs' },
    { url: 'https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow', title: 'Auth0: OAuth 2.0 Authorization Code Flow', source: 'Auth0 Docs' },
  ],

  // ─── Memory & Knowledge ───────────────────────────────────────────────
  'memory-rag': [
    { url: 'https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching', title: 'Anthropic: Prompt Caching for Persistent Context', source: 'Anthropic Docs' },
    { url: 'https://docs.pinecone.io/guides/get-started/overview', title: 'Pinecone: Vector Database for AI Memory', source: 'Pinecone Docs' },
    { url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/embeddings.html', title: 'AWS Bedrock: Text Embeddings for Semantic Search', source: 'AWS Docs' },
    { url: 'https://python.langchain.com/docs/concepts/vectorstores/', title: 'LangChain: Vector Store Architecture', source: 'LangChain Docs' },
    { url: 'https://docs.trychroma.com/docs/overview/introduction', title: 'ChromaDB: Open-Source Embedding Database', source: 'ChromaDB Docs' },
  ],

  // ─── Code & Development ───────────────────────────────────────────────
  'code-development': [
    { url: 'https://www.typescriptlang.org/docs/handbook/2/basic-types.html', title: 'TypeScript: Type System Fundamentals', source: 'TypeScript Docs' },
    { url: 'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests', title: 'GitHub: Pull Request Collaboration Workflow', source: 'GitHub Docs' },
    { url: 'https://vitest.dev/guide/', title: 'Vitest: Fast Unit Testing for Modern Projects', source: 'Vitest Docs' },
    { url: 'https://docs.astral.sh/ruff/', title: 'Ruff: Fast Python Linting and Formatting', source: 'Astral Docs' },
    { url: 'https://docs.docker.com/get-started/introduction/', title: 'Docker: Containerized Development Environments', source: 'Docker Docs' },
  ],

  // ─── Communication ────────────────────────────────────────────────────
  'messaging-channels': [
    { url: 'https://api.slack.com/apis/events-api', title: 'Slack: Events API for Real-Time Messaging', source: 'Slack Docs' },
    { url: 'https://discord.com/developers/docs/resources/webhook', title: 'Discord: Webhook Integration for Bots', source: 'Discord Docs' },
    { url: 'https://core.telegram.org/bots/api', title: 'Telegram: Bot API for Agent Messaging', source: 'Telegram Docs' },
    { url: 'https://docs.sendgrid.com/for-developers/sending-email/api-getting-started', title: 'SendGrid: Transactional Email API', source: 'SendGrid Docs' },
    { url: 'https://www.twilio.com/docs/messaging/quickstart', title: 'Twilio: SMS and Messaging Quickstart', source: 'Twilio Docs' },
  ],

  // ─── Tool Use & MCP ───────────────────────────────────────────────────
  'mcp-tool-use': [
    { url: 'https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview', title: 'Anthropic: Function Calling Overview', source: 'Anthropic Docs' },
    { url: 'https://docs.anthropic.com/en/docs/build-with-claude/tool-use', title: 'Anthropic: Claude Tool Use', source: 'Anthropic Docs' },
    { url: 'https://modelcontextprotocol.io/introduction', title: 'MCP: Model Context Protocol Standard', source: 'MCP Docs' },
    { url: 'https://python.langchain.com/docs/concepts/tools/', title: 'LangChain: Tool Architecture for Agents', source: 'LangChain Docs' },
    { url: 'https://python.langchain.com/docs/how_to/custom_tools/', title: 'LangChain: Building Custom Agent Tools', source: 'LangChain Docs' },
  ],

  // ─── Visual Creation (legacy URLs — see top-of-file note) ─────────────
  'visual-creation': [
    { url: 'https://docs.github.com/en/rest', title: 'GitHub REST API: Structured Data Access', source: 'GitHub Docs' },
    { url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html', title: 'AWS S3: Object Storage for Data Pipelines', source: 'AWS Docs' },
    { url: 'https://docs.snowflake.com/en/user-guide-getting-started', title: 'Snowflake: Cloud Data Warehouse Getting Started', source: 'Snowflake Docs' },
    { url: 'https://docs.firecrawl.dev/introduction', title: 'Firecrawl: Web Scraping API for AI', source: 'Firecrawl Docs' },
    { url: 'https://supabase.com/docs/guides/database/overview', title: 'Supabase: PostgreSQL Database Platform', source: 'Supabase Docs' },
  ],

  // ─── App Publishing (legacy URLs — see top-of-file note) ──────────────
  'app-publishing': [
    { url: 'https://docs.perplexity.ai/guides/search-quickstart', title: 'Perplexity: Search API for AI Research', source: 'Perplexity Docs' },
    { url: 'https://docs.tavily.com/documentation/api-reference/endpoint/search', title: 'Tavily: AI-Optimized Search API', source: 'Tavily Docs' },
    { url: 'https://docs.exa.ai/reference/search', title: 'Exa: Semantic Search API for Agents', source: 'Exa Docs' },
    { url: 'https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering', title: 'Anthropic: Prompt Engineering for Analysis', source: 'Anthropic Docs' },
    { url: 'https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering', title: 'Anthropic: Prompt Engineering for Structured Analysis', source: 'Anthropic Docs' },
  ],

  // ─── Agent Security ───────────────────────────────────────────────────
  'agent-security': [
    { url: 'https://owasp.org/www-project-top-10-for-large-language-model-applications/', title: 'OWASP: Top 10 for LLM Applications', source: 'OWASP' },
    { url: 'https://learn.microsoft.com/en-us/security/zero-trust/', title: 'Microsoft: Zero Trust Security Model', source: 'Microsoft Docs' },
    { url: 'https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks', title: 'Anthropic: Mitigating Jailbreaks and Prompt Injections', source: 'Anthropic Docs' },
    { url: 'https://platform.openai.com/docs/guides/prompt-engineering', title: 'OpenAI: Prompt Engineering and Safety', source: 'OpenAI Docs' },
    { url: 'https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf', title: 'NIST: AI Risk Management Framework', source: 'NIST' },
  ],

  // ─── Deployment & Ops ─────────────────────────────────────────────────
  'deployment-ops': [
    { url: 'https://kubernetes.io/docs/concepts/overview/', title: 'Kubernetes: Container Orchestration Concepts', source: 'Kubernetes Docs' },
    { url: 'https://docs.docker.com/build/building/multi-stage/', title: 'Docker: Multi-Stage Builds for Lean Images', source: 'Docker Docs' },
    { url: 'https://prometheus.io/docs/introduction/overview/', title: 'Prometheus: Metrics and Observability', source: 'Prometheus Docs' },
    { url: 'https://docs.coolify.io/get-started/introduction', title: 'Coolify: Self-Hosted Deployment Platform', source: 'Coolify Docs' },
    { url: 'https://railway.com/docs', title: 'Railway: Application Deployment Guides', source: 'Railway Docs' },
  ],
};
