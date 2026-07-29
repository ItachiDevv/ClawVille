import type {
  MatrixStatus,
  ScenarioDefinition,
  ScenarioResult,
} from './types';

export interface MatrixEmission {
  markdown: string;
  pass: boolean;
  counts: Record<MatrixStatus, number>;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function resultFor(
  definition: ScenarioDefinition,
  results: readonly ScenarioResult[],
): ScenarioResult | null {
  return results.find((result) => result.scenario === definition.id) ?? null;
}

function statusFor(
  definition: ScenarioDefinition,
  result: ScenarioResult | null,
): MatrixStatus {
  if (definition.blockedReason) return 'BLOCKED';
  if (!result || !result.reached) return 'UNPROVEN';
  if (!result.pass) return 'FAIL';
  return 'PASS';
}

export function emitMatrix(
  definitions: readonly ScenarioDefinition[],
  results: readonly ScenarioResult[] = [],
): MatrixEmission {
  const counts: Record<MatrixStatus, number> = {
    PASS: 0,
    FAIL: 0,
    UNPROVEN: 0,
    BLOCKED: 0,
  };
  const lines = [
    '# Cove render-state parity matrix',
    '',
    '| game | tier | surface | scenario | required | phases/steps | reached | status | mismatches | screenshots |',
    '|---|---|---|---|---:|---|---:|---|---:|---|',
  ];

  for (const definition of definitions) {
    const result = resultFor(definition, results);
    const status = statusFor(definition, result);
    counts[status] += 1;
    const mismatches = result?.checkpoints.reduce(
      (sum, checkpoint) => sum + checkpoint.mismatches.length,
      0,
    ) ?? 0;
    const reason = definition.blockedReason
      ?? (status === 'UNPROVEN' ? 'live run required' : '');
    lines.push([
      definition.game,
      definition.tier,
      `\`${definition.surface}\``,
      `${definition.row} ${escapeCell(definition.name)}`,
      definition.required ? 'Y' : 'N',
      escapeCell(definition.phases.join(' -> ')),
      result?.reached ? 'Y' : 'N',
      reason ? `${status} (${escapeCell(reason)})` : status,
      String(mismatches),
      escapeCell(result?.screenshots.join(', ') ?? ''),
    ].map((cell) => ` ${cell} `).join('|').replace(/^/, '|').concat('|'));
  }

  const requiredFailures = definitions.filter((definition) => {
    if (!definition.required) return false;
    return statusFor(definition, resultFor(definition, results)) !== 'PASS';
  });
  const pass = requiredFailures.length === 0;
  lines.push(
    '',
    `Summary: PASS=${counts.PASS}, FAIL=${counts.FAIL}, UNPROVEN=${counts.UNPROVEN}, BLOCKED=${counts.BLOCKED}.`,
    `Gate verdict: **${pass ? 'PASS' : 'FAIL'}** (${requiredFailures.length} required row(s) are not PASS).`,
    '',
    '> Offline recorded-payload tests certify harness mechanics only. They do not promote a browser matrix row to PASS.',
    '> Hold’em ordered street replay is tray-only; felt rows assert only states the felt actually renders.',
  );
  return { markdown: `${lines.join('\n')}\n`, pass, counts };
}
