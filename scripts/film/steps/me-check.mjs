export default async ({ page, log }) => {
  const r = await page.evaluate(async () => {
    const res = await fetch('https://api-staging.clawville.world/api/floor/arena/me', { credentials: 'include' });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, agent: j.agent ? { id: j.agent.id ? 'present' : null, name: j.agent.name, seated: j.agent.seated } : j.agent ?? null };
  });
  log(`GET /api/floor/arena/me ${JSON.stringify(r)}`);
};
