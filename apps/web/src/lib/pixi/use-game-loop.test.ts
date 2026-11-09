import { beforeAll, afterAll, beforeEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useGameLoop, exploreCameraTarget } from './use-game-loop';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { MAP_WIDTH, MAP_HEIGHT } from './tilemap-data';
let dom: JSDOM, root: Root, tick: (delta: number) => void;
const saved = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
 dom = new JSDOM('<div id="test"></div>',{url:'http://localhost/game'});
 for (const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,IS_REACT_ACT_ENVIRONMENT:true})) {
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 }
 root=createRoot(document.getElementById('test')!);
 function Harness(){tick=useGameLoop({mapWidth:MAP_WIDTH,mapHeight:MAP_HEIGHT});return null;}
 act(()=>root.render(createElement(Harness)));
});
afterAll(()=>{act(()=>root.unmount());dom.window.close();for(const [key,value] of saved) {if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
beforeEach(()=>{
 useStageStore.getState().resetStage();
 useGameStore.setState({controlMode:'player',movementFrozen:false,chatOpen:false,guideChatOpen:false,clickPath:null,clickPathTarget:null,clickPathIndex:0,joystickVelocity:{x:0,y:0},possessedNpcId:null});
 useGameStore.getState().setAvatarPosition(MAP_WIDTH/2+1500,MAP_HEIGHT/2+1500);
});
function drive(){useGameStore.getState().setJoystickVelocity(0.5,0);act(()=>tick(1));}
test('player moves the authoritative game-pixel ref',()=>{const x=avatarPositionRef.x;drive();expect(avatarPositionRef.x).toBeGreaterThan(x);});
test('Explore moves only its camera target',()=>{useGameStore.setState({controlMode:'explore'});const x=avatarPositionRef.x;drive();expect(avatarPositionRef.x).toBe(x);expect(exploreCameraTarget.x).toBeGreaterThan(x);});
test('Autonomous ignores direct input and click paths',()=>{useGameStore.setState({controlMode:'autonomous',clickPath:[{x:avatarPositionRef.x+100,y:avatarPositionRef.y}],clickPathIndex:0});const x=avatarPositionRef.x;drive();expect(avatarPositionRef.x).toBe(x);expect(useGameStore.getState().movementDirection).toBe('idle');});
test('generic minimap path moves and finishes without Office special casing',()=>{const x=avatarPositionRef.x,y=avatarPositionRef.y;useGameStore.getState().setClickPath([{x:x+20,y}],null);for(let i=0;i<5;i++)act(()=>tick(1));expect(avatarPositionRef.x).toBeGreaterThan(x);expect(useGameStore.getState().clickPath).toBeNull();});
test('NPC input moves one possessed NPC and mirrors that body',()=>{
 const x=avatarPositionRef.x,y=avatarPositionRef.y;
 const existing=useNpcStore.getState().npcs;
 // The move operation only needs these fields; preserve any live fixture roster.
 const npc={id:'pixi-test-npc',x,y,direction:'idle',name:'Test',species:'cat',color:0xffffff,isDead:false} as (typeof existing)[number];
 useNpcStore.setState({npcs:[npc]});useGameStore.setState({controlMode:'npc',possessedNpcId:npc.id});drive();
 expect(useNpcStore.getState().npcs[0].x).toBe(avatarPositionRef.x);expect(avatarPositionRef.x).toBeGreaterThan(x);useNpcStore.setState({npcs:existing});
});

test('a path blocked by the Office collider stays idle',()=>{
 useGameStore.getState().setAvatarPosition(MAP_WIDTH/2+1085,MAP_HEIGHT/2-3040);
 const x=avatarPositionRef.x,y=avatarPositionRef.y;
 useGameStore.getState().setClickPath([{x:x-200,y}],null);
 act(()=>tick(1));
 expect(avatarPositionRef.x).toBeCloseTo(x);expect(avatarPositionRef.y).toBe(y);
 expect(useGameStore.getState().movementDirection).toBe('idle');
});
test('a service-panel frame never consumes movement',()=>{
 const x=avatarPositionRef.x;dom.window.history.replaceState(null,'','/brainchain');drive();
 expect(avatarPositionRef.x).toBe(x);dom.window.history.replaceState(null,'','/game');
});
test('generic path completion enters a nearby resident after the position commit',()=>{
 const savedEnter=useGameStore.getState().enterBuilding;const entered:string[]=[];
 useGameStore.setState({enterBuilding:(id)=>{entered.push(id);}});
 try {
  // code-development teacher is imported from the same placement source as 3D.
  const resident=require('../three/character-positions').CHARACTER_POSITIONS['code-development'];
  const x=resident.worldX+MAP_WIDTH/2,y=resident.worldZ+MAP_HEIGHT/2;
  useGameStore.getState().setAvatarPosition(x+100,y);
  useGameStore.getState().setClickPath([{x:x+50,y}],resident.buildingId);
  for(let i=0;i<15;i++)act(()=>tick(1));
  expect(entered).toEqual(['code-development']);expect(useGameStore.getState().nearLocation).toBe('code-development');
 }finally{useGameStore.setState({enterBuilding:savedEnter});}
});

test('Autonomous mirrors the live body before Player resumes, including a retained service panel',()=>{
 const roster=useNpcStore.getState().npcs;
 const body={id:'pixi-auto-body',x:MAP_WIDTH/2+1600,y:MAP_HEIGHT/2+1600,direction:'idle',name:'Agent',species:'cat',color:0xffffff,isDead:false} as (typeof roster)[number];
 try {
  useNpcStore.setState({npcs:[body]});useGameStore.setState({controlMode:'autonomous',autonomousBodyId:body.id});
  dom.window.history.replaceState(null,'','/brainchain');drive();
  expect(avatarPositionRef.x).toBe(body.x);expect(avatarPositionRef.y).toBe(body.y);
  dom.window.history.replaceState(null,'','/game');useGameStore.setState({controlMode:'player',autonomousBodyId:null});drive();
  expect(avatarPositionRef.x).toBeGreaterThan(body.x);expect(avatarPositionRef.y).toBe(body.y);
 } finally {dom.window.history.replaceState(null,'','/game');useNpcStore.setState({npcs:roster});useGameStore.setState({autonomousBodyId:null});}
});
