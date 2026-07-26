import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_CASH_TABLE_STATE_PATH =
  'scripts/parity/out/pack-cash-table.json';

interface PersistedCashTableState {
  tableId: string;
}

export function parsePersistedCashTableState(
  raw: string,
): PersistedCashTableState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const tableId = (parsed as Record<string, unknown>).tableId;
  return typeof tableId === 'string' && tableId.trim().length > 0
    ? { tableId: tableId.trim() }
    : null;
}

export async function readPersistedCashTableId(
  path: string,
): Promise<string | null> {
  try {
    const state = parsePersistedCashTableState(await readFile(path, 'utf8'));
    return state?.tableId ?? null;
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

export async function writePersistedCashTableId(
  path: string,
  tableId: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ tableId }, null, 2)}\n`,
    'utf8',
  );
}
