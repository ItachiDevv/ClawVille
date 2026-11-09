/** Explicit root registration only; existing signed reservation and protected config are mandatory. */
import {registerConfiguredProbeRuntime} from '../../src/services/brainchain/probe-bootstrap';
if(import.meta.main){try{const result=await registerConfiguredProbeRuntime();console.log(JSON.stringify({runId:result.runId,manifestHash:result.manifestHash}));}catch{console.error('Probe registration refused');process.exitCode=1;}}
