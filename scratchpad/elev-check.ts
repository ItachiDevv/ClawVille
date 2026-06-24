import { reefTrackElevationAt } from '../packages/shared/src/reef-race/track-layout';
import { ReefSpline } from '../packages/shared/src/reef-race/spline';
// Verify elevation grade against the NEW arc (88052). Grade = dY/ds.
const ARC = 88051.9; const SAMPLES = 4000;
let yMin=Infinity,yMax=-Infinity,maxGrade=0;
for(let i=0;i<=SAMPLES;i++){const t=i/SAMPLES;const y=reefTrackElevationAt(t);if(y<yMin)yMin=y;if(y>yMax)yMax=y;}
for(let i=0;i<SAMPLES;i++){const t0=i/SAMPLES,t1=(i+1)/SAMPLES;const dy=reefTrackElevationAt(t1)-reefTrackElevationAt(t0);const ds=(t1-t0)*ARC;const g=Math.abs(dy/ds);if(g>maxGrade)maxGrade=g;}
console.log(`elevation Y=[${yMin.toFixed(0)},${yMax.toFixed(0)}] span=${(yMax-yMin).toFixed(0)} maxGrade=${(maxGrade*100).toFixed(1)}% (vs old 29.3% at arc 60257)`);
// seam continuity
const y0=reefTrackElevationAt(0), y1=reefTrackElevationAt(1);
const h=1e-4;const s0=(reefTrackElevationAt(0+h)-reefTrackElevationAt(1-h))/(2*h);
console.log(`seam Y(0)=${y0.toFixed(3)} Y(1)=${y1.toFixed(3)} ${Math.abs(y0-y1)<0.01?'OK closed':'BAD'}`);
// lap budget
console.log(`lap budget: ${ARC}/330*1.10 = ${(ARC/330*1.10).toFixed(0)}s = ${Math.round(ARC/330*1.10*1000)}ms`);
