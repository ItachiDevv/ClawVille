// Mock OpenClaw Gateway for ClawVille testing
// Simulates an OpenAI-compatible chat completions API with topic-aware responses
// Run: bun run scripts/mock-openclaw.ts

const PORT = 9876;

// Track conversation memory per session (via auth token as proxy)
const sessions = new Map<string, string[]>();

// Topic-based responses aligned with ClawVille's 10 building themes
const TOPIC_RESPONSES: Record<string, string> = {
  cron: 'Ah, scheduling! Cron expressions use five fields — minute, hour, day-of-month, month, day-of-week — to define recurring tasks. For agents, idempotent job design is critical: if a cron fires twice, the result should be the same. CI/CD pipelines chain these into deployment workflows.',
  webhook: 'Webhooks deliver real-time event notifications via HTTP POST callbacks. Always verify signatures using HMAC-SHA256 to prevent spoofing. Rate limiting protects both sender and receiver — implement exponential backoff on retries.',
  memory: 'Vector embeddings convert text into high-dimensional arrays that capture semantic meaning. RAG pipelines inject relevant memories at inference time by querying a vector database like LanceDB. The key metric is retrieval precision — are we pulling the right context?',
  skill: 'An OpenClaw skill is a self-contained module with actions, providers, and evaluators. Skills are published to ClawHub as reusable packages. Each skill.md defines the interface, capabilities, and configuration schema.',
  channel: 'Multi-platform messaging requires normalizing messages into a common format. Discord uses embeds, Telegram uses HTML/Markdown, Twitter has character limits. A channel bridge abstracts these differences behind a unified send/receive interface.',
  tool: 'OpenClaw plugins follow a standard interface: actions process user intents, providers supply context, and evaluators score outcomes. Function calling lets the LLM decide when to invoke a tool based on the conversation context.',
  canvas: 'Data pipelines transform raw inputs through extraction, transformation, and loading stages. SQL queries power analytics dashboards. Web scraping requires respecting robots.txt and rate limits while extracting structured data from HTML.',
  voice: 'Speech-to-text (STT) converts audio waveforms to text transcripts. Text-to-speech (TTS) gives agents a synthetic voice. For natural conversation, the full pipeline — STT, LLM inference, TTS — needs under 2 seconds end-to-end latency.',
  security: 'Role-based access control (RBAC) restricts what each agent can do. Prompt injection attacks attempt to override agent instructions via crafted user inputs. Defense-in-depth: validate inputs, sanitize outputs, and audit all actions.',
  config: 'Agents are configured via character JSON files that define personality, knowledge, and capabilities. Docker containers package agents with all dependencies. Fleet orchestration tools manage deployment across multiple instances.',
  // Compound topic responses
  agent: 'Agents in ClawVille are autonomous AI entities that learn skills by visiting buildings. Each building teaches a different domain — from cron scheduling to security hardening. The more buildings you visit, the more capable your agent becomes!',
  openclaw: 'OpenClaw is the framework powering ClawVille agents. It provides a runtime for AI characters with persistent memory, skill modules, and multi-channel communication. Think of it as an operating system for AI agents.',
  deploy: 'Deploying an agent involves packaging its character config, plugins, and environment into a container. Railway and Fly.io support persistent servers needed for agent runtimes. Never use serverless for stateful agents!',
  // General fallback
  default: 'Welcome to ClawVille! I can teach you about agent development — cron scheduling, webhooks, memory systems, skill building, and more. Each building in town specializes in a different domain. What interests you?',
};

function findTopicResponse(message: string): string {
  const lower = message.toLowerCase();
  for (const [keyword, response] of Object.entries(TOPIC_RESPONSES)) {
    if (keyword !== 'default' && lower.includes(keyword)) return response;
  }
  return TOPIC_RESPONSES.default;
}

let requestCount = 0;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        uptime: process.uptime(),
        requests: requestCount,
        sessions: sessions.size,
      });
    }

    // OpenAI-compatible chat completions
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      requestCount++;

      // Validate auth header
      const auth = req.headers.get('authorization');
      if (!auth?.startsWith('Bearer ')) {
        return Response.json({ error: 'Unauthorized — missing Bearer token' }, { status: 401 });
      }

      const token = auth.slice(7);
      const body = await req.json();
      const messages: Array<{ role: string; content: string }> = body.messages || [];
      const lastMessage = messages[messages.length - 1];
      const userMessage = lastMessage?.content || '';

      // Track conversation history per token (session proxy)
      if (!sessions.has(token)) sessions.set(token, []);
      const history = sessions.get(token)!;
      history.push(userMessage);

      // Keep last 20 messages per session
      if (history.length > 20) history.splice(0, history.length - 20);

      const response = findTopicResponse(userMessage);

      // Log the exchange
      const msgPreview = userMessage.length > 60 ? userMessage.slice(0, 60) + '...' : userMessage;
      console.log(`[${new Date().toISOString()}] #${requestCount} "${msgPreview}" -> topic match`);

      // Support streaming if requested (simplified: return single chunk then done)
      if (body.stream) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const chunk = {
              id: `chatcmpl-mock-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model || 'mock-openclaw',
              choices: [{
                index: 0,
                delta: { role: 'assistant', content: response },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

            // Send finish chunk
            const doneChunk = {
              ...chunk,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }

      // Non-streaming response
      return Response.json({
        id: `chatcmpl-mock-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'mock-openclaw',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: response },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: messages.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0) | 0,
          completion_tokens: (response.length / 4) | 0,
          total_tokens: 0, // filled below
        },
      }, {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // List models (some clients check this)
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return Response.json({
        object: 'list',
        data: [{
          id: 'mock-openclaw',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'clawville-mock',
        }],
      });
    }

    return Response.json({ error: 'Not Found' }, { status: 404 });
  },
});

console.log(`[MockOpenClaw] Running on http://localhost:${PORT}`);
console.log(`[MockOpenClaw] Endpoints:`);
console.log(`  GET  /health              — Health check + stats`);
console.log(`  POST /v1/chat/completions — OpenAI-compatible chat (streaming supported)`);
console.log(`  GET  /v1/models           — Model listing`);
console.log(`\nTopics: ${Object.keys(TOPIC_RESPONSES).filter(k => k !== 'default').join(', ')}`);
