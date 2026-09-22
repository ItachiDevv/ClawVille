import { afterEach, expect, spyOn, test } from 'bun:test';
import { collectChanges, evaluate, eventRange, loadRegistry, parseGate } from './run-coupling-gates';

const gates = loadRegistry(process.cwd());
const nori = gates.find((g) => g.id === 'gameplay-change-updates-nori-knowledge')!;
const executor = gates.find((g) => g.id === 'action-whitelist-bumps-protocol-version')!;
const source = 'apps/api/src/services/npc-simulation.ts';
const doc = 'packages/agent-templates/src/locations/town-guide.ts';
const A = 'a'.repeat(40), B = 'b'.repeat(40);
let spawn: ReturnType<typeof spyOn> | undefined;
afterEach(() => { spawn?.mockRestore(); spawn = undefined; });

test('independent: required documents must change content and survive the diff', () => {
  for (const after of [null, '', 'old']) {
    const result = evaluate([nori], [
      { path: 'apps/api/src/routes/cove-slots.ts', before: 'old', after: 'new' },
      { path: doc, before: 'old', after },
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
  }
});

test('independent: rename-only document replacement cannot satisfy an update', () => {
  expect(evaluate([nori], [
    { path: 'apps/api/src/routes/cove-slots.ts', before: 'old', after: 'new' },
    { path: 'old-guide.ts', before: 'same', after: null },
    { path: doc, before: null, after: 'same' },
  ]).errors.length).toBeGreaterThan(0);
});

test('independent: exact escape waives only the Nori gate', () => {
  const changes = [{ path: 'apps/api/src/routes/cove-slots.ts', before: 'old', after: 'new' }];
  for (const text of ['prefix [skip-nori-update]', '[skip-nori-update] suffix', ' [skip-nori-update]', '[skip-nori-update-extra]']) {
    expect(evaluate([nori], changes, text).errors.length).toBeGreaterThan(0);
  }
  const result = evaluate(gates, changes, 'reason\n\n[skip-nori-update]');
  expect(result.warnings).toHaveLength(1);
  expect(result.errors.some((s) => s.startsWith('gameplay-updates-connection-skillmd:'))).toBe(true);
});

test('independent: executor edits with unrecognized indentation fail closed', () => {
  const result = evaluate([executor], [{ path: source,
    before: 'class Simulation {\n    private executeHatcherAction() {\n      allowOld();\n    }\n}',
    after: 'class Simulation {\n    private executeHatcherAction() {\n      allowNew();\n    }\n}',
  }]);
  expect(result.triggered).toContain(executor.id);
  expect(result.errors.some((s) => s.includes('strictly increases'))).toBe(true);
});

test('independent: binary asset edits retain byte identity', () => {
  spawn = spyOn(Bun, 'spawnSync').mockImplementation((args: any) => {
    const cmd = args[3];
    const output = cmd === 'diff' ? Buffer.from('apps/web/public/models/a.glb\0')
      : cmd === 'ls-tree' ? Buffer.from('100644 blob dummy\ta.glb\0')
      : cmd === 'show' ? Buffer.from([String(args[4]).startsWith(A) ? 0x80 : 0x81])
      : Buffer.alloc(0);
    return { exitCode: 0, stdout: output, stderr: Buffer.alloc(0) } as any;
  });
  const changes = collectChanges(process.cwd(), A, B);
  expect(changes).toHaveLength(1);
  expect(changes[0].before).not.toBe(changes[0].after);
  expect(evaluate(gates, changes).errors.some((s) => s.startsWith('three-d-updates-3dstructure:'))).toBe(true);
});

test('independent: immutable event ranges and missing-base failures', () => {
  expect(eventRange({ pull_request: { base: { sha: A }, head: { sha: B } } }, 'pull_request', 'unused'))
    .toEqual({ base: A, head: B, mergeBase: true });
  expect(eventRange({ before: A, after: B }, 'push', 'unused'))
    .toEqual({ base: A, head: B, mergeBase: false });
  for (const name of ['workflow_dispatch', 'workflow_call']) {
    expect(() => eventRange({}, name, B)).toThrow();
    expect(eventRange({}, name, B, A)).toEqual({ base: A, head: B, mergeBase: false });
  }
  expect(() => eventRange({ before: '0'.repeat(40), after: B }, 'push', B)).toThrow();
  expect(() => eventRange({}, 'pull_request_target', B)).toThrow();
});

test('independent: malformed registry entries fail closed', () => {
  const encode = (gate: unknown) => `---\n${JSON.stringify(gate)}\n---\nRule\n`;
  for (const patch of [
    { unknown: true }, { trigger: [] }, { requires: [] }, { requires: [[]] },
    { trigger: ['../escape'] }, { trigger: ['/absolute'] }, { trigger: ['a/**bad/b'] },
    { selector: 'execute-command' }, { assertion: 'shell' }, { mechanism: 'advisory' },
    { status: 'disabled' }, { escapeHatch: '[skip-everything]' },
  ]) expect(() => parseGate(encode({ ...nori, ...patch }), `${nori.id}.md`)).toThrow();
  expect(() => parseGate(encode(nori), 'wrong-name.md')).toThrow();
});

test('independent: protocol removal, expression, equal value and downgrade cannot authorize action edits', () => {
  for (const after of [null, 'export const PROTOCOL_VERSION = 68;', 'export const PROTOCOL_VERSION = 67;', 'export const PROTOCOL_VERSION = 68 + 1;']) {
    const result = evaluate([executor], [
      { path: 'packages/shared/src/constants/hatcher-actions.ts', before: 'old', after: 'new' },
      { path: 'apps/api/src/services/skill-protocol.ts', before: 'export const PROTOCOL_VERSION = 68;', after },
    ]);
    expect(result.errors.some((s) => s.includes('strictly increases'))).toBe(true);
  }
});
