import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// Like chat-moderation.test.ts, avoid router imports and their DB/auth boot effects.
// Execute the ACTUAL source statements with boundary mocks, not a copied handler.
function wiring(file: string, route: string, declarations: string[]) {
  const source = ts.createSourceFile(file, readFileSync(join(import.meta.dir, '..', file), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let handler: ts.ArrowFunction | undefined;
  function findRoute(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'post' && node.arguments[0]?.getText(source) === route) {
      const last = node.arguments.at(-1);
      if (last && ts.isArrowFunction(last)) handler = last;
    }
    ts.forEachChild(node, findRoute);
  }
  findRoute(source);
  if (!handler) throw new Error(`Missing chat handler: ${file}`);
  const statements = new Map<string, string>();
  function findDeclarations(node: ts.Node): void {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declarations.includes(declaration.name.text)) {
          if (statements.has(declaration.name.text)) throw new Error('Ambiguous wiring declaration');
          statements.set(declaration.name.text, node.getText(source));
        }
      }
    }
    ts.forEachChild(node, findDeclarations);
  }
  findDeclarations(handler);
  const code = declarations.map((name) => {
    const statement = statements.get(name);
    if (!statement) throw new Error(`Missing wiring declaration: ${name}`);
    return statement;
  }).join('\n');
  return {
    code,
    handler: handler.getText(source),
    imports: source.statements.filter(ts.isImportDeclaration).map((node) => node.getText(source)).join('\n'),
  };
}

const human = wiring('avatars.ts', "'/me/chat'", ['ddSubject', 'services']);
const agent = wiring('agent-gateway.ts', 'AGENT_CHAT_ROUTE', ['dd', 'ddSubject', 'services']);
type Identity = { userId: string | null; avatarId: string | null; ledgerCapable?: boolean | null } | null;

async function execute(code: string, inputs: Record<string, unknown>, allowed: boolean) {
  const subject = { userId: 'founder', avatarId: 'bound-avatar', canSubmit: false };
  const bridge = { subject, requesterTurn: 'test bridge' };
  const resolveDoordashOperator = mock(() => allowed ? subject : null);
  const buildDoordashBridge = mock(() => bridge);
  const buildRuntimeServices = mock((_db: unknown, opts: { actorKind: string; doordash?: unknown }) => opts);
  const db = { boundary: 'database' };
  const dependencies = { ...inputs, db, resolveDoordashOperator, buildDoordashBridge, buildRuntimeServices };
  const run = new Function(...Object.keys(dependencies), `return (async () => { ${code}\nreturn services; })();`);
  const services = await run(...Object.values(dependencies));
  return { subject, bridge, db, services, resolveDoordashOperator, buildDoordashBridge, buildRuntimeServices };
}

describe('DoorDash chat capability wiring', () => {
  it('imports the operator gate and bridge from the real service on both paths', () => {
    for (const route of [human, agent]) {
      expect(route.imports).toContain("import { resolveDoordashOperator, buildDoordashBridge } from '../services/doordash-operator'");
    }
    expect(agent.imports).toMatch(/import\s*\{[^}]*resolveAgentSession[^}]*\}\s*from '\.\.\/middleware\/require-auth-or-agent'/);
  });

  for (const allowed of [true, false]) {
    it(`human path ${allowed ? 'attaches' : 'omits'} the bridge according to the operator resolver`, async () => {
      const user = { id: allowed ? 'founder' : 'other-user' };
      const avatar = { id: 'human-avatar' };
      const content = '  pizza\nKeep my raw requester text.  ';
      const result = await execute(human.code, { user, avatar, result: { data: { content } } }, allowed);
      expect(result.resolveDoordashOperator).toHaveBeenCalledWith({ kind: 'human', userId: user.id, avatarId: avatar.id });
      expect(result.buildRuntimeServices).toHaveBeenCalledWith(result.db, {
        actorKind: 'human', doordash: allowed ? result.bridge : undefined,
      });
      expect(result.services.doordash).toBe(allowed ? result.bridge : undefined);
      if (allowed) expect(result.buildDoordashBridge).toHaveBeenCalledWith(result.subject, content);
      else expect(result.buildDoordashBridge).not.toHaveBeenCalled();
    });
  }

  const cases: Array<{ name: string; identity: Identity; allowed: boolean }> = [
    { name: 'bound founder', identity: { userId: 'founder', avatarId: 'bound-avatar', ledgerCapable: true }, allowed: true },
    { name: 'non-founder', identity: { userId: 'other-user', avatarId: 'other-avatar', ledgerCapable: true }, allowed: false },
    { name: 'false ledger capability', identity: { userId: 'founder', avatarId: 'bound-avatar', ledgerCapable: false }, allowed: false },
    { name: 'null ledger capability', identity: { userId: 'founder', avatarId: 'bound-avatar', ledgerCapable: null }, allowed: false },
    { name: 'missing ledger capability', identity: { userId: 'founder', avatarId: 'bound-avatar' }, allowed: false },
    { name: 'null user', identity: { userId: null, avatarId: 'bound-avatar', ledgerCapable: true }, allowed: false },
    { name: 'null avatar', identity: { userId: 'founder', avatarId: null, ledgerCapable: true }, allowed: false },
    { name: 'expired or missing session', identity: null, allowed: false },
  ];
  for (const { name, identity, allowed } of cases) {
    it(`agent path uses resolved bound identity for ${name}`, async () => {
      const sessionId = 'raw-session-id';
      const message = '  pizza\nRaw agent requester text.  ';
      const resolveAgentSession = mock(async () => identity);
      const result = await execute(agent.code, {
        sessionId, resolveAgentSession, parsed: { data: { message } },
        // Deliberately contradict the bound identity: these are never authorization inputs.
        state: { userId: allowed ? 'different-agent-id' : 'founder', avatarId: 'npc-avatar' },
      }, allowed);
      expect(resolveAgentSession).toHaveBeenCalledTimes(1);
      expect(resolveAgentSession).toHaveBeenCalledWith(sessionId);
      expect(result.resolveDoordashOperator).toHaveBeenCalledWith({
        kind: 'agent', userId: identity?.userId ?? null, avatarId: identity?.avatarId ?? null,
        ledgerCapable: identity?.ledgerCapable === true, agentSessionId: sessionId,
      });
      expect(result.buildRuntimeServices).toHaveBeenCalledWith(result.db, {
        actorKind: 'agent', doordash: allowed ? result.bridge : undefined,
      });
      expect(result.services.doordash).toBe(allowed ? result.bridge : undefined);
      if (allowed) expect(result.buildDoordashBridge).toHaveBeenCalledWith(result.subject, message);
      else expect(result.buildDoordashBridge).not.toHaveBeenCalled();
    });
  }

  it('preserves the agent knowledge identity independently of DoorDash authorization', () => {
    expect(agent.handler).toContain('avatarId: bot?.id ?? npcId,');
    expect(agent.handler).toContain('platformAgentId: elizaAgentId,');
    expect(agent.handler.match(/userId: npcSimulation\.getAgentBotConfig\(sessionId\)\?\.agentId \?\? sessionId,/g)).toHaveLength(2);
    expect(agent.code).not.toMatch(/state\.|resolveSession\(/);
  });
});
