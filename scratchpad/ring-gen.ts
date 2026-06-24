import { ReefSpline, type SplineControlPoint } from '../packages/shared/src/reef-race/spline';
const CARVE_FLOOR = 192, SAMPLES = 4000, ARC_SKIP = 7000, N = 32;
const HW_BASE = 760;

// Test several radius profiles; report which keeps minR-hw > floor with most reversals.
function makeProfile(amps: number[], phases: number[], harmonics: number[], rbase: number) {
  return (theta: number) => {
    let r = rbase;
    for (let i = 0; i < harmonics.length; i++) r += amps[i] * Math.sin(theta * harmonics[i] + phases[i]);
    return r;
  };
}
function gen(prof: (t:number)=>number): [number,number,number][] {
  const cps: [number,number,number][] = [];
  for (let i = 0; i < N; i++) { const theta = (i/N)*2*Math.PI; const r = prof(theta); cps.push([Math.round(r*Math.cos(theta)), Math.round(r*Math.sin(theta)), HW_BASE]); }
  return cps;
}
function evalRing(label: string, prof: (t:number)=>number) {
  const RING = gen(prof);
  const spline = new ReefSpline(RING.map(([x,z,halfWidth])=>({x,z,halfWidth})), { closed: true });
  const arc = spline.totalArcLength;
  function curv(t:number){const h=1/SAMPLES;const a=spline.centerlineAt(((t-h)%1+1)%1);const b=spline.centerlineAt(t%1);const c=spline.centerlineAt((t+h)%1);const d1x=(c.x-a.x)/(2*h),d1z=(c.z-a.z)/(2*h),d2x=(c.x-2*b.x+a.x)/(h*h),d2z=(c.z-2*b.z+a.z)/(h*h);return (d1x*d2z-d1z*d2x)/(Math.pow(d1x*d1x+d1z*d1z,1.5)||1e-9);}
  let minR=Infinity,minRt=0,reversals=0,prevSign=0;
  for(let i=1;i<=SAMPLES;i++){const t=i/SAMPLES;const k=Math.abs(curv(t));const r=k>1e-9?1/k:Infinity;if(r<minR){minR=r;minRt=t;}const cs=Math.sign(curv(t));if(cs!==0&&prevSign!==0&&cs!==prevSign)reversals++;if(cs!==0)prevSign=cs;}
  let prevH=Math.atan2(spline.tangentAt(0).z,spline.tangentAt(0).x),sweep=0;
  for(let i=1;i<=SAMPLES;i++){const t=i/SAMPLES;const tg=spline.tangentAt(t%1);let h=Math.atan2(tg.z,tg.x);let d=h-prevH;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;sweep+=d;prevH=h;}
  const margin = minR - HW_BASE;
  let xMin=Infinity,xMax=-Infinity,zMin=Infinity,zMax=-Infinity;
  for(let i=0;i<SAMPLES;i+=4){const c=spline.centerlineAt(i/SAMPLES);if(c.x<xMin)xMin=c.x;if(c.x>xMax)xMax=c.x;if(c.z<zMin)zMin=c.z;if(c.z>zMax)zMax=c.z;}
  console.log(`${label}: arc=${arc.toFixed(0)} sweep=${(sweep/Math.PI).toFixed(2)}pi rev=${reversals} minR=${minR.toFixed(0)} margin=${margin.toFixed(0)} ${margin>CARVE_FLOOR?'OK':'TIGHT'} foot=${(xMax-xMin).toFixed(0)}x${(zMax-zMin).toFixed(0)}`);
}
// progressively gentler high harmonics
evalRing('P1 base', makeProfile([2600,1700,1100,700],[0.3,1.1,0.6,2.0],[2,3,5,7],12000));
evalRing('P2 softer5,7', makeProfile([2600,1700,600,300],[0.3,1.1,0.6,2.0],[2,3,5,7],12000));
evalRing('P3 only 2,3,4', makeProfile([2800,1900,1100],[0.3,1.1,0.6],[2,3,4],12000));
evalRing('P4 2,3,5 soft', makeProfile([2600,1500,700],[0.3,1.1,0.6],[2,3,5],12500));
evalRing('P5 2,4,6 soft', makeProfile([2800,1200,700],[0.3,1.1,0.6],[2,4,6],12500));
evalRing('P6 3,5 mild', makeProfile([2400,1100],[0.4,0.9],[3,5],12500));
evalRing('P7 2,3,4,5 graded', makeProfile([2600,1600,900,450],[0.3,1.1,0.6,1.7],[2,3,4,5],12500));
