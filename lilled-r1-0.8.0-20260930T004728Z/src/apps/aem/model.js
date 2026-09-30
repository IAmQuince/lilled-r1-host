// Numerical port of LED/apps/aem/core/aem_model.cpp. The UI supplies config;
// this module never invents a sensor reading or a performance claim.
const FARADAY=96485.33212,REVERSIBLE=1.229,THERMONEUTRAL=1.481,MAX_J=3.5*.995;
const clamp=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
export const DEFAULT_AEM_CONFIG=Object.freeze({voltageMode:false,usefulCurrentDensityAcm2:.98,
  cellVoltageSetpointV:1.89531695,activeAreaCm2:100,faradaicEfficiency:.98,
  membraneResistivityOhmCm:12,membraneThicknessUm:100,membraneCapacityPackets:36,waterPacketsPerSecond:32});

const membraneAsr=c=>clamp(c.membraneResistivityOhmCm,2,60)*clamp(c.membraneThicknessUm,25,300)*1e-4;
export function voltageAtTotalCurrentDensity(config,j){
  const density=clamp(j,0,MAX_J);
  const activation=.105*Math.asinh(density/.035);
  const ohmic=density*(.11+membraneAsr(config));
  const normalized=clamp(density/3.5,0,.995);
  const concentration=-.085*Math.log(Math.max(1e-12,1-Math.pow(normalized,1.65)));
  return REVERSIBLE+activation+ohmic+concentration;
}
export function solveAemCurrentDensityForVoltage(config,targetVoltageV){
  const target=clamp(targetVoltageV,REVERSIBLE,3.2);
  if(target<=REVERSIBLE)return 0;
  if(target>=voltageAtTotalCurrentDensity(config,MAX_J))return MAX_J;
  let low=0,high=MAX_J;
  for(let i=0;i<32;i++){
    const midpoint=(low+high)*.5;
    if(voltageAtTotalCurrentDensity(config,midpoint)<target)low=midpoint;else high=midpoint;
  }
  return (low+high)*.5;
}
export function calculateAemMetrics(source={}){
  const c={...DEFAULT_AEM_CONFIG,...source};
  c.activeAreaCm2=clamp(c.activeAreaCm2,.01,100000);
  c.faradaicEfficiency=clamp(c.faradaicEfficiency,0,1);
  c.waterPacketsPerSecond=clamp(c.waterPacketsPerSecond,0,80);
  c.membraneCapacityPackets=clamp(c.membraneCapacityPackets,4,200);
  const m={curveMaximumVoltageV:voltageAtTotalCurrentDensity(c,MAX_J),voltageSetpointLimited:false,
    totalCurrentDensityAcm2:0,usefulCurrentDensityAcm2:0};
  if(c.voltageMode){
    m.voltageSetpointLimited=c.cellVoltageSetpointV>m.curveMaximumVoltageV+1e-5;
    m.totalCurrentDensityAcm2=solveAemCurrentDensityForVoltage(c,c.cellVoltageSetpointV);
    m.usefulCurrentDensityAcm2=m.totalCurrentDensityAcm2*c.faradaicEfficiency;
  }else if(c.faradaicEfficiency>1e-9){
    m.totalCurrentDensityAcm2=clamp(Math.max(0,c.usefulCurrentDensityAcm2)/c.faradaicEfficiency,0,MAX_J);
    m.usefulCurrentDensityAcm2=m.totalCurrentDensityAcm2*c.faradaicEfficiency;
  }
  m.cellVoltageV=voltageAtTotalCurrentDensity(c,m.totalCurrentDensityAcm2);
  m.currentA=m.totalCurrentDensityAcm2*c.activeAreaCm2;
  m.powerW=m.currentA*m.cellVoltageV;
  const h2MolPerSecond=m.usefulCurrentDensityAcm2*c.activeAreaCm2/(2*FARADAY);
  m.hydrogenGramsPerHour=h2MolPerSecond*2.01588*3600;
  m.hydrogenLitersPerMinute=h2MolPerSecond*(.08314462618*273.15/1.01325)*60;
  m.overallEfficiency=m.cellVoltageV>0?THERMONEUTRAL/m.cellVoltageV*c.faradaicEfficiency:0;
  m.membraneAsrOhmCm2=membraneAsr(c);
  m.membraneVisualWidthPx=clamp(70+.8*clamp(c.membraneThicknessUm,25,300),70,280);
  m.hydroxideVisualVelocityPxS=clamp(125*Math.pow(12/clamp(c.membraneResistivityOhmCm,2,60),.70),24,340);
  m.membraneResidenceSeconds=m.membraneVisualWidthPx/m.hydroxideVisualVelocityPxS;
  const feedLimit=c.waterPacketsPerSecond*FARADAY*.5e-6;
  const membraneLimit=c.membraneCapacityPackets/m.membraneResidenceSeconds*FARADAY*.5e-6;
  m.transportLimitAcm2=Math.min(feedLimit,membraneLimit);
  m.bottleneck=membraneLimit<feedLimit?'AEM':'WATER';
  m.transportUtilization=m.transportLimitAcm2>0?m.usefulCurrentDensityAcm2/m.transportLimitAcm2:m.usefulCurrentDensityAcm2>0?Infinity:0;
  const supportedDensity=Math.min(m.usefulCurrentDensityAcm2,m.transportLimitAcm2);
  m.supportedHydrogenGramsPerHour=supportedDensity*c.activeAreaCm2/(2*FARADAY)*2.01588*3600;
  m.realizedEfficiency=m.totalCurrentDensityAcm2>1e-9&&m.cellVoltageV>0?
    THERMONEUTRAL*supportedDensity/(m.cellVoltageV*m.totalCurrentDensityAcm2):0;
  m.transportLimited=supportedDensity+1e-6<m.usefulCurrentDensityAcm2;
  m.regime=m.totalCurrentDensityAcm2<=1e-6?'idle':m.totalCurrentDensityAcm2<=.35?'activation':
    m.totalCurrentDensityAcm2>=2.625?'mass transport':'ohmic';
  return m;
}
