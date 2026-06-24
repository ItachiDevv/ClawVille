import { reefTrackBankAngleAt, REEF_RACE_DEFAULT_TRACK } from '../packages/shared/src/reef-race/track-layout';
import { ReefSpline } from '../packages/shared/src/reef-race/spline';
const sp=new ReefSpline(REEF_RACE_DEFAULT_TRACK,{closed:true});
const headingAt=(tt:number)=>{const tg=sp.tangentAt(tt);return Math.atan2(tg.z,tg.x);};
// print bank every 0.05 to see the profile shape
for(let i=0;i<=20;i++){const t=i/20;const b=reefTrackBankAngleAt(t,headingAt);console.log(`t${t.toFixed(2)} bank=${(b*180/Math.PI).toFixed(1)}deg`);}
