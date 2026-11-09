/** Clean OS-worker entry: no avatar/plugin-sql/platform-provider imports. */
import { IsolatedTaskRuntime } from './runtime';
import type { IsolatedTaskRuntimeConfig } from './types';
export function createElizaRuntime(config: IsolatedTaskRuntimeConfig): IsolatedTaskRuntime {
  return new IsolatedTaskRuntime(config);
}
export { IsolatedTaskRuntime } from './runtime';
export type { IsolatedTaskInventory, IsolatedTaskResult } from './runtime';
export { buildIsolatedTaskPrompt, isolatedTaskPromptHash, validateIsolatedTaskConfig, IsolatedTaskError } from './profile';
export type { IsolatedTaskBinding, IsolatedTaskProxy, IsolatedTaskProxyRequest, IsolatedTaskProxyResponse, IsolatedTaskRuntimeConfig } from './types';
export { TaskFrameReader, TaskStdioError, encodeTaskFrame, parseTaskWorkerInput, TASK_STDIO_MAX_FRAME_BYTES, TASK_STDIO_VERSION } from './stdio';
export type { TaskWorkerInput, TaskWorkerOutput } from './stdio';
export { runTaskParent, TaskParentError } from './parent';
export type { TaskChildChannel, TaskParentProxy, VerifiedTaskChildResult } from './parent';
