/**
 * scratchpad/width-scan.ts — find the WIDEST safe corridor for the v5.2 ring.
 * Scans, for a given uniform/scaled half-width profile, the min inter-pass edge
 * clearance (must stay positive with margin so corridors never overlap and the
 * sim closestPointOnSpline never snaps to the wrong pass), plus min radius and
 * a "corridor fits the carve" sanity (hw must be < min radius so a racing line
 * exists inside the corridor on the tightest corner).
 */
import { ReefSpline, type SplineControlPoint } from '../packages/shared/src/reef-race/spline';

// XZ positions of the LOCKED v5.2 ring (unchanged). We only re-scale halfWidth.
const POS: [number, number][] = [
  [-2400,-8200],[200,-8500],[2900,-8200],
  [5200,-7000],[7000,-5000],[8100,-3000],[8400,-900],[7300,600],[6000,600],
  [5000,1400],[5600,2800],[4900,4100],[5500,5300],[4500,6200],
  [3000,6600],[1300,7000],[400,8400],[-1500,7900],
  [-3600,7100],[-5600,6200],[-7700,4900],[-9000,3000],[-9100,900],[-7600,-300],
  [-5800,-1100],[-5000,-2600],[-6200,-3700],
  [-7400,-4200],[-7600,-5900],[-6500,-7100],[-5000,-7900],[-3300,-8100],
];
const N = POS.length;

// Per-CP base half-widths from the locked v5.2 layout.
const BASE_HW = [480,460,420, 400,380,360,360,360,380, 380,360,360,360,360, 340,300,280,320, 360,360,360,360,360,380, 380,360,360, 360,400,440,460,470];

const SAMPLES = 4000;
const ARC_SKIP = 4200;

function build(hw: number[]): ReefSpline {
  const cps: SplineControlPoint[] = POS.map(([x,z], i) => ({ x, z, halfWidth: hw[i] }));
  return new ReefSpline(cps, { closed: true });
}

function analyze(label: string, hw: number[]) {
  const spline = build(hw);
  const arc = spline.totalArcLength;
  // sample list
  const sList: { t:number; x:number; z:number; hw:number; s:number }[] = [];
  for (let i = 0; i < SAMPLES; i += 6) {
    const t = i / SAMPLES; const c = spline.centerlineAt(t);
    sList.push({ t, x:c.x, z:c.z, hw: spline.widthAt(t), s: spline.arclengthFromT(t) });
  }
  let worstEdge = Infinity, worstPair = '';
  for (let a=0;a<sList.length;a++) for (let b=a+1;b<sList.length;b++){
    const A=sList[a],B=sList[b];
    let ds=Math.abs(A.s-B.s); ds=Math.min(ds,arc-ds);
    if (ds<ARC_SKIP) continue;
    const xz=Math.hypot(A.x-B.x,A.z-B.z);
    const edge=xz-A.hw-B.hw;
    if (edge<worstEdge){worstEdge=edge; worstPair=`t${A.t.toFixed(3)}~t${B.t.toFixed(3)} xz=${xz.toFixed(0)} hw=${A.hw.toFixed(0)}/${B.hw.toFixed(0)}`;}
  }
  // min radius
  function curv(t:number){const h=1/SAMPLES;const a=spline.centerlineAt(((t-h)%1+1)%1);const b=spline.centerlineAt(t%1);const c=spline.centerlineAt((t+h)%1);const d1x=(c.x-a.x)/(2*h),d1z=(c.z-a.z)/(2*h),d2x=(c.x-2*b.x+a.x)/(h*h),d2z=(c.z-2*b.z+a.z)/(h*h);return (d1x*d2z-d1z*d2x)/(Math.pow(d1x*d1x+d1z*d1z,1.5)||1e-9);}
  let minR=Infinity,minRt=0; for(let i=1;i<=SAMPLES;i++){const t=i/SAMPLES;const r=Math.abs(curv(t))>1e-9?1/Math.abs(curv(t)):Infinity;if(r<minR){minR=r;minRt=t;}}
  let hwMin=Infinity,hwMax=-Infinity; for(let i=0;i<SAMPLES;i++){const w=spline.widthAt(i/SAMPLES);if(w<hwMin)hwMin=w;if(w>hwMax)hwMax=w;}
  // hw at the min-radius point (does a racing line fit?)
  const hwAtMinR = spline.widthAt(minRt);
  console.log(`\n=== ${label} ===`);
  console.log(`  arc=${arc.toFixed(0)}  hw=[${hwMin.toFixed(0)},${hwMax.toFixed(0)}] (ribbon ${(2*hwMin).toFixed(0)}-${(2*hwMax).toFixed(0)} wide)`);
  console.log(`  min R=${minR.toFixed(1)} @t${minRt.toFixed(3)}  hw_there=${hwAtMinR.toFixed(0)}  ${minR>hwAtMinR?'OK line-fits':'*** hw>=R wall-clamp risk ***'}`);
  console.log(`  worst inter-pass EDGE clearance = ${worstEdge.toFixed(1)} wu  ${worstEdge>300?'OK':'*** TOO TIGHT — corridors near/overlap ***'}`);
  console.log(`    ${worstPair}`);
}

// Strategy A: uniform scale ×2.0
analyze('A: scale x2.0', BASE_HW.map(w=>Math.round(w*2.0)));
// Strategy B: scale x1.9
analyze('B: scale x1.9', BASE_HW.map(w=>Math.round(w*1.9)));
// Strategy C: target ~[700,1100] — map base [280,480] -> [700,1100] linearly
analyze('C: remap [280,480]->[700,1100]', BASE_HW.map(w=>Math.round(700 + (w-280)*(1100-700)/(480-280))));
// Strategy D: flatter, wide & uniform ~820 everywhere, a bit wider on straights
analyze('D: ~760 esses / 980 straights', BASE_HW.map(w=>Math.round(760 + (w-280)*(980-760)/(480-280))));
