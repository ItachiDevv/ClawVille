/**
 * Manual staging-only language probe. No database, dd-cli, or real cart access.
 * bun apps/api/scripts/doordash/natural-chat-probe.ts --allow-inference
 * Add --item-choices for a synthetic customization sequence, never a real cart.
 * Uses actual processMessage, action descriptions, parsing, and handlers.
 * The memory adapter and vendor bridge are synthetic. The existing text-provider
 * plugin performs real inference through the hosted-user InferenceRouter route.
 */
export {};
const emit = process.stdout.write.bind(process.stdout);
const report = (value: unknown) => emit(`${JSON.stringify(value)}\n`);
const itemChoiceMode = process.argv.includes('--item-choices');

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
const OVERALL_DEADLINE_MS = itemChoiceMode ? 480_000 : 360_000;
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
  const { buildEndpointsFromEnv, buildRouteTableFromEnv, getInferenceRouter } = await import('../../../../packages/agent-runtime/src/inference/inference-config');
  const { doordashSearchAction, doordashMenuAction, doordashCartAction } = await import('../../../../packages/agent-runtime/src/actions/doordash');
  const { resolveStoreReference, resolveItemByName } = await import('../../src/services/doordash-session');
  const { resolveChoices, describeGaps, isChoiceReviewConfirmation } = await import('../../src/services/doordash-options');
  const { classifySyntheticChoiceReply, isSafeSyntheticChoiceClarification } = await import('./natural-chat-probe-assertions');
  type ChoiceDraft = import('../../src/services/doordash-options').ChoiceDraft;
  type DdOptionGroup = import('../../src/services/doordash-options').DdOptionGroup;
  type FixtureContext = Parameters<typeof resolveStoreReference>[0];
  const oldActions = clawvillePlugin.actions;
  const oldProviders = clawvillePlugin.providers;
  restorePlugin = () => {
    clawvillePlugin.actions = oldActions;
    clawvillePlugin.providers = oldProviders;
  };
  // Never expose address, preview, submit, or arbitrary world actions. CART can
  // only call this process's synthetic fixture in the explicit item mode.
  clawvillePlugin.actions = itemChoiceMode ? [doordashCartAction] : [doordashSearchAction, doordashMenuAction];
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

  type Captured = { action: 'SEARCH' | 'MENU' | 'CART'; params: Record<string, unknown>;
    resolution?: { kind: string; targetsSecondFixture: boolean } };
  const captured: Captured[] = [];
  let modelActionNames: string[] = [];
  let fixtureContext: FixtureContext = { lastStores: [] };
  const normalize = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  const itemFixture = { itemId: 'fixture-italian', name: 'Synthetic Italian Sandwich', hasModifiers: true, hasRequired: true };
  const optionGroups: DdOptionGroup[] = [
    { extra_id: 'fixture-bread', title: 'Synthetic bread choice', min_num_options: 1, max_num_options: 1,
      options: [{ option_id: 'fixture-white', name: 'White Bread' }, { option_id: 'fixture-wheat', name: 'Wheat' }] },
    { extra_id: 'fixture-size', title: 'Synthetic size choice', min_num_options: 1, max_num_options: 1,
      options: [{ option_id: 'fixture-small', name: 'Small' }, { option_id: 'fixture-large', name: 'Large' }] },
    { extra_id: 'fixture-cheese', title: 'Synthetic cheese choice', min_num_options: 1, max_num_options: 1,
      options: [{ option_id: 'fixture-provolone', name: 'Provolone' }, { option_id: 'fixture-swiss', name: 'Swiss' }] },
    { extra_id: 'fixture-sauce', title: 'Synthetic sauce choice', min_num_options: 0, max_num_options: 1,
      options: [{ option_id: 'fixture-mayo', name: 'Mayo' }, { option_id: 'fixture-no-mayo', name: 'No Mayo' }] },
  ];
  let pending: { draft: ChoiceDraft; quantity: number; stage: 'choices' | 'review' } | undefined;
  const syntheticAdds: Array<{ itemId: string; quantity: number; optionIds: string[] }> = [];
  const expectedOptionIds = ['fixture-wheat', 'fixture-large', 'fixture-provolone', 'fixture-no-mayo'];
  const finalSyntheticSelectionMatches = () => syntheticAdds.length === 1
    && syntheticAdds[0]!.itemId === itemFixture.itemId && syntheticAdds[0]!.quantity === 1
    && JSON.stringify(syntheticAdds[0]!.optionIds) === JSON.stringify(expectedOptionIds);
  const safeParameterValue = (key: string, value: unknown) => {
    const normalized = normalize(value);
    if (!normalized) return 'omitted';
    const known = key === 'query'
      ? ['pizza', 'taco', 'tacos', 'drink', 'drinks', 'beverage', 'beverages', 'hoagie', 'hoagies', 'food', 'full menu', 'menu', 'all', 'everything']
      : key === 'storeName'
        ? ['the second one', 'second one', 'second', '2', '2nd', 'number 2', 'they', 'them', 'their', 'their menu', 'there', 'it', 'that', 'that one', 'that place', 'the selected restaurant', 'wawa']
        : ['fixture-a', 'fixture-b'];
    return known.includes(normalized) ? normalized : 'other-value-redacted';
  };
  const classify = (entry: Captured) => ({
    action: entry.action,
    suppliedKeys: ['storeName', 'storeId', 'query'].filter((key) => Boolean(entry.params[key])),
    storeName: safeParameterValue('storeName', entry.params.storeName),
    storeId: safeParameterValue('storeId', entry.params.storeId),
    query: safeParameterValue('query', entry.params.query),
    ...(entry.resolution ? { referenceResolution: entry.resolution } : {}),
  });
  const classifyItem = (entry: Captured) => {
    const words = normalize(entry.params.choices);
    const allowed = ['white bread', 'actually wheat', 'wheat', 'make it large', 'large', 'provolone', 'no mayo', 'mayo', 'add it', 'yes'];
    const named = typeof entry.params.itemName === 'string'
      ? resolveItemByName({ lastStores: [], lastItems: [itemFixture] }, entry.params.itemName) : null;
    return {
      action: entry.action,
      suppliedKeys: ['itemName', 'itemId', 'choices', 'quantity', 'storeId', 'menuId', 'cartUuid']
        .filter(key => entry.params[key] !== undefined),
      itemReference: named && 'item' in named && named.item.itemId === itemFixture.itemId ? 'exact-fixture-item' : named ? 'unresolved' : 'omitted',
      choices: words ? allowed.includes(words) ? words : 'other-value-redacted' : 'omitted',
      quantity: Number.isInteger(entry.params.quantity) && Number(entry.params.quantity) >= 1 && Number(entry.params.quantity) <= 20
        ? entry.params.quantity : entry.params.quantity === undefined ? 'omitted' : 'other-value-redacted',
    };
  };
  const memories: Array<{ roomId: string; entityId: string; content: { text: string }; createdAt?: number }> = [];
  const bridge = {
    cartAdd: async (params: { itemName?: string; itemId?: string; choices?: string; quantity?: number;
      storeId?: string; menuId?: string; cartUuid?: string }) => {
      captured.push({ action: 'CART', params });
      const refuse = (reason: string) => ({ ok: false as const, failure: 'doordash_needs_choices', reason, detail: reason, durationMs: 0 });
      if (params.itemId || params.storeId || params.menuId || params.cartUuid) return refuse('Use the item name, not an identifier.');
      if (params.itemName) {
        const match = resolveItemByName({ lastStores: [], lastItems: [itemFixture] }, params.itemName);
        if (!match || !('item' in match) || match.item.itemId !== itemFixture.itemId) {
          pending = undefined;
          return refuse('Which item would you like?');
        }
        pending = { draft: { groups: [], blockedGroupIds: [] }, quantity: params.quantity ?? 1, stage: 'choices' };
      }
      if (!pending) return refuse('Tell me which item you would like first.');
      if (params.quantity !== undefined) pending.quantity = params.quantity;
      const confirms = pending.stage === 'review' && isChoiceReviewConfirmation(params.choices ?? '')
        && isChoiceReviewConfirmation(currentPhrase);
      // The real resolver owns all option matching, correction, and revalidation.
      // This small fixture owns synthetic review/add state only. Operator tests
      // separately cover live item lookup, mutation locks, and preview revocation.
      const result = resolveChoices(optionGroups, confirms ? '' : params.choices ?? '', pending.draft);
      pending.draft = result.draft;
      if (!result.ok) {
        pending.stage = 'choices';
        return refuse(describeGaps(itemFixture.name, result));
      }
      if (!confirms) {
        pending.stage = 'review';
        return refuse(`${itemFixture.name}: ${result.picked.join(', ')}. Add this to your cart? You can still tell me a change.`);
      }
      syntheticAdds.push({ itemId: itemFixture.itemId, quantity: pending.quantity, optionIds: result.nested.map(option => option.id) });
      const quantity = pending.quantity;
      pending = undefined;
      return { ok: true as const, durationMs: 0, data: { cartUuid: 'synthetic-cart', storeName: 'Synthetic Harbor Deli',
        items: [{ lineId: 'synthetic-line', name: itemFixture.name, quantity }], droppedItems: 0, addedChoices: result.picked } };
    },
    search: async (params: { query: string }) => {
      captured.push({ action: 'SEARCH', params });
      fixtureContext = { lastStores: [
        { storeId: 'fixture-a', storeName: 'Synthetic Orchard Cafe' },
        { storeId: 'fixture-b', storeName: 'Synthetic Harbor Pizza' },
      ] };
      return { ok: true, durationMs: 0, data: { stores: [
        { store_id: 'fixture-a', store_name: 'Synthetic Orchard Cafe' },
        { store_id: 'fixture-b', store_name: 'Synthetic Harbor Pizza' },
      ] } };
    },
    menu: async (params: { storeName?: string; storeId?: string; query?: string }) => {
      // Use the production reference resolver on synthetic context. Acceptance
      // checks the captured target before any fixture selection changes.
      const reference = resolveStoreReference(fixtureContext, params.storeName ?? '');
      captured.push({ action: 'MENU', params, resolution: {
        kind: params.storeId ? 'explicit-id' : reference.kind,
        targetsSecondFixture: !params.storeId && reference.kind === 'store' && reference.storeId === 'fixture-b',
      } });
      if (!params.storeId && reference.kind === 'store') {
        fixtureContext.menuSelection = { storeId: reference.storeId, storeName: reference.storeName };
      }
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
        if (generationCalls > (itemChoiceMode ? 12 : 8)) throw new Error('Generation budget exceeded');
        // A failure here must not print the prompt or any catalog text.
        if (prompt.includes('Synthetic Orchard') || prompt.includes('Synthetic Harbor')
          || prompt.includes('Synthetic Italian') || prompt.includes('Synthetic bread choice')
          || prompt.includes('Synthetic size choice') || prompt.includes('Synthetic cheese choice')
          || prompt.includes('Synthetic sauce choice') || prompt.includes('fixture-italian')
          || prompt.includes('synthetic-cart') || prompt.includes('synthetic-line')
          || prompt.includes('DOORDASH_SUBMIT') || (!itemChoiceMode && prompt.includes('DOORDASH_CART'))
          || (itemChoiceMode && (prompt.includes('DOORDASH_PREVIEW') || prompt.includes('DOORDASH_MENU') || prompt.includes('DOORDASH_SEARCH')))) {
          throw new Error('Prompt isolation failed');
        }
        phase = 'provider-generation';
        providerStartedAt = Date.now();
        report({ phrase: currentPhrase, status: 'provider-start', ...timing() });
        const router = getInferenceRouter();
        const usageBefore = new Map(router.usageSnapshot().rows.map((row) => [`${row.route}|${row.endpointId}|${row.model}`, row.calls]));
        const text = await generate({} as never, { ...params, prompt, maxTokens: 350 } as never);
        // Names only distinguish a missing action from an empty/invalid CART
        // invocation that the real handler refuses before calling the fixture.
        modelActionNames = [...String(text).matchAll(/\[ACTION:\s*([A-Z_]+)/g)].map(match =>
          ['DOORDASH_CART', 'DOORDASH_MENU', 'DOORDASH_SEARCH', 'DOORDASH_PREVIEW', 'DOORDASH_SUBMIT'].includes(match[1]!)
            ? match[1]! : 'other-action');
        phase = 'action-dispatch';
        const servedModels = router.usageSnapshot().rows
          .filter((row) => row.calls > (usageBefore.get(`${row.route}|${row.endpointId}|${row.model}`) ?? 0))
          .map((row) => safeModel(row.model));
        report({ phrase: currentPhrase, status: 'provider-returned', servedModels, ...timing() });
        return { text: String(text) };
      },
    },
  });
  type Case = { phrase: string; expected: Captured['action'] | null; reset?: boolean;
    inspectReply?: boolean; allowsClarification?: boolean; accepts: (entry: Captured) => boolean };
  // Live diagnostics showed that retaining "the second one" is supported by
  // the production resolver. Judge the selected restaurant, not one preferred
  // spelling of the same request. Unknown references and invented IDs fail.
  const targetsSelectedFixture = (entry: Captured) => !entry.params.storeId
    && entry.resolution?.kind === 'store' && entry.resolution.targetsSecondFixture;
  const menuCases: Case[] = [
    { phrase: 'I feel like pizza. Can you find somewhere?', expected: 'SEARCH', reset: true,
      accepts: ({ params: p }) => String(p.query).trim().toLowerCase() === 'pizza' },
    { phrase: 'The second one, please.', expected: 'MENU',
      accepts: targetsSelectedFixture },
    { phrase: 'What drinks do they have?', expected: 'MENU',
      accepts: (entry) => targetsSelectedFixture(entry) && /^(drinks?|beverages?)$/i.test(String(entry.params.query)) },
    { phrase: 'Show me their full menu.', expected: 'MENU',
      accepts: (entry) => targetsSelectedFixture(entry) && !entry.params.query },
    { phrase: 'What hoagies does Wawa have?', expected: 'MENU', reset: true,
      accepts: ({ params: p }) => /^wawa$/i.test(String(p.storeName)) && /^hoagies?$/i.test(String(p.query)) && !p.storeId },
    { phrase: 'Can we get tacos?', expected: 'SEARCH', reset: true,
      accepts: ({ params: p }) => /^tacos?$/i.test(String(p.query)) },
    { phrase: 'Hello, how are you today?', expected: null, reset: true, accepts: () => true },
  ];
  const choicesOnly = (entry: Captured, adds: number) =>
    !entry.params.itemId && !entry.params.itemName && !entry.params.storeId && !entry.params.menuId
    && !entry.params.cartUuid && entry.params.quantity === undefined
    && typeof entry.params.choices === 'string' && Boolean(entry.params.choices.trim()) && syntheticAdds.length === adds;
  const sameIds = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  const choiceReply = (currentId: string, retainedIds: string[] | null, stage: 'choices' | 'review' | 'none', adds = 0) => (entry: Captured) => {
    if (!choicesOnly(entry, adds)) return false;
    // Judge production resolver semantics, not preferred model wording. Resolve
    // the current answer alone too: it must not reconstruct previous groups.
    const current = resolveChoices(optionGroups, String(entry.params.choices));
    if (current.draft.unresolvedRequest || !sameIds(current.draft.groups.flatMap(group => group.optionIds), [currentId])) return false;
    return (pending?.stage ?? 'none') === stage && (retainedIds === null ? pending === undefined
      : Boolean(pending) && !pending!.draft.unresolvedRequest
        && sameIds(pending!.draft.groups.flatMap(group => group.optionIds), retainedIds));
  };
  const choiceCases: Case[] = [
    { phrase: "I'll have the Italian.", expected: 'CART', reset: true,
      accepts: ({ params }) => Boolean(params.itemName) && !params.itemId && !params.storeId && !params.menuId
        && !params.cartUuid && !params.choices && (params.quantity === undefined || params.quantity === 1)
        && pending?.stage === 'choices' && syntheticAdds.length === 0 },
    { phrase: 'white bread', expected: 'CART', accepts: choiceReply('fixture-white', ['fixture-white'], 'choices') },
    { phrase: 'actually wheat', expected: 'CART', accepts: choiceReply('fixture-wheat', ['fixture-wheat'], 'choices') },
    { phrase: 'make it large', expected: 'CART', accepts: choiceReply('fixture-large', ['fixture-wheat', 'fixture-large'], 'choices') },
    { phrase: 'provolone', expected: 'CART', accepts: choiceReply('fixture-provolone', ['fixture-wheat', 'fixture-large', 'fixture-provolone'], 'review') },
    { phrase: 'no mayo', expected: 'CART', accepts: choiceReply('fixture-no-mayo', expectedOptionIds, 'review') },
    { phrase: 'add it', expected: 'CART', accepts: entry => choicesOnly(entry, 1)
      && isChoiceReviewConfirmation(String(entry.params.choices)) && finalSyntheticSelectionMatches() && pending === undefined },
    // The diagnostic run clarified whether the user meant another item, without
    // claiming a change. A repeated satisfied request does not require an action.
    { phrase: 'no mayo', expected: 'CART', inspectReply: true, allowsClarification: true,
      accepts: choiceReply('fixture-no-mayo', null, 'none', 1) },
    { phrase: 'Hello, how are you today?', expected: null, accepts: () => true },
  ];
  const cases = itemChoiceMode ? choiceCases : menuCases;
  if (cases.length > 10) throw new Error('Logical turn budget exceeded');
  let failures = 0;
  for (const item of cases) {
    currentPhrase = item.phrase;
    turnStartedAt = Date.now();
    providerStartedAt = 0;
    phase = 'process-message';
    if (item.reset) {
      memories.length = 0;
      fixtureContext = { lastStores: [] };
    }
    captured.length = 0;
    modelActionNames = [];
    callDeadline = setTimeout(() => stop('per-call deadline'), PER_CALL_DEADLINE_MS);
    try {
      const response = await runtime.processMessage(item.phrase, { userId: 'synthetic-probe-user',
        state: { services: { doordash: itemChoiceMode ? { cartAdd: bridge.cartAdd } : bridge } } });
      const guardedActionPass = captured.length === 1 && captured[0]!.action === item.expected && item.accepts(captured[0]!);
      const clarificationPass = Boolean(item.allowsClarification) && captured.length === 0 && modelActionNames.length === 0
        && pending === undefined && finalSyntheticSelectionMatches() && isSafeSyntheticChoiceClarification(response.content);
      const pass = item.expected === null ? captured.length === 0 : guardedActionPass || clarificationPass;
      if (!pass) failures += 1;
      report({ phrase: item.phrase, action: captured.map((entry) => entry.action),
        ...(itemChoiceMode ? { modelActions: modelActionNames, parameters: captured.map(classifyItem), syntheticAdds: syntheticAdds.length, draftStage: pending?.stage ?? 'none' }
          : { parameters: captured.map(classify) }),
        ...(itemChoiceMode && item.inspectReply ? { replyFlags: classifySyntheticChoiceReply(response.content), clarificationAccepted: clarificationPass } : {}), pass, ...timing() });
    } catch {
      failures += 1;
      report({ phrase: item.phrase, action: captured.map((entry) => entry.action), pass: false, reason: 'generation or isolation failure', ...timing() });
      break;
    } finally {
      clearTimeout(callDeadline);
      callDeadline = undefined;
    }
  }
  if (itemChoiceMode && !finalSyntheticSelectionMatches()) failures += 1;
  report({ calls: generationCalls, pass: failures === 0,
    ...(itemChoiceMode ? { syntheticAdds: syntheticAdds.length, finalSelectionMatches: finalSyntheticSelectionMatches(),
      finalOptionIds: finalSyntheticSelectionMatches() ? expectedOptionIds : [], finalQuantity: finalSyntheticSelectionMatches() ? 1 : null } : {}) });
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
