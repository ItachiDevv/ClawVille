import { expect, test } from 'bun:test';
import { brainchainTasksResponseSchema, parseBrainchainActionParams, selectBrainchainActionResult } from '../brainchain-action';

const workerId = '11111111-1111-4111-8111-111111111111';
const hash = `0x${'a'.repeat(64)}`;
const task = {
  id: workerId, boardAddress: `0x${'a'.repeat(40)}`, taskId: '42', status: 1,
  bountyAtomic: '1000000', deadlineUnix: '1800000000', canonical: true,
  observedBlock: '400', observedBlockHash: hash, hireBlock: '300', hireBlockHash: hash,
  hireTransaction: hash, hireLogIndex: 0, briefHash: hash, resultHash: hash,
  updatedAt: '2026-11-13T00:00:00.000Z', provisional: true as const,
};

test('tasks grammar permits only an owned worker selector', () => {
  expect(parseBrainchainActionParams(`op=tasks,workerId=${workerId}`)).toEqual({ op: 'tasks', workerId });
  expect(parseBrainchainActionParams('op=tasks')).toBeNull();
  expect(parseBrainchainActionParams(`op=tasks,workerId=${workerId},avatarId=${workerId}`)).toBeNull();
});

test('tasks response mirrors all indexed fields and rejects unknown fields at either level', () => {
  const body = { tasks: [task], provisional: true as const };
  expect(brainchainTasksResponseSchema.parse(body)).toEqual(body);
  expect(brainchainTasksResponseSchema.safeParse({ ...body, next: 'execute' }).success).toBe(false);
  expect(brainchainTasksResponseSchema.safeParse({ ...body, tasks: [{ ...task, secret: 'unexpected' }] }).success).toBe(false);
  expect(brainchainTasksResponseSchema.safeParse({ ...body, provisional: false }).success).toBe(false);
  expect(brainchainTasksResponseSchema.safeParse({ ...body, tasks: Array(101).fill(task) }).success).toBe(false);
});

test('tasks preview validates all 100 rows before the five-row private result limit', () => {
  const tasks = Array.from({ length: 100 }, (_, i) => ({ ...task, taskId: String(i + 1) }));
  const result = selectBrainchainActionResult('tasks', 200, { tasks, provisional: true });
  expect(result.data).toEqual({ tasks: tasks.slice(0, 5), provisional: true, indexedCount: 100, truncated: true });
  expect(() => selectBrainchainActionResult('tasks', 200, {
    tasks: [...tasks.slice(0, 99), { ...task, unexpected: true }], provisional: true,
  })).toThrow();
  expect(selectBrainchainActionResult('tasks', 200, { tasks: [], provisional: true }).data)
    .toEqual({ tasks: [], provisional: true, indexedCount: 0, truncated: false });
});

test('maximum-width tasks preview fits the existing private result byte limit', () => {
  const maximum = { ...task, taskId: String(2n ** 256n - 1n), bountyAtomic: String(2n ** 128n - 1n),
    deadlineUnix: '9'.repeat(78), observedBlock: '9'.repeat(78), hireBlock: '9'.repeat(78), hireLogIndex: 2147483647 };
  const result = selectBrainchainActionResult('tasks', 200, { tasks: Array(100).fill(maximum), provisional: true });
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(8192);
});
