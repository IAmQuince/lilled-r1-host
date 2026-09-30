// Portable pitch, modulation, figures and factory patches from
// LED/apps/synth/presentations/touch-portrait-368x448/synthesizer.cpp.
const clamp=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
const DEGREES=[0,3,5,7,10];
export const SYNTH_PRESETS=['INIT','SPACE','PLUCK','DRONE','BASS PAD','GLASS'];
export const MOD_TARGETS=['NONE','PITCH','DELAY','FEEDBACK','REVERB','FILTER','ARP SPAN','ARP RATE','OUTPUT'];
export const MOD_CURVES=['LINEAR','SMOOTH','EXPONENTIAL'];
const mod=(target,minimum,maximum,curve='LINEAR')=>({target,minimum,maximum,curve});

export function quantizePentatonic(rawMidi,floorMidi=48,ceilingMidi=84){
  let low=clamp(Math.round(Math.min(floorMidi,ceilingMidi)),24,84);
  let high=clamp(Math.round(Math.max(floorMidi,ceilingMidi)),24,84);
  const target=clamp(rawMidi,low,high);
  let best=null,distance=Infinity;
  for(let midi=low;midi<=high;midi++){
    if(!DEGREES.includes(((midi%12)+12)%12))continue;
    const next=Math.abs(midi-target);
    if(next<distance){best=midi;distance=next;}
  }
  return best??Math.round(target);
}
export function midiFromDegree(degree){
  const index=Math.max(0,Math.trunc(degree));
  return clamp(36+Math.floor(index/5)*12+DEGREES[index%5],24,84);
}
export function patternOffset(pattern,step,spanDegrees){
  const span=Math.max(1,Math.trunc(spanDegrees)),at=Math.max(0,Math.trunc(step));
  if(pattern==='DOWN')return span-1-at%span;
  if(pattern==='UPDOWN'){
    if(span===1)return 0;
    const period=span*2-2,pos=at%period;
    return pos<span?pos:period-pos;
  }
  if(pattern==='CONVERGE'){
    const pos=at%span;
    return pos%2===0?Math.floor(pos/2):span-1-Math.floor(pos/2);
  }
  return at%span;
}
export const midiToFrequency=midi=>440*2**((midi-69)/12);
export function factoryPatch(name='INIT'){
  const patch={preset:name,waveform:'SINE',volume:15,tempo:110,transpose:0,pitchFloor:48,pitchCeiling:84,
    mods:[mod('DELAY',.060,.450),mod('FEEDBACK',.05,.65,'SMOOTH'),mod('PITCH',48,72),mod('REVERB',.20,.75,'SMOOTH')]};
  switch(name){
    case 'SPACE':Object.assign(patch,{tempo:96,volume:14});patch.mods=[mod('DELAY',.12,.60,'SMOOTH'),mod('FEEDBACK',.25,.78,'SMOOTH'),patch.mods[2],mod('REVERB',.35,.90,'SMOOTH')];break;
    case 'PLUCK':Object.assign(patch,{waveform:'TRIANGLE',tempo:132,volume:16});patch.mods=[mod('DELAY',.03,.18),mod('FEEDBACK',0,.30),patch.mods[2],mod('FILTER',1200,6500,'EXPONENTIAL')];break;
    case 'DRONE':Object.assign(patch,{tempo:60,volume:13,pitchFloor:36,pitchCeiling:72});patch.mods=[mod('FILTER',800,5000,'SMOOTH'),mod('REVERB',.25,.85,'SMOOTH'),mod('PITCH',36,60,'SMOOTH'),mod('DELAY',.18,.60,'SMOOTH')];break;
    case 'BASS PAD':Object.assign(patch,{waveform:'SQUARE',tempo:88,volume:13,pitchFloor:36,pitchCeiling:67});patch.mods=[mod('FILTER',600,3200,'EXPONENTIAL'),mod('DELAY',.08,.32),mod('PITCH',36,55),mod('REVERB',.10,.55)];break;
    case 'GLASS':Object.assign(patch,{waveform:'TRIANGLE',tempo:118,volume:14});patch.mods=[mod('DELAY',.03,.12),mod('REVERB',.10,.50,'SMOOTH'),mod('PITCH',48,76),mod('FILTER',2200,7000,'EXPONENTIAL')];break;
  }
  return patch;
}
export function resolveSynthParams(patch,padX,padY,imu={}){
  const floor=clamp(Number(patch.pitchFloor??48),24,84),ceiling=clamp(Number(patch.pitchCeiling??84),24,84);
  let rawPitch=(floor+ceiling)/2;
  const result={delay:.24,feedback:.28,reverb:.20,filterHz:5200,arpSpan:clamp(patch.arpSpan??2,1,4),arpRate:clamp(patch.arpRate??2,1,4),outputLevel:1};
  const mods=Array.isArray(patch.mods)?patch.mods:factoryPatch().mods;
  mods.slice(0,4).forEach((assignment,index)=>{
    if(!assignment||assignment.target==='NONE')return;
    const input=clamp(index<2?padX:1-padY,0,1);
    const shaped=assignment.curve==='SMOOTH'?input*input*(3-2*input):assignment.curve==='EXPONENTIAL'?input*input:input;
    const value=Number(assignment.minimum)+(Number(assignment.maximum)-Number(assignment.minimum))*shaped;
    switch(assignment.target){
      case 'PITCH':rawPitch=value;break;case 'DELAY':result.delay=value;break;case 'FEEDBACK':result.feedback=value;break;
      case 'REVERB':result.reverb=value;break;case 'FILTER':result.filterHz=value;break;
      case 'ARP SPAN':result.arpSpan=Math.round(value);break;case 'ARP RATE':result.arpRate=Math.round(value);break;
      case 'OUTPUT':result.outputLevel=value;break;
    }
  });
  result.rootMidi=quantizePentatonic(rawPitch,floor,ceiling);
  if(imu.ready){result.delay*=1+clamp(imu.delay,-1,1)*.4;result.reverb+=clamp(imu.reverb,-1,1)*.16;}
  result.delay=clamp(result.delay,.03,.6);result.feedback=clamp(result.feedback,0,.85);
  result.reverb=clamp(result.reverb,0,.9);result.filterHz=clamp(result.filterHz,250,7000);
  result.arpSpan=clamp(result.arpSpan,1,4);result.arpRate=clamp(result.arpRate,1,4);
  result.outputLevel=clamp(result.outputLevel,.1,1);
  return result;
}
export function triggeredMidi(patch,resolved,degreeOffset){
  const degree=Math.max(0,Math.trunc(degreeOffset)),octave=Math.floor(degree/5);
  return clamp(resolved.rootMidi+octave*12+DEGREES[degree%5]+Number(patch.transpose||0),
    Math.min(patch.pitchFloor,patch.pitchCeiling),Math.max(patch.pitchFloor,patch.pitchCeiling));
}
