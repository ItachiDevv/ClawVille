/** Explicit trusted-host entry; does not discover credentials or start a scheduler. */
import {readFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BrainchainWorkerCoordinator,workerTickSchema,type WorkerRuntime} from '../../src/services/brainchain/worker-coordinator';
import {createOwnedSignerObserver} from '../../src/services/brainchain/signer-observation';

export async function runWorkerCommand(args:string[]){
  if(args.length!==4||args[0]!=='--trusted-config'||args[2]!=='--request'||!isAbsolute(args[1]!)||!isAbsolute(args[3]!))
    throw Error('Usage: run-worker.ts --trusted-config <absolute host module> --request <absolute JSON file>');
  const requestPath=await realpath(args[3]!);
  if((await stat(requestPath)).size>32768)throw Error('Worker request exceeds limit');
  const request=workerTickSchema.parse(JSON.parse(await readFile(requestPath,'utf8')));
  // The local operator explicitly selects executable configuration. Never expose this path through HTTP.
  const module=await import(pathToFileURL(await realpath(args[1]!)).href);
  if(typeof module.createWorkerRuntime!=='function')throw Error('Trusted module must export createWorkerRuntime');
  const runtime:WorkerRuntime=await module.createWorkerRuntime();
  try{return await new BrainchainWorkerCoordinator({...runtime,observe:createOwnedSignerObserver(runtime.database)}).tick(request);}
  finally{await runtime.database.end();await runtime.lockDatabase.end();}
}
if(import.meta.main){
  try{console.log(JSON.stringify(await runWorkerCommand(process.argv.slice(2)),(_key,value)=>typeof value==='bigint'?value.toString():value));}
  catch{console.error('BrainChain worker tick refused. Inspect private authority and durable evidence.');process.exitCode=1;}
}
