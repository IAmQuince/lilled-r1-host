// Relative interpretation of simulated signal changes. No occupancy or identity claim.
export function analyzeRelativeSignal(samples){
  const values=samples.slice(-48).map(sample=>Number(sample.v)).filter(Number.isFinite);
  if(values.length<12)return {label:'UNCERTAIN',change:0,baseline:0,confidence:0};
  const half=Math.floor(values.length/2),baseline=values.slice(0,half).reduce((a,b)=>a+b,0)/half;
  const current=values.slice(half).reduce((a,b)=>a+b,0)/(values.length-half);
  const change=Math.abs(current-baseline),range=Math.max(...values)-Math.min(...values);
  const label=change>.3?'SCENE CHANGED':range>.65?'HIGH ACTIVITY':range>.35?'MOVEMENT':'QUIET';
  return {label,change,baseline,confidence:Math.min(1,values.length/48)};
}
