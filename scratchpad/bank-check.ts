import { reefTrackBankAngleAt, REEF_RACE_DEFAULT_TRACK } from '../packages/shared/src/reef-race/track-layout';
import { ReefSpline } from '../packages/shared/src/reef-race/spline';
const sp=new ReefSpline(REEF_RACE_DEFAULT_TRACK,{closed:true});
const headingAt=(tt:number)=>{const tg=sp.tangentAt(tt);return Math.atan2(tg.z,tg.x);};
// find the t with the largest |bank|
let best=0,bestT=0;const tops:{t:number,b:number}[]=[];
for(let i=0;i<=2000;i++){const t=i/2000;const b=Math.abs(reefTrackBankAngleAt(t,headingAt));if(b>best){best=b;bestT=t;}tops.push({t,b});}
tops.sort((a,b)=>b.b-a.b);
console.log('max bank deg=',(best*180/Math.PI).toFixed(1),'@t',bestT.toFixed(3));
console.log('top bank t-values:', tops.slice(0,10).map(x=>`t${x.t.toFixed(3)}=${(x.b*180/Math.PI).toFixed(0)}deg`).join(' '));
// pick two well-separated tight ts for the test
