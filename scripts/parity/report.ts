import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ScenarioResult } from './types';

export async function writeJsonReport(
  path: string,
  result: ScenarioResult,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

export async function writeTextReport(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}
