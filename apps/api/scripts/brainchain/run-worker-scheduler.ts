/** Explicit bounded host loop. No API boot hook or credential discovery. */
import {realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {BrainchainWorkerScheduler,type WorkerSchedulerConfiguration} from '../../src/services/brainchain/worker-scheduler';
import {createOwnedSignerObserver} from '../../src/services/brainchain/signer-observation';
import {createFixedTestnetTransport} from '../../src/services/brainchain/signer-rpc';
import {createWorkerDeliveryEvidenceReader} from '../../src/services/brainchain/worker-delivery-evidence';
import {ExactCaptureRecovery} from '../../src/services/brainchain/exact-capture-recovery';
import {DeliveryRecovery} from '../../src/services/brainchain/delivery-recovery';
import {WORKER_PROVISIONAL_POLICY} from '../../src/services/brainchain/worker-observation-policy';

export async function runWorkerSchedulerCommand(args:string[]){
  if(![8,12].includes(args.length)||args[0]!=='--trusted-config'||!isAbsolute(args[1]!)||args[2]!=='--worker'||args[4]!=='--ticks'||args[6]!=='--interval-ms')
    throw Error('Usage: run-worker-scheduler.ts --trusted-config <absolute host module> --worker <UUID> --ticks <1..100> --interval-ms <1000..30000>');
  const workerId=z.string().uuid().parse(args[3]);
  const recovery=args.length===12?(()=>{if(args[8]!=='--recover-result'||args[10]!=='--consent')throw Error('Exact recovery arguments required');return{resultId:z.string().uuid().parse(args[9]),consentId:z.string().uuid().parse(args[11])};})():undefined;
  const ticks=z.coerce.number().int().min(1).max(100).parse(args[5]);
  const interval=z.coerce.number().int().min(1000).max(30000).parse(args[7]);
  const module=await import(pathToFileURL(await realpath(args[1]!)).href);
  if(typeof module.createWorkerSchedulerConfiguration!=='function')throw Error('Trusted scheduler configuration export required');
  const config:WorkerSchedulerConfiguration=await module.createWorkerSchedulerConfiguration();
  const runtime=config.runtime;
  const scheduler=new BrainchainWorkerScheduler({...config,captureRecovery:new ExactCaptureRecovery(runtime.database,createWorkerDeliveryEvidenceReader()),runtime:{...runtime,observationPolicy:WORKER_PROVISIONAL_POLICY,
    observe:createOwnedSignerObserver(runtime.database,{},WORKER_PROVISIONAL_POLICY),
    recovery:new DeliveryRecovery(runtime.database,createWorkerDeliveryEvidenceReader()),
    signer:runtime.signer?{...runtime.signer,transport:createFixedTestnetTransport({},WORKER_PROVISIONAL_POLICY)}:undefined}});
  try{
    for(let tick=0;tick<ticks;tick++){
      const outcome=recovery?await scheduler.recover(workerId,recovery.resultId,recovery.consentId):await scheduler.tick(workerId);
      // Only finite status metadata leaves this entry. Briefs, prompts and output stay in private storage.
      console.log(JSON.stringify({tick:tick+1,state:outcome.state,stage:'stage'in outcome?outcome.stage:undefined}));
      if(tick+1<ticks)await Bun.sleep(interval);
    }
  }finally{await runtime.database.end();await runtime.lockDatabase.end();}
}
if(import.meta.main){
  try{await runWorkerSchedulerCommand(process.argv.slice(2));}
  catch{console.error('BrainChain scheduler refused. Inspect private policy and durable evidence.');process.exitCode=1;}
}
