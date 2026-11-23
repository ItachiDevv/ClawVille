export function parseSuiteResult(output: string, requireNoSkips: boolean) {
  const passed = Number(/(?:^|\n)\s*(\d+) pass\b/.exec(output)?.[1] ?? 0);
  const skipped = Number(/(?:^|\n)\s*(\d+) skip\b/.exec(output)?.[1] ?? 0);
  if (!passed) throw Error('No tests executed');
  if (requireNoSkips && skipped) throw Error('Required tests skipped');
  return { passed, skipped };
}
