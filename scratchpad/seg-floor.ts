import { REEF_RACE_DEFAULT_TRACK, REEF_RACE_SEGMENTS } from '../packages/shared/src/reef-race/track-layout';
import { ReefSpline } from '../packages/shared/src/reef-race/spline';
const sp=new ReefSpline(REEF_RACE_DEFAULT_TRACK,{closed:true});
const MAXSPD=500;
for(const seg of REEF_RACE_SEGMENTS){
  const arc=sp.arclengthFromT(seg.tEnd)-sp.arclengthFromT(seg.tStart);
  const floor=arc/MAXSPD*0.7*1000;
  console.log(`${seg.id.padEnd(10)} t[${seg.tStart.toFixed(3)},${seg.tEnd.toFixed(3)}] arc=${arc.toFixed(0)}wu floor=${floor.toFixed(0)}ms`);
}
