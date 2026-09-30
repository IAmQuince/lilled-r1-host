// Portable performance decisions from LED/apps/percussion/core/percussion_pattern.h.
const clamp=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
const VOICES=['kick','snare','tom','hat'];
export const percussionNextLoopStart=step=>(Math.floor(step/16)+1)*16;
export function percussionPerformanceVelocity(voice,energy,groove,step){
  const index=VOICES.indexOf(voice);if(index<0)return 0;
  const base=[.96,.52,.61,.34],gain=[.018,.014,.025,.070];
  let velocity=base[index]+gain[index]*(clamp(energy,1,4)-1);
  if(groove===1&&(voice==='kick'||voice==='tom'))velocity+=.08;
  if(groove===4&&voice==='hat')velocity+=.10;
  const beat=step&3;
  if(voice==='kick'&&beat===0)velocity+=.04;
  if(voice==='hat'){if(beat===2)velocity+=.15;if(beat&1)velocity-=.08;}
  return clamp(velocity,.05,1);
}
export function percussionVariationAt(variation,age){
  const empty={addMask:0,accentMask:0,suppressMask:0};
  if(!variation||variation.mode==='NONE'||age>=variation.durationSteps||age<0)return empty;
  const rate=variation.intensity>=70?1:variation.intensity>=38?2:4;
  const seeded=age+variation.seed,selected=seeded&3,bit=1<<selected;
  const step={...empty};
  switch(variation.mode){
    case 'ACCENT':if(age===0||age%rate===0){step.addMask=bit;step.accentMask=15|bit;}break;
    case 'FORWARD FILL':if(age%rate===0){step.addMask=bit;step.accentMask=bit;}break;
    case 'REVERSE FILL':if(age%rate===0){const reverse=(variation.seed+4-(age&3))&3;step.addMask=1<<reverse;if(age&1)step.addMask|=3;step.accentMask=step.addMask;}break;
    case 'BRIGHT ROLL':if(age%rate===0)step.addMask|=8;if((seeded&3)===2)step.addMask|=2;step.accentMask=step.addMask;if(variation.intensity>=75)step.suppressMask=4;break;
    case 'HEAVY DROP':if(age%rate===0)step.addMask|=1;if((seeded&1)===0)step.addMask|=4;step.accentMask=step.addMask;if(variation.intensity>=62)step.suppressMask=8;break;
  }
  return step;
}
export function percussionVariationDelaySeconds(mode,bpm){
  const beats={'ACCENT':.25,'FORWARD FILL':.5,'REVERSE FILL':.75,'BRIGHT ROLL':1/3,'HEAVY DROP':.75}[mode]||0;
  return beats?clamp(60/clamp(bpm,40,240)*beats,.045,.55):0;
}
export function percussionVariationFx(variation){
  if(!variation||variation.mode==='NONE'||!variation.durationSteps)return {mix:0,feedback:0,reverbBoost:0};
  return {mix:Math.min(.46,.12+variation.intensity*.0024+variation.speed*.0012),
    feedback:Math.min(.34,.10+variation.intensity*.0024),
    reverbBoost:Math.min(.15,.035+variation.intensity*.00115)};
}
export function variationFromRetouch(from,to,gapMs,elapsedMs,serial=1){
  if(gapMs<0||gapMs>650)return null;
  const dx=to.x-from.x,dy=to.y-from.y,distance=Math.hypot(dx,dy);
  const speed=clamp(Math.round(distance/Math.max(1,elapsedMs)*250),0,100);
  const intensity=clamp(Math.round(distance*.7+speed*.35),20,100);
  const mode=Math.abs(dx)>Math.abs(dy)?dx>=0?'FORWARD FILL':'REVERSE FILL':dy<0?'BRIGHT ROLL':'HEAVY DROP';
  return {serial,mode,intensity,durationSteps:clamp(Math.round(4+intensity*.12),4,16),
    seed:clamp(Math.floor((to.x+to.y)*4),0,255),directionX:clamp(Math.round(dx),-100,100),
    directionY:clamp(Math.round(dy),-100,100),speed,gapMs};
}
