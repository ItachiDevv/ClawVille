import { ReefSpline } from '../packages/shared/src/reef-race/spline';
const FLOOR=192,SAMPLES=4000,N=32,HW=760;
function evalProf(label:string, prof:(t:number)=>number){
  const base:[number,number][]=[];for(let i=0;i<N;i++){const th=(i/N)*2*Math.PI;const r=prof(th);base.push([Math.round(r*Math.cos(th)),Math.round(r*Math.sin(th))]);}
  const sp=new ReefSpline(base.map(([x,z])=>({x,z,halfWidth:HW})),{closed:true});
  const arc=sp.totalArcLength;
  function curv(t:number){const h=1/SAMPLES;const a=sp.centerlineAt(((t-h)%1+1)%1);const b=sp.centerlineAt(t%1);const c=sp.centerlineAt((t+h)%1);const d1x=(c.x-a.x)/(2*h),d1z=(c.z-a.z)/(2*h),d2x=(c.x-2*b.x+a.x)/(h*h),d2z=(c.z-2*b.z+a.z)/(h*h);return (d1x*d2z-d1z*d2x)/(Math.pow(d1x*d1x+d1z*d1z,1.5)||1e-9);}
  let minR=Infinity,rev=0,ps=0;for(let i=1;i<=SAMPLES;i++){const t=i/SAMPLES;const k=Math.abs(curv(t));const r=k>1e-9?1/k:Infinity;if(r<minR)minR=r;const cs=Math.sign(curv(t));if(cs!==0&&ps!==0&&cs!==ps)rev++;if(cs!==0)ps=cs;}
  let pH=Math.atan2(sp.tangentAt(0).z,sp.tangentAt(0).x),sw=0;for(let i=1;i<=SAMPLES;i++){const t=i/SAMPLES;const tg=sp.tangentAt(t%1);let h=Math.atan2(tg.z,tg.x);let d=h-pH;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;sw+=d;pH=h;}
  let xm=Infinity,xM=-Infinity,zm=Infinity,zM=-Infinity;for(let i=0;i<SAMPLES;i+=4){const c=sp.centerlineAt(i/SAMPLES);if(c.x<xm)xm=c.x;if(c.x>xM)xM=c.x;if(c.z<zm)zm=c.z;if(c.z>zM)zM=c.z;}
  console.log(`${label}: arc=${arc.toFixed(0)} sweep=${(sw/Math.PI).toFixed(2)}pi rev=${rev} minR=${minR.toFixed(0)} margin=${(minR-HW).toFixed(0)} ${(minR-HW)>FLOOR?'OK':'TIGHT'} foot=${(xM-xm).toFixed(0)}x${(zM-zm).toFixed(0)}`);
}
// asymmetric: mix harmonics 2,3,4,5 with distinct phases, graded amplitudes
evalProf('A 2,3,4,5', th=>12500+2800*Math.sin(th*2+0.5)+1500*Math.sin(th*3+1.7)+900*Math.sin(th*4+0.2)+400*Math.sin(th*5+2.3));
evalProf('B 2,3,4 strong', th=>12500+3000*Math.sin(th*2+0.5)+1700*Math.sin(th*3+1.7)+1000*Math.sin(th*4+0.2));
evalProf('C 2,3,5', th=>12800+2900*Math.sin(th*2+0.4)+1600*Math.sin(th*3+1.5)+700*Math.sin(th*5+0.9));
evalProf('D 2,4,5,7 soft', th=>12500+2700*Math.sin(th*2+0.6)+1100*Math.sin(th*4+0.6)+600*Math.sin(th*5+1.2)+350*Math.sin(th*7+0.3));
evalProf('E 2,3,4,6', th=>12600+2800*Math.sin(th*2+0.5)+1400*Math.sin(th*3+1.7)+800*Math.sin(th*4+0.2)+500*Math.sin(th*6+1.0));
console.log('--- push reversals ---');
evalProf('C2 2,3,5,6', th=>12800+2700*Math.sin(th*2+0.4)+1500*Math.sin(th*3+1.5)+800*Math.sin(th*5+0.9)+450*Math.sin(th*6+2.1));
evalProf('C3 2,3,5,7', th=>12800+2700*Math.sin(th*2+0.4)+1500*Math.sin(th*3+1.5)+800*Math.sin(th*5+0.9)+400*Math.sin(th*7+1.4));
evalProf('C4 2,3,4,5,6', th=>12800+2600*Math.sin(th*2+0.4)+1400*Math.sin(th*3+1.5)+700*Math.sin(th*4+0.3)+650*Math.sin(th*5+0.9)+400*Math.sin(th*6+2.1));
evalProf('F 2,4,6,8', th=>12700+2700*Math.sin(th*2+0.55)+1100*Math.sin(th*4+0.55)+600*Math.sin(th*6+0.55)+300*Math.sin(th*8+0.55));
evalProf('G 2,3,5,8', th=>12800+2700*Math.sin(th*2+0.4)+1400*Math.sin(th*3+1.5)+800*Math.sin(th*5+0.9)+350*Math.sin(th*8+0.7));
