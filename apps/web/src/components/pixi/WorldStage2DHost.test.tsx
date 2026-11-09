import { beforeAll, afterAll, expect, test, mock } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createElement, useEffect, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStageStore } from '@/components/three/world-stage/stage-store';
let frame: (()=>void) | undefined, mounts=0, unmounts=0;
mock.module('./PixiCanvas',()=>({default:(props:{onFrame:()=>void;onMount:()=>void})=>{frame=props.onFrame;useEffect(()=>{mounts++;props.onMount();return()=>{unmounts++;};},[]);return null;}}));
const {default:Host,acknowledgePixiFrame}=await import('./WorldStage2DHost');
let dom:JSDOM,root:Root;
const saved=new Map<string,PropertyDescriptor|undefined>();
beforeAll(()=>{dom=new JSDOM('<div id="test"></div>',{url:'http://localhost/game?view=2d'});for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}root=createRoot(document.getElementById('test')!);});
afterAll(()=>{act(()=>root.unmount());dom.window.close();for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
test('world generations acknowledge in order across 60 requests with one app mount',()=>{
 useStageStore.getState().resetStage();act(()=>root.render(createElement(Host)));
 for(let i=0;i<60;i++){
  useStageStore.getState().requestScene('world');const request=useStageStore.getState().pendingRequest!;
  const seen:string[]=[];
  const unsubscribe=useStageStore.subscribe((s,p)=>{if(s.scenes.world?.status!==p.scenes.world?.status)seen.push(s.scenes.world.status);if(s.cameraInstalled!==p.cameraInstalled)seen.push('camera');if(s.firstControlledFrame!==p.firstControlledFrame)seen.push('frame');});
  act(()=>frame?.());unsubscribe();
  expect(seen).toEqual(['warming','ready','camera','frame']);
  expect(useStageStore.getState().firstControlledFrame).toEqual({sceneId:'world',generation:request.generation});
  useStageStore.getState().activateScene(request);useStageStore.getState().setTransitionPhase(request.requestId,'fadingIn');useStageStore.getState().completeTransition(request);
  expect(useStageStore.getState().pendingRequest).toBeNull();
 }
 expect(mounts).toBe(1);expect(unmounts).toBe(0);expect(useStageStore.getState().canvasMountCount).toBe(1);
});
test('a non-world generation never receives a fake acknowledgement',()=>{
 useStageStore.getState().registerScenes(['cove']);useStageStore.getState().requestScene('cove');acknowledgePixiFrame();
 expect(useStageStore.getState().scenes.cove.status).toBe('loading');expect(useStageStore.getState().cameraInstalled).toBeNull();expect(useStageStore.getState().firstControlledFrame).toBeNull();
});
