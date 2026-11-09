import { expect, test } from 'bun:test';
import { pixiWorldScale, pixiHitSize } from './pixi-world-scale';
test('touch targets remain 44 CSS pixels at every required device size', () => {
  for (const [w,h] of [[390,844],[744,1133],[820,1180],[1024,1366]]) for (const [width,height] of [[w,h],[h,w]]) {
    const scale = pixiWorldScale(width,height);
    expect(scale).toBeGreaterThanOrEqual(0.28);
    expect(pixiHitSize(scale) * scale).toBeCloseTo(44);
    expect(100 * scale).toBeGreaterThanOrEqual(28);
  }
  expect(1440 / pixiWorldScale(1440,900)).toBeLessThan(2400);
});

test('all solid collision bounds have identical visible footprints',()=>{
 const {getAllColliders}=require('../three/collision/world-colliders');
 const {pixiSolidFootprint}=require('./pixi-world-scale');
 const center=11264;
 for(const collider of getAllColliders()){
  const f=pixiSolidFootprint(collider,center,center);
  if(collider.walkable){expect(f).toBeNull();continue;}
  expect(f).toMatchObject({x:center+collider.centerX-collider.halfX,y:center+collider.centerZ-collider.halfZ,width:collider.halfX*2,height:collider.halfZ*2});
 }
 const stall=pixiSolidFootprint(getAllColliders().find((c:{id:string})=>c.id==='marketplace-stall'),center,center);
 const tools=pixiSolidFootprint(getAllColliders().find((c:{id:string})=>c.id==='mcp-tool-use'),center,center);
 // Exact browser stops leave the NPC half-width (50 wu) outside these visible edges.
 expect(stall.y+stall.height+50).toBe(11484);
 expect(tools.x-50).toBe(14213);
});
