import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { collectChanges, evaluate, eventRange, git, loadRegistry, parseGate, PROTOCOL, REQUIRED_IDS, type Change } from './run-coupling-gates';

const root = resolve(import.meta.dir, '../..');
const gates = loadRegistry(root);
const changed = (path: string, before = 'old', after: string | null = 'new'): Change => ({ path, before, after });
const rule = (id: string) => gates.find((gate) => gate.id === id)!;
const nori = rule(REQUIRED_IDS[0]);
const protocol = rule('action-whitelist-bumps-protocol-version');
const menu = 'packages/shared/src/constants/hatcher-actions.ts';
const guide = 'packages/agent-templates/src/locations/town-guide.ts';
const serialize = (value: unknown) => `---\n${JSON.stringify(value)}\n---\nRule.\n`;
const shaA = 'a'.repeat(40); const shaB = 'b'.repeat(40);

describe('coupling registry and changed-content contracts', () => {
  test('all fourteen declared contracts are active and every required group matters', () => {
    expect(gates).toHaveLength(14);
    for (const gate of gates) {
      const trigger = gate.trigger[0].replaceAll('**', 'fixture').replaceAll('*', 'fixture').replaceAll('?', 'x');
      let mutation = changed(trigger);
      if (gate.selector === 'architecture') mutation.before = null;
      if (gate.selector === 'new-env') mutation.after = 'process.env.NEW_FIXTURE_KEY';
      if (gate.selector === 'protocol-version') mutation = changed(PROTOCOL, 'export const PROTOCOL_VERSION = 1;', 'export const PROTOCOL_VERSION = 2;');
      if (gate.selector === 'executor') mutation = changed(menu);
      expect(evaluate([gate], [mutation]).errors.length).toBeGreaterThan(0);
    }
  });
  test('the flagship Cove edit needs changed Nori knowledge, not an existing file', () => {
    const edit = changed('apps/api/src/routes/cove-slots.ts');
    expect(evaluate([nori], [edit]).errors[0]).toContain('gameplay-change-updates-nori-knowledge: change');
    expect(evaluate([nori], [edit, changed(guide, 'same', 'same')]).errors).toHaveLength(1);
    expect(evaluate([nori], [edit, changed(guide, 'old', null)]).errors).toHaveLength(1);
    expect(evaluate([nori], [edit, changed(guide, 'old', '   ')]).errors).toHaveLength(1);
    expect(evaluate([nori], [edit, changed(guide)]).errors).toHaveLength(0);
    expect(evaluate([nori], [edit, changed('packages/shared/src/constants/orientation-skill.ts')]).errors).toHaveLength(0);
  });
  test('trading UI removal and casino engine edits require Nori and connection knowledge', () => {
    for (const path of ['apps/web/src/components/game/trading-floor/trading-floor-tab.tsx', 'apps/api/src/services/blackjack-engine.ts']) {
      const result = evaluate([nori, rule('gameplay-updates-connection-skillmd')], [changed(path)]);
      expect(result.errors).toHaveLength(2);
    }
  });
  test('deleting source triggers its rule; rename-only target does not satisfy it', () => {
    const edit = changed('apps/api/src/routes/cove-slots.ts', 'old', null);
    expect(evaluate([nori], [edit]).errors).toHaveLength(1);
    expect(evaluate([nori], [edit, { path: guide, before: null, after: 'identical' }, changed('old-guide.ts', 'identical', null)]).errors).toHaveLength(1);
  });
  test('docs-only changes do not arm product couplings', () => {
    expect(evaluate(gates, [changed('README.md')])).toEqual({ errors: [], warnings: [], triggered: [] });
  });
  test('only the exact final-message escape line waives Nori and emits a warning', () => {
    const edits = [changed('apps/api/src/routes/cove-slots.ts')];
    for (const message of ['quoted [skip-nori-update]', '[skip-nori-update-extra]', ' [skip-nori-update]']) {
      expect(evaluate([nori], edits, message).errors).toHaveLength(1);
    }
    const result = evaluate([nori, rule('gameplay-updates-connection-skillmd')], edits, 'subject\n\n[skip-nori-update]\n');
    expect(result.warnings).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('gameplay-updates-connection-skillmd');
  });
  test('whitelist changes reject unchanged, deleted, decreased, malformed and duplicate versions', () => {
    for (const after of [null, 'export const PROTOCOL_VERSION = 5;', 'export const PROTOCOL_VERSION = 4;', 'export const PROTOCOL_VERSION = 5 + 1;', 'export const PROTOCOL_VERSION = 6;\nexport const PROTOCOL_VERSION = 7;']) {
      expect(evaluate([protocol], [changed(menu), changed(PROTOCOL, 'export const PROTOCOL_VERSION = 5;', after)]).errors.length).toBeGreaterThan(0);
    }
    expect(evaluate([protocol], [changed(menu), changed(PROTOCOL, 'export const PROTOCOL_VERSION = 5;', 'export const PROTOCOL_VERSION = 6;')]).errors).toHaveLength(0);
  });
  test('unrelated NPC edits do not require a version bump when both known methods remain stable', () => {
    const methods = '\n  dispatchHatcherActions() {\n    return 1;\n  }\n  private executeHatcherAction() {\n    return 2;\n  }\n';
    expect(evaluate([protocol], [changed('apps/api/src/services/npc-simulation.ts', '// old'+methods, '// new'+methods)]).triggered).toHaveLength(0);
    expect(evaluate([protocol], [changed('apps/api/src/services/npc-simulation.ts', methods, methods.replace('return 2', 'return 3'))]).errors.length).toBeGreaterThan(0);
  });
  test('new literal bracket and dot env keys require architecture; old keys do not', () => {
    const gate = rule('env-var-updates-architecture');
    for (const after of ['process.env.NEW_KEY', "process.env['NEW_KEY']", 'process.env["NEW_KEY"]']) {
      expect(evaluate([gate], [changed('apps/api/src/services/x.ts', '', after)]).errors).toHaveLength(1);
    }
    expect(evaluate([gate], [changed('apps/api/src/services/x.ts', 'process.env.OLD_KEY', 'process.env.OLD_KEY || 1')]).errors).toHaveLength(0);
  });
  test('unknown or empty registry fields fail closed', () => {
    for (const mutation of [{ unknown: true }, { mechanism: 'static' }, { status: 'disabled' }, { trigger: [] }, { requires: [[]] }, { selector: 'typo' }, { assertion: 'shell-command' }, { trigger: ['../escape'] }, { trigger: ['/absolute'] }, { trigger: ['apps/**bad.ts'] }]) {
      expect(() => parseGate(serialize({ ...nori, ...mutation }), `${nori.id}.md`)).toThrow();
    }
    expect(() => parseGate(serialize({ ...rule('three-d-updates-3dstructure'), escapeHatch: '[skip-nori-update]' }), 'three-d-updates-3dstructure.md')).toThrow();
  });
});

describe('immutable CI ranges', () => {
  test('PR uses immutable base/head; push uses entire before/after range', () => {
    expect(eventRange({ pull_request: { base: { sha: shaA }, head: { sha: shaB } } }, 'pull_request', 'merge-ref'))
      .toEqual({ base: shaA, head: shaB, mergeBase: true });
    expect(eventRange({ before: shaA, after: shaB }, 'push', shaB)).toEqual({ base: shaA, head: shaB, mergeBase: false });
  });
  test('dispatch requires an explicit complete base and unknown/zero events fail', () => {
    expect(() => eventRange({}, 'workflow_dispatch', shaB)).toThrow();
    expect(() => eventRange({ before: '0'.repeat(40), after: shaB }, 'push', shaB)).toThrow();
    expect(() => eventRange({}, 'schedule', shaB)).toThrow();
    expect(eventRange({}, 'workflow_dispatch', shaB, shaA).base).toBe(shaA);
  });
  test('actual Git collection includes earlier commits and unchanged-doc rename stays rejected', () => {
    const fixturesRoot = resolve(root, '.coupling-test-fixtures');
    const fixture = resolve(fixturesRoot, randomUUID());
    mkdirSync(fixture, { recursive: true });
    const put = (path: string, text: string) => { const file = resolve(fixture, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
    const commit = (message: string) => { git(fixture, ['add', '.']); git(fixture, ['-c', 'user.name=Coupling Test', '-c', 'user.email=coupling@example.invalid', 'commit', '-qm', message]); return git(fixture, ['rev-parse', 'HEAD']).trim(); };
    try {
      git(fixture, ['init', '-q']);
      git(fixture, ['config', 'core.hooksPath', '.git/no-hooks']);
      put('README.md', 'base'); put('old-guide.ts', 'same guide');
      const base = commit('base');
      put('apps/api/src/routes/cove-slots.ts', 'new feature'); commit('feature');
      put('README.md', 'last commit docs only'); const head = commit('docs');
      expect(evaluate([nori], collectChanges(fixture, base, head)).errors).toHaveLength(1);
      git(fixture, ['mv', 'old-guide.ts', 'renamed-guide.ts']);
      const renamed = commit('rename');
      const changes = collectChanges(fixture, head, renamed);
      expect(changes.find((change) => change.path === 'old-guide.ts')?.after).toBeNull();
      expect(changes.find((change) => change.path === 'renamed-guide.ts')?.before).toBeNull();
    } finally {
      if (!fixture.startsWith(fixturesRoot + sep)) throw new Error('Unsafe fixture cleanup path');
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 20_000);
});
