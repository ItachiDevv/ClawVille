import { ReefSpline } from '../packages/shared/src/reef-race/spline';
const FLOOR=192,SAMPLES=4000,ARC_SKIP=7000,N=32;
// LOCKED C3 profile: harmonics 2,3,5,7 — 30 reversals, minR 2075, margin 1315.
function radiusAt(th:number){return 12800+2700*Math.sin(th*2+0.4)+1500*Math.sin(th*3+1.5)+800*Math.sin(th*5+0.9)+400*Math.sin(th*7+1.4);}
const base:{x:number;z:number}[]=[];
for(let i=0;i<N;i++){const th=(i/N)*2*Math.PI;const r=radiusAt(th);base.push({x:Math.round(r*Math.cos(th)),z:Math.round(r*Math.sin(th))});}
function turnDeg(arr:{x:number;z:number}[],i:number){const p=arr[(i-1+N)%N],c=arr[i],n=arr[(i+1)%N];const a1=Math.atan2(c.z-p.z,c.x-p.x),a2=Math.atan2(n.z-c.z,n.x-c.x);let d=a2-a1;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;return Math.abs(d*180/Math.PI);}
// per-CP halfWidth: wide on straights (low turn), a touch narrower on sharper turns. [720,1040].
const cps:[number,number,number][]=base.map((b,i)=>{const td=turnDeg(base,i);const hw=Math.round(1040-Math.min(td,45)/45*(1040-720));return [b.x,b.z,hw];});
// pick start = a low-turn CP near the SOUTH (min z), so the start straight is wide+flat
let startI=0,bestScore=Infinity;
for(let i=0;i<N;i++){const td=turnDeg(base,i);if(td<18){const score=base[i].z+td*300;if(score<bestScore){bestScore=score;startI=i;}}}
const rot=[...cps.slice(startI),...cps.slice(0,startI)] as [number,number,number][];
const sp=new ReefSpline(rot.map(([x,z,halfWidth])=>({x,z,halfWidth})),{closed:true});
const arc=sp.totalArcLength;
function curv(t:number){const h=1/SAMPLES;const a=sp.centerlineAt(((t-h)%1+1)%1);const b=sp.centerlineAt(t%1);const c=sp.centerlineAt((t+h)%1);const d1x=(c.x-a.x)/(2*h),d1z=(c.z-a.z)/(2*h),d2x=(c.x-2*b.x+a.x)/(h*h),d2z=(c.z-2*b.z+a.z)/(h*h);return (d1x*d2z-d1z*d2x)/(Math.pow(d1x*d1x+d1z*d1z,1.5)||1e-9);}
let minR=Infinity,minRt=0,rev=0,ps=0;for(let i=1;i<=SAMPLES;i++){const t=i/SAMPLES;const k=Math.abs(curv(t));const r=k>1e-9?1/k:Infinity;if(r<minR){minR=r;minRt=t;}const cs=Math.sign(curv(t));if(cs!==0&&ps!==0&&cs!==ps)rev++;if(cs!==0)ps=cs;}
let pH=Math.atan2(sp.tangentAt(0).z,sp.tangentAt(0).x),sw=0;for(let i=1;i<=SAMPLES;i++){const t=i/SAMPLES;const tg=sp.tangentAt(t%1);let h=Math.atan2(tg.z,tg.x);let d=h-pH;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;sw+=d;pH=h;}
const sList:{t:number;x:number;z:number;hw:number;s:number}[]=[];for(let i=0;i<SAMPLES;i+=4){const t=i/SAMPLES;const c=sp.centerlineAt(t);sList.push({t,x:c.x,z:c.z,hw:sp.widthAt(t),s:sp.arclengthFromT(t)});}
let worstEdge=Infinity,wp='';for(let a=0;a<sList.length;a++)for(let b=a+1;b<sList.length;b++){const A=sList[a],B=sList[b];let ds=Math.abs(A.s-B.s);ds=Math.min(ds,arc-ds);if(ds<ARC_SKIP)continue;const xz=Math.hypot(A.x-B.x,A.z-B.z);const edge=xz-A.hw-B.hw;if(edge<worstEdge){worstEdge=edge;wp=`t${A.t.toFixed(3)}~t${B.t.toFixed(3)} xz=${xz.toFixed(0)} hw=${A.hw.toFixed(0)}/${B.hw.toFixed(0)}`;}}
let hwMin=Infinity,hwMax=-Infinity;for(let i=0;i<SAMPLES;i++){const w=sp.widthAt(i/SAMPLES);if(w<hwMin)hwMin=w;if(w>hwMax)hwMax=w;}
let minSpace=Infinity,msp='';for(let i=0;i<N;i++){const j=(i+1)%N;const d=Math.hypot(rot[i][0]-rot[j][0],rot[i][1]-rot[j][1]);if(d<minSpace){minSpace=d;msp=`CP${i}->CP${j}`;}}
let xm=Infinity,xM=-Infinity,zm=Infinity,zM=-Infinity;for(const s of sList){if(s.x<xm)xm=s.x;if(s.x>xM)xM=s.x;if(s.z<zm)zm=s.z;if(s.z>zM)zM=s.z;}
const start=sp.centerlineAt(0);
const startTan=sp.tangentAt(0);
console.log(`arc=${arc.toFixed(1)} sweep=${(sw/Math.PI).toFixed(4)}pi rev=${rev}`);
console.log(`minR=${minR.toFixed(1)}@t${minRt.toFixed(3)} hw_there=${sp.widthAt(minRt).toFixed(0)} margin=${(minR-sp.widthAt(minRt)).toFixed(0)} ${(minR-sp.widthAt(minRt))>FLOOR?'OK':'TIGHT'}`);
console.log(`hw=[${hwMin.toFixed(0)},${hwMax.toFixed(0)}] water=${(2*hwMin).toFixed(0)}-${(2*hwMax).toFixed(0)} wide  (narrowest fits ${Math.floor(2*hwMin/180)} boards@180wu)`);
console.log(`worstEdge=${worstEdge.toFixed(0)} ${worstEdge>300?'OK':'TIGHT'}  ${wp}`);
console.log(`minCPspace=${minSpace.toFixed(0)} ${msp} ${minSpace>200?'OK':'BAD'}`);
console.log(`footprint X[${xm.toFixed(0)},${xM.toFixed(0)}] Z[${zm.toFixed(0)},${zM.toFixed(0)}] span ${(xM-xm).toFixed(0)}x${(zM-zm).toFixed(0)}`);
console.log(`start=(${start.x.toFixed(0)},${start.z.toFixed(0)}) tangent=(${startTan.x.toFixed(2)},${startTan.z.toFixed(2)}) startTurn=${turnDeg(base,startI).toFixed(0)}deg`);
// segment t-boundaries at CP transitions for REEF_RACE_SEGMENTS
console.log('\nCP -> t projections (for segment boundaries):');
for(const ci of [0,3,9,14,18,24,31]){const c={x:rot[ci][0],z:rot[ci][1]};const r=sp.closestPointOnSpline(c);console.log(`  CP${ci} -> t${r.t.toFixed(4)}`);}
console.log(`\nFINAL CP ARRAY:`);
rot.forEach((c,i)=>console.log(`  { x: ${c[0]}, z: ${c[1]}, halfWidth: ${c[2]} }, // CP ${i}`));
