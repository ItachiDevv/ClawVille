import { expect, test } from 'bun:test';
import { resolveWorldRendererMode, isStageSceneAvailable, selectWorldRendererMode, getWorldRendererMode, allowWorldActivityQueue, shouldReleaseWorldLoader } from './world-renderer-mode';
test('query takes precedence, storage is bounded, and 3D is the default', () => {
  expect(resolveWorldRendererMode('?view=2d', '3d')).toBe('2d');
  expect(resolveWorldRendererMode('?view=3d', '2d')).toBe('3d');
  expect(resolveWorldRendererMode('?view=invalid', '2d')).toBe('2d');
  expect(resolveWorldRendererMode('', 'invalid')).toBe('3d');
  expect(resolveWorldRendererMode('', null)).toBe('3d');
});
test('2D refuses special scenes before transition', () => {
  expect(isStageSceneAvailable('world', '2d')).toBe(true);
  for (const scene of ['cove', 'kelp', 'trading-floor', 'activity']) {
    expect(isStageSceneAvailable(scene, '2d')).toBe(false);
    expect(isStageSceneAvailable(scene, '3d')).toBe(true);
  }
});

test('terminal renderer failure releases the loader before any Pixi frame',()=>{
 expect(shouldReleaseWorldLoader('3d',false,false)).toBe(false);
 expect(shouldReleaseWorldLoader('3d',false,true)).toBe(true);
 expect(shouldReleaseWorldLoader('2d',false,true)).toBe(true);
 expect(shouldReleaseWorldLoader('2d',true,false)).toBe(true);
 const page=require('node:fs').readFileSync(new URL('../app/(world)/game/page.tsx',import.meta.url),'utf8');
 expect(page).toContain('useSyncExternalStore(subscribeStageRendererFailure, getStageRendererFailure, getStageRendererFailureServerSnapshot)');
 expect(page).toContain('forceReady={shouldReleaseWorldLoader(rendererMode, pixiFrame, rendererFailure !== null)}');
});
test('actual lobby and sidebar handlers refuse 2D before any queue mutation',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window');
 Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{search:'?view=2d'}}});selectWorldRendererMode('2d');
 try {
  const fs=require('node:fs');
  const source=fs.readFileSync(new URL('../components/game/activity-lobby-modal.tsx',import.meta.url),'utf8');
  const sidebar=fs.readFileSync(new URL('../components/game/sidebar-menu.tsx',import.meta.url),'utf8');
  const bodies=[source.split('const handleQueue = useCallback(async (partyId?: string) => {')[1].split('\n  }, [')[0],sidebar.split('const handleQuickQueueBumperShells = async () => {')[1].split('\n  };')[0]];
  let notices=0,mutations=0;
  for(const body of bodies){
   const js=new Bun.Transpiler({loader:'ts'}).transformSync('async function handler(){'+body+'}');
   const handler=new Function('allowWorldActivityQueue','addToast','fetch','setQueueing','setQueueingBumper','primeActivitySounds',js+';return handler;')(allowWorldActivityQueue,()=>notices++,()=>mutations++,()=>mutations++,()=>mutations++,()=>mutations++);
   await handler();
  }
  expect(notices).toBe(2);expect(mutations).toBe(0);
  (window.location as {search:string}).search='?view=3d';expect(getWorldRendererMode()).toBe('2d');
 } finally {selectWorldRendererMode('3d');if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else Reflect.deleteProperty(globalThis,'window');}
});

test('actual party create and join handlers refuse 2D before mutation',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{search:'?view=2d'}}});
 const source=require('node:fs').readFileSync(new URL('../components/game/activity-lobby-modal.tsx',import.meta.url),'utf8');
 let notices=0,created=0;const joined:string[]=[];
 try {
  for(const [prefix,args] of [['const handleCreateParty = useCallback(async () => {',[]],['const handleJoinParty = useCallback(async (shortCode: string) => {',['ABC123']]] as const){
   const body=source.split(prefix)[1].split('\n  }, [')[0];
   const js=new Bun.Transpiler({loader:'ts'}).transformSync('async function handler(shortCode?:string){'+body+'}');
   const handler=new Function('allowWorldActivityQueue','addToast','createParty','joinByCode',js+';return handler;')(allowWorldActivityQueue,()=>notices++,()=>{created++;return null;},(code:string)=>{joined.push(code);return null;});
   selectWorldRendererMode('2d');await handler(...args);expect(created).toBe(0);expect(joined).toEqual([]);
  }
  expect(notices).toBe(2);
 } finally {selectWorldRendererMode('3d');if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else Reflect.deleteProperty(globalThis,'window');}
});
