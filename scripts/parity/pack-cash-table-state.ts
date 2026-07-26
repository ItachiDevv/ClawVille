import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_CASH_TABLE_STATE_PATH =
  'scripts/parity/out/pack-cash-table.json';

export interface PersistedCashTableState {
  tableId: string;
  joinCode: string | null;
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
  const record = parsed as Record<string, unknown>;
  const tableId = record.tableId;
  const joinCode = record.joinCode;
  return typeof tableId === 'string' && tableId.trim().length > 0
    ? {
        tableId: tableId.trim(),
        joinCode:
          typeof joinCode === 'string' && joinCode.trim().length > 0
            ? joinCode.trim()
            : null,
      }
    : null;
}

export async function readPersistedCashTableState(
  path: string,
): Promise<PersistedCashTableState | null> {
  try {
    return parsePersistedCashTableState(await readFile(path, 'utf8'));
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

export async function readPersistedCashTableId(
  path: string,
): Promise<string | null> {
  return (await readPersistedCashTableState(path))?.tableId ?? null;
}

export async function writePersistedCashTableState(
  path: string,
  state: PersistedCashTableState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}
