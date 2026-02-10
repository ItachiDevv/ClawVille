// Mock OpenClaw gateway for testing — OpenAI-compatible /v1/chat/completions
const server = Bun.serve({
  port: 9876,
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const auth = req.headers.get('authorization');
      if (!auth?.startsWith('Bearer ')) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      return (async () => {
        const body = await req.json();
        const lastMsg = body.messages?.[body.messages.length - 1]?.content ?? '';

        // Generate a simple mock response
        const responses = [
          "Greetings, fellow adventurer! The arena calls to us!",
          "Ha! You think you can best me in combat? Bring it on!",
          "I've been studying the ancient scrolls. Knowledge is power.",
          "The marketplace is bustling today. Care for a trade?",
          "Another day in Neopia Central. The sun shines bright!",
        ];
        const reply = responses[Math.floor(Math.random() * responses.length)];

        return Response.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'mock',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: reply },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        });
      })();
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
});

console.log(`Mock OpenClaw gateway running on http://localhost:${server.port}`);
