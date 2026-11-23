'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AUTH_ME_QUERY_KEY, useAuthMe, type AuthMe } from '@/hooks/use-auth-me';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { officeAccountRequest } from './office-api';
import { purchaseQueryOptions } from './office-purchases';
import { fundingQueryOptions } from './office-funding-exit';
import { EMPTY_OFFICE_BOARDS, formatOfficeBoards, officeBoardPublication, officeBoardRefreshInterval, type OfficeWorker } from './office-board-summary';
import { useBrainchainInteriorStore } from './brainchain-interior-store';

export function workerQueryOptions(userId: string | null) {
  return { queryKey: ['brainchain-office', 'workers', userId], queryFn: ({signal}: {signal: AbortSignal}) => officeAccountRequest<{workers: OfficeWorker[]}>('workers', signal), retry: false as const, staleTime: 15_000, gcTime: 0, refetchOnMount: false as const, refetchOnWindowFocus: false as const, refetchOnReconnect: false as const };
}
const integerText = z.string().regex(/^\d{1,78}$/);
const taskPage = z.object({provisional: z.literal(true), tasks: z.array(z.object({
  id: z.string().uuid(), taskId: integerText, status: z.number().int().min(1).max(9),
  bountyAtomic: z.string().regex(/^(0|[1-9]\d{0,38})$/), deadlineUnix: integerText,
  hireBlock: integerText, updatedAt: z.string().datetime(), provisional: z.literal(true),
}).passthrough()).max(100)}).strict();
export function taskQueryOptions(userId: string | null, workerId: string) {
  return { queryKey: ['brainchain-office', 'tasks', userId, workerId], queryFn: async ({signal}: {signal: AbortSignal}) => taskPage.parse(await officeAccountRequest(`workers/${workerId}/tasks`, signal)), retry: false as const, staleTime: 15_000, gcTime: 0, refetchOnMount: false as const, refetchOnWindowFocus: false as const, refetchOnReconnect: false as const };
}

/** DOM observers only. This hook never reads the earnings chain endpoint. */
export function useOfficeBoardData(room = false) {
  const auth = useAuthMe();
  const client = useQueryClient();
  const ownerId = auth.data?.user && !auth.data.user.isGuest ? auth.data.user.id : null;
  const pathname = usePathname();
  const scene = useStageStore(state => state.activeScene);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    update(); document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const active = pathname === '/brainchain' && (scene === 'brainchain' || scene === null);
  const enabled = !!ownerId && !auth.isError && (!room || active);
  const policy = { enabled, refetchInterval: officeBoardRefreshInterval(room, active, visible), refetchIntervalInBackground: false, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: room ? 'always' as const : false as const };
  const workers = useQuery({...workerQueryOptions(ownerId), ...policy});
  const purchases = useQuery({...purchaseQueryOptions(ownerId), ...policy});
  const funding = useQuery({...fundingQueryOptions(ownerId), ...policy});
  const shownWorkers = workers.data?.workers.slice(0, 2) ?? [];
  const tasks = useQueries({queries: shownWorkers.map(worker => ({...taskQueryOptions(ownerId, worker.id), ...policy}))});
  const rows = tasks.flatMap((query, index) => (query.data?.tasks ?? []).map(task => ({worker: shownWorkers[index]!, task})))
    .sort((a, b) => Date.parse(b.task.updatedAt) - Date.parse(a.task.updatedAt)).slice(0, 5);
  const summary = formatOfficeBoards({ ownerId, authLoading: auth.isLoading, authError: auth.isError,
    workers: {data: workers.data?.workers, loading: workers.isPending, error: workers.isError, updatedAt: workers.dataUpdatedAt},
    tasks: {data: rows, loading: tasks.some(query => query.isPending), error: tasks.some(query => query.isError), updatedAt: Math.max(0, ...tasks.map(query => query.dataUpdatedAt))},
    purchases: {data: purchases.data?.orders, loading: purchases.isPending, error: purchases.isError, updatedAt: purchases.dataUpdatedAt},
    funding: {data: funding.data?.operations, loading: funding.isPending, error: funding.isError, updatedAt: funding.dataUpdatedAt},
  });
  return { summary, workers: auth.isError ? [] : shownWorkers, retry: () => {
    const current = client.getQueryData<AuthMe>(AUTH_ME_QUERY_KEY);
    if (!ownerId || current?.user?.isGuest || current?.user?.id !== ownerId || client.getQueryState(AUTH_ME_QUERY_KEY)?.status !== 'success') { void auth.refetch(); return; }
    void workers.refetch(); void purchases.refetch(); void funding.refetch(); for (const query of tasks) void query.refetch();
  } };
}

export function useOfficeBoardBridge() {
  const {summary} = useOfficeBoardData(true);
  const client = useQueryClient();
  const key = JSON.stringify(summary);
  useLayoutEffect(() => {
    const current = client.getQueryData<AuthMe>(AUTH_ME_QUERY_KEY);
    const ownerId = current?.user && !current.user.isGuest ? current.user.id : null;
    const next = officeBoardPublication(JSON.parse(key) as typeof summary, ownerId, client.getQueryState(AUTH_ME_QUERY_KEY)?.status === 'error');
    if (next) useBrainchainInteriorStore.getState().setBoardSummary(next);
  }, [key, client]);
  useLayoutEffect(() => {
    // Clear canvas pixels synchronously with the auth cache, before React paints.
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.query.queryKey[0] !== AUTH_ME_QUERY_KEY[0]) return;
      const auth = client.getQueryData<AuthMe>(AUTH_ME_QUERY_KEY);
      const ownerId = auth?.user && !auth.user.isGuest ? auth.user.id : null;
      const store = useBrainchainInteriorStore.getState();
      if (store.boardSummary.ownerId !== ownerId) store.setBoardSummary({ ...EMPTY_OFFICE_BOARDS, ownerId,
        task: {...EMPTY_OFFICE_BOARDS.task, lines: [ownerId ? 'Load your workers...' : 'Sign in to see your workers']},
        receipts: {...EMPTY_OFFICE_BOARDS.receipts, lines: [ownerId ? 'Load your receipts...' : 'Sign in to see your receipts']},
      });
    });
    return () => { unsubscribe(); useBrainchainInteriorStore.getState().setBoardSummary(EMPTY_OFFICE_BOARDS); };
  }, [client]);
}
