import { REEF_RACE_DEFAULT_TRACK } from '../packages/shared/src/reef-race/track-layout';
import { ReefSpline } from '../packages/shared/src/reef-race/spline';
const sp=new ReefSpline(REEF_RACE_DEFAULT_TRACK,{closed:true});
const headingAt=(tt:number)=>{const tg=sp.tangentAt(tt);return Math.atan2(tg.z,tg.x);};
const h=0.004;
let maxRate=0,minRate=0;const rates:number[]=[];
for(let i=0;i<2000;i++){const u=i/2000;const a0=headingAt(((u-h)%1+1)%1);const a1=headingAt((u+h)%1);let d=a1-a0;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;const rate=d/(2*h);rates.push(rate);if(rate>maxRate)maxRate=rate;if(rate<minRate)minRate=rate;}
rates.sort((a,b)=>Math.abs(b)-Math.abs(a));
const cap=28*Math.PI/180;
console.log(`rate range=[${minRate.toFixed(3)},${maxRate.toFixed(3)}] rad/t`);
console.log(`abs rate p99=${Math.abs(rates[Math.floor(rates.length*0.01)]).toFixed(3)}  p90=${Math.abs(rates[Math.floor(rates.length*0.10)]).toFixed(3)}  median=${Math.abs(rates[Math.floor(rates.length*0.5)]).toFixed(3)}`);
// gain so that the MAX rate -> ~cap (so tightest corner ~28deg, rest proportional)
const maxAbs=Math.max(Math.abs(minRate),Math.abs(maxRate));
console.log(`gain to hit cap at max rate: ${(cap/maxAbs).toFixed(3)}`);
// gain so p90 corner ~ 20deg
const p90=Math.abs(rates[Math.floor(rates.length*0.10)]);
console.log(`gain so p90 corner ~20deg: ${((20*Math.PI/180)/p90).toFixed(3)}`);
// test gain candidates
for(const g of [0.6,0.8,1.0,1.2,1.5,2.0]){
  let sat=0,maxd=0;const samp:number[]=[];
  for(const r of rates.slice(0,2000)){let b=Math.max(-cap,Math.min(cap,r*g));if(Math.abs(Math.abs(b)-cap)<1e-6)sat++;if(Math.abs(b)>maxd)maxd=Math.abs(b);samp.push(Math.abs(b));}
  console.log(`gain ${g}: maxBank=${(maxd*180/Math.PI).toFixed(1)}deg saturated=${(sat/2000*100).toFixed(1)}%`);
}
