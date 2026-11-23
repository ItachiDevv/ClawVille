/** Worker-only response freshness. Neither policy authorizes financial release. */
export const WORKER_PROVISIONAL_POLICY='nitro-testnet-latest-v1' as const;
export const LEGACY_WORKER_POLICY='legacy-depth12-age120-v1' as const;
export type WorkerObservationPolicy=typeof WORKER_PROVISIONAL_POLICY|typeof LEGACY_WORKER_POLICY;
export type WorkerObservation={observedAt:Date;blockTimestamp:bigint;observationPolicy?:WorkerObservationPolicy};
export const observationPolicyOf=(observation:Pick<WorkerObservation,'observationPolicy'>)=>observation.observationPolicy??LEGACY_WORKER_POLICY;
export function workerObservationFresh(observation:WorkerObservation,now=new Date(Date.now())):boolean{
  const elapsed=now.getTime()-observation.observedAt.getTime();
  const age=BigInt(Math.floor(now.getTime()/1000))-observation.blockTimestamp;
  return Number.isFinite(elapsed)&&elapsed>=0&&elapsed<=30000&&age>=0n&&
    (observation.observationPolicy===WORKER_PROVISIONAL_POLICY||age<=120n);
}
