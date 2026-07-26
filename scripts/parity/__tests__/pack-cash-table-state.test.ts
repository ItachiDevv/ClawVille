import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import {
  parsePersistedCashTableState,
  readPersistedCashTableId,
  readPersistedCashTableState,
  writePersistedCashTableState,
} from '../pack-cash-table-state';

describe('pack cash-table persistence', () => {
  test('accepts only a non-empty tableId', () => {
    expect(parsePersistedCashTableState('{"tableId":" table-1 "}')).toEqual({
      tableId: 'table-1',
      joinCode: null,
    });
    expect(parsePersistedCashTableState(
      '{"tableId":"table-1","joinCode":" CODE1 "}',
    )).toEqual({
      tableId: 'table-1',
      joinCode: 'CODE1',
    });
    expect(parsePersistedCashTableState('{"tableId":""}')).toBeNull();
    expect(parsePersistedCashTableState('{"id":"table-1"}')).toBeNull();
    expect(parsePersistedCashTableState('not json')).toBeNull();
  });

  test('missing state reads null and written state round-trips', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cv-pack-table-'));
    const path = join(directory, 'nested', 'pack-cash-table.json');
    try {
      expect(await readPersistedCashTableId(path)).toBeNull();
      await writePersistedCashTableState(path, {
        tableId: 'table-2',
        joinCode: 'CODE2',
      });
      expect(await readPersistedCashTableId(path)).toBe('table-2');
      expect(await readPersistedCashTableState(path)).toEqual({
        tableId: 'table-2',
        joinCode: 'CODE2',
      });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        tableId: 'table-2',
        joinCode: 'CODE2',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
