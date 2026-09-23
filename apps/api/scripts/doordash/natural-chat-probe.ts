/**
 * Manual staging-only language probe. No database, dd-cli, or real cart access.
 * bun apps/api/scripts/doordash/natural-chat-probe.ts --allow-inference
 * Uses actual processMessage, action descriptions, parsing, and read handlers.
 * The memory adapter and vendor bridge are synthetic. The existing text-provider
 * plugin performs real inference through the hosted-user InferenceRouter route.
 */
export {};
const emit = process.stdout.write.bind(process.stdout);
const report = (value: unknown) => emit(`${JSON.stringify(value)}\n`);

if (process.env.CLAWVILLE_ENV !== 'staging' || !process.argv.includes('--allow-inference')) {
  report({ pass: false, reason: 'Requires staging and --allow-inference' });
  process.exit(1);
}

// Never emit module logs, provider errors, prompts, or unparsed model output.
const consoleMethods = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'table'] as const;
const savedConsole = consoleMethods.map((key) => [key, console[key]] as const);
for (const key of consoleMethods) console[key] = () => {};
const savedStdout = process.stdout.write;
const savedStderr = process.stderr.write;
process.stdout.write = (() => true) as typeof process.stdout.write;
process.stderr.write = (() => true) as typeof process.stderr.write;

let restorePlugin = () => {};
let callDeadline: ReturnType<typeof setTimeout> | undefined;
let currentPhrase = 'initialization';
let phase = 'module-imports';
const startedAt = Date.now();
let turnStartedAt = startedAt;
let providerStartedAt = 0;
const PER_CALL_DEADLINE_MS = 90_000;
const OVERALL_DEADLINE_MS = 360_000;
const timing = () => ({
  phase, elapsedMs: Date.now() - startedAt, turnMs: Date.now() - turnStartedAt,
  ...(providerStartedAt ? { providerMs: Date.now() - providerStartedAt } : {}),
});
const stop = (reason: string) => {
  restorePlugin();
  report({ phrase: currentPhrase, action: [], pass: false, reason, ...timing() });
  process.exit(1); // Also terminates a provider request that ignores our deadline.
};
// The provider defaults to a 60s attempt. A 25s probe watchdog hid its result.
// These are probe-process ceilings, not changes to route or provider settings.
const overallDeadline = setTimeout(() => stop('overall deadline'), OVERALL_DEADLINE_MS);
const progress = setInterval(() => report({ phrase: currentPhrase, status: 'pending', ...timing() }), 15_000);

try {
  const { ElizaRuntime } = await import('../../../../packages/agent-runtime/src/eliza-runtime');
  const { clawvillePlugin } = await import('../../../../packages/agent-runtime/src/plugins/clawville-plugin');
  const { createOpenAITextPlugin } = await import('../../../../packages/agent-runtime/src/plugins/openai-text-provider');
  const { buildEndpointsFromEnv, buildRouteTableFromEnv } = await import('../../../../packages/agent-runtime/src/inference/inference-config');
  const { doordashSearchAction, doordashMenuAction } = await import('../../../../packages/agent-runtime/src/actions/doordash');
  const oldActions = clawvillePlugin.actions;
  const oldProviders = clawvillePlugin.providers;
  restorePlugin = () => {
    clawvillePlugin.actions = oldActions;
    clawvillePlugin.providers = oldProviders;
  };
  // No address, cart, preview, submit, or arbitrary world actions exist here.
  clawvillePlugin.actions = [doordashSearchAction, doordashMenuAction];
  clawvillePlugin.providers = [];
  const textPlugin = createOpenAITextPlugin({ route: 'hosted-user', defaultTemperature: 0 });
  const generate = textPlugin.models?.TEXT_LARGE;
  if (!generate) throw new Error('Missing generation handler');
  const endpoints = buildEndpointsFromEnv();
  const routes = buildRouteTableFromEnv(endpoints);
  const routeEntries = routes['hosted-user'].map((id) => endpoints.find((entry) => entry.id === id)!);
  // Explicit allowlist only: no endpoint URL, key, raw env, prompt, or error.
  const safeModel = (value: string) => /^(?:gpt-|o\d|qwen|llama|gemma|deepseek|mistral)[a-z0-9._:\/-]{0,70}$/i.test(value)
    ? value : 'configured-model';
  report({ route: 'hosted-user', size: 'large', models: routeEntries.map((entry) => safeModel(entry.largeModel)),
    configuredAttemptTimeoutMs: routeEntries.map((entry) => entry.timeoutMs),
    perCallDeadlineMs: PER_CALL_DEADLINE_MS, overallDeadlineMs: OVERALL_DEADLINE_MS });
  phase = 'runtime-preparation';

  type Captured = { action: 'SEARCH' | 'MENU'; params: Record<string, unknown> };
  const captured: Captured[] = [];
  const memories: Array<{ roomId: string; entityId: string; content: { text: string }; createdAt?: number }> = [];
  const bridge = {
    search: async (params: { query: string }) => {
      captured.push({ action: 'SEARCH', params });
      return { ok: true, durationMs: 0, data: { stores: [
        { store_id: 'fixture-a', store_name: 'Synthetic Orchard Cafe' },
        { store_id: 'fixture-b', store_name: 'Synthetic Harbor Pizza' },
      ] } };
    },
    menu: async (params: { storeName?: string; storeId?: string; query?: string }) => {
      captured.push({ action: 'MENU', params });
      return { ok: true, durationMs: 0, data: {
        menu_id: 'fixture-menu', storeName: 'Synthetic Harbor Pizza', items: [
          { item_id: 'fixture-item', name: 'Synthetic Orchard Drink' },
        ],
      } };
    },
  };
  let generationCalls = 0;
  const runtime = new ElizaRuntime({
    agentId: '61000000-0000-0000-0000-000000000016',
    agentType: 'avatar-agent', agentConfig: {},
  });
  Object.assign(runtime, {
    state: 'running',
    runtime: {
      ensureWorldExists: async () => {},
      getRoom: async () => ({}),
      getEntityById: async () => ({}),
      getMemories: async () => structuredClone(memories.slice(-20)),
      createMemory: async (memory: (typeof memories)[number]) => { memories.push(structuredClone(memory)); },
      generateText: async (prompt: string, params: Record<string, unknown>) => {
        phase = 'prompt-isolation';
        generationCalls += 1;
        if (generationCalls > 8) throw new Error('Generation budget exceeded');
        // A failure here must not print the prompt or any catalog text.
        if (prompt.includes('Synthetic Orchard') || prompt.includes('Synthetic Harbor')
          || prompt.includes('DOORDASH_SUBMIT') || prompt.includes('DOORDASH_CART')) {
          throw new Error('Prompt isolation failed');
        }
        phase = 'provider-generation';
        providerStartedAt = Date.now();
        report({ phrase: currentPhrase, status: 'provider-start', ...timing() });
        const text = await generate({} as never, { ...params, prompt, maxTokens: 350 } as never);
        phase = 'action-dispatch';
        report({ phrase: currentPhrase, status: 'provider-returned', ...timing() });
        return { text: String(text) };
      },
    },
  });
  type Case = { phrase: string; expected: Captured['action'] | null; reset?: boolean; accepts: (params: Record<string, unknown>) => boolean };
  const cases: Case[] = [
    { phrase: 'I feel like pizza. Can you find somewhere?', expected: 'SEARCH', reset: true,
      accepts: (p) => String(p.query).trim().toLowerCase() === 'pizza' },
    { phrase: 'The second one, please.', expected: 'MENU',
      accepts: (p) => /^(?:the )?(?:second|2|2nd)(?: one)?$/i.test(String(p.storeName)) && !p.storeId },
    { phrase: 'What drinks do they have?', expected: 'MENU',
      accepts: (p) => !p.storeName && !p.storeId && /^(drinks?|beverages?)$/i.test(String(p.query)) },
    { phrase: 'Show me their full menu.', expected: 'MENU',
      accepts: (p) => !p.storeName && !p.storeId && !p.query },
    { phrase: 'What hoagies does Wawa have?', expected: 'MENU', reset: true,
      accepts: (p) => /^wawa$/i.test(String(p.storeName)) && /^hoagies?$/i.test(String(p.query)) && !p.storeId },
    { phrase: 'Can we get tacos?', expected: 'SEARCH', reset: true,
      accepts: (p) => /^tacos?$/i.test(String(p.query)) },
    { phrase: 'Hello, how are you today?', expected: null, reset: true, accepts: () => true },
  ];
  let failures = 0;
  for (const item of cases) {
    currentPhrase = item.phrase;
    turnStartedAt = Date.now();
    providerStartedAt = 0;
    phase = 'process-message';
    if (item.reset) memories.length = 0;
    captured.length = 0;
    callDeadline = setTimeout(() => stop('per-call deadline'), PER_CALL_DEADLINE_MS);
    try {
      await runtime.processMessage(item.phrase, { userId: 'synthetic-probe-user', state: { services: { doordash: bridge } } });
      const pass = item.expected === null ? captured.length === 0
        : captured.length === 1 && captured[0]!.action === item.expected && item.accepts(captured[0]!.params);
      if (!pass) failures += 1;
      report({ phrase: item.phrase, action: captured.map((entry) => entry.action), pass, ...timing() });
    } catch {
      failures += 1;
      report({ phrase: item.phrase, action: captured.map((entry) => entry.action), pass: false, reason: 'generation or isolation failure', ...timing() });
      break;
    } finally {
      clearTimeout(callDeadline);
      callDeadline = undefined;
    }
  }
  report({ calls: generationCalls, pass: failures === 0 });
  process.exitCode = failures ? 1 : 0;
} catch {
  report({ pass: false, reason: 'probe initialization failure' });
  process.exitCode = 1;
} finally {
  clearTimeout(callDeadline);
  clearTimeout(overallDeadline);
  clearInterval(progress);
  restorePlugin();
  process.stdout.write = savedStdout;
  process.stderr.write = savedStderr;
  for (const [key, value] of savedConsole) console[key] = value;
}
