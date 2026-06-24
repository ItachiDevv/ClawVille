import { ReefSpline, REEF_RACE_DEFAULT_TRACK, reefTrackElevationAt, reefTrackBankAngleAt } from '@clawville/shared';
const sp = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
const headingAt = (tt:number) => { const tg = sp.tangentAt(tt); return Math.atan2(tg.z, tg.x); };
const WATER_SEAL_DROP = 40, RIBBON_SAMPLES = 320;
interface P { x:number;y:number;z:number; }
function edgeAt(t:number, side:1|-1, mode:'water'|'canyon'): P {
  const c=sp.centerlineAt(t), n=sp.normalAt(t), hw=sp.widthAt(t);
  const y=reefTrackElevationAt(t), bank=reefTrackBankAngleAt(t,headingAt);
  const cb=Math.cos(bank), sb=Math.sin(bank);
  const unx=n.x*cb, uny=sb, unz=n.z*cb;
  return { x:c.x+unx*hw*side, y:y+uny*hw*side-(mode==='canyon'?WATER_SEAL_DROP:0), z:c.z+unz*hw*side };
}
function poly(N:number, side:1|-1){ const a:P[]=[]; for(let i=0;i<N;i++) a.push(edgeAt(i/N,side,'canyon')); return a; }
function closest(q:P, pl:P[]){ let best=Infinity,by=pl[0].y,M=pl.length;
  for(let i=0;i<M;i++){ const a=pl[i],b=pl[(i+1)%M]; const abx=b.x-a.x,abz=b.z-a.z,apx=q.x-a.x,apz=q.z-a.z;
    const ab2=abx*abx+abz*abz; let s=ab2>0?(apx*abx+apz*abz)/ab2:0; s=s<0?0:s>1?1:s;
    const px=a.x+abx*s,pz=a.z+abz*s,dx=q.x-px,dz=q.z-pz,d2=dx*dx+dz*dz;
    if(d2<best){best=d2;by=a.y+(b.y-a.y)*s;} } return {y:by,perp:Math.sqrt(best)}; }
function proof(cN:number){ let wra=-Infinity,wt=0,ws=0,ms=0,mt=0,mss=0;
  for(const side of [1,-1] as const){ const cp=poly(cN,side);
    for(let j=0;j<RIBBON_SAMPLES;j++){ const t=j/RIBBON_SAMPLES,w=edgeAt(t,side,'water'),{y,perp}=closest(w,cp);
      const ra=y-w.y; if(ra>wra){wra=ra;wt=t;ws=side;} if(perp>ms){ms=perp;mt=t;mss=side;} } }
  return {cN,wra,wt,ws,ms,mt,mss}; }
for(const N of [224,320]){ const r=proof(N);
  console.log(`CANYON=${N} vs water320: rock-above-water max=${r.wra.toFixed(3)}wu @t=${r.wt.toFixed(4)} side=${r.ws} (<=0 required) | lateral sliver max=${r.ms.toFixed(3)}wu @t=${r.mt.toFixed(4)} side=${r.mss}`); }
// also specifically report at tightest-R t≈0.670 + a high-bank t
console.log('--- spot checks at tightest-R + high-bank (CANYON=320) ---');
const cp1=poly(320,1), cpm1=poly(320,-1);
for(const t of [0.670, 0.703, 0.0]){ for(const [cp,side] of [[cp1,1],[cpm1,-1]] as const){
  const w=edgeAt(t,side,'water'); const {y,perp}=closest(w,cp);
  console.log(`  t=${t.toFixed(3)} side=${side}: rock-above-water=${(y-w.y).toFixed(3)}wu sliver=${perp.toFixed(3)}wu`); } }
