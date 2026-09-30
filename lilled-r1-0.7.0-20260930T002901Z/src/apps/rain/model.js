// Port of LED/apps/rain/core/rain_model.{hpp,cpp}. World units and constants
// are deliberately retained; the R1 view scales this world to its panel.
export const RainPrediction={SWEPT:'LIVE SWEPT',LEGACY:'LEGACY'};
export const RAIN_WORLD={width:368,height:400,radius:4,maxDrops:144};
const clamp=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
const wrap=x=>((x%368)+368)%368;
const deadZone=.035,fullScale=.45;
const tiltAmount=g=>Math.abs(g)<=deadZone?0:clamp((Math.abs(g)-deadZone)/(fullScale-deadZone),0,1);
export const rainWindTargetFromTilt=g=>Math.sign(g)*tiltAmount(g)*140;
export const rainTargetSpeedFromTilt=g=>Math.sign(g)*tiltAmount(g)*166;
export const rainSpawnSpeedScaleFromPitch=g=>1+tiltAmount(g)*((g<0?.42:1.85)-1);

export function predictsHit(drop,mode,targetX,targetWidth,targetHeight,wind,targetSpeed){
  const overlapAt=t=>{const relative=wrap(drop.x+wind*t-(targetX+targetSpeed*t));return relative<=targetWidth+4||relative>=368-4;};
  const overlapsNow=()=>drop.y+4>=400-targetHeight&&drop.y-4<=400&&overlapAt(0);
  if(drop.fallSpeedPxS<=0)return overlapsNow();
  const enter=Math.max(0,(400-targetHeight-4-drop.y)/drop.fallSpeedPxS);
  const leave=(404-drop.y)/drop.fallSpeedPxS;
  if(leave<enter)return false;
  if(mode===RainPrediction.LEGACY){
    const top=Math.max(0,(400-targetHeight-drop.y)/drop.fallSpeedPxS);
    const bottom=Math.max(0,(400-drop.y)/drop.fallSpeedPxS);
    return overlapAt(top)||overlapAt(bottom);
  }
  const x0=drop.x-targetX,v=wind-targetSpeed;
  if(Math.abs(v)<1e-6)return overlapAt(enter);
  const min=Math.min(x0+v*enter,x0+v*leave),max=Math.max(x0+v*enter,x0+v*leave);
  const first=Math.floor((min-targetWidth-4)/368)-1,last=Math.ceil((max+4)/368)+1;
  for(let copy=first;copy<=last;copy++){
    const a=(-4+copy*368-x0)/v,b=(targetWidth+4+copy*368-x0)/v;
    if(Math.max(enter,Math.min(a,b))<=Math.min(leave,Math.max(a,b)))return true;
  }
  return false;
}

const emptyDrop=()=>({x:0,y:0,fallSpeedPxS:224,active:false,predictedCollision:false,
  predictedAtSpawn:false,actualCollision:false,falseNegativeCollision:false});
export class RainModel{
  constructor(){
    this.drops=Array.from({length:144},emptyDrop);
    this.spawnRate=30;this.fallSpeed=224;this.spawnFallSpeed=224;
    this.targetWidth=46;this.targetHeight=133;this.targetSpeedManual=83;this.targetSpeed=83;
    this.targetSpeedImu=0;this.manualWind=0;this.effectiveWind=0;
    this.paused=false;this.imuWindEnabled=true;this.predictionMode=RainPrediction.SWEPT;
    this.resetRun();
  }
  randomUnit(){this.randomState=(Math.imul(this.randomState,1664525)+1013904223)>>>0;return (this.randomState&0xFFFFFF)/16777216;}
  resetRun(){
    this.randomState=0x29957A5;this.activeDropCount=0;this.spawnAccumulator=0;
    this.targetX=(368-this.targetWidth)/2;
    this.spawned=0;this.hits=0;this.misses=0;this.predictedHits=0;this.falsePositives=0;this.falseNegatives=0;
    this.impactFlashUntil=0;this.hasImpact=false;this.drops.fill(null);for(let i=0;i<144;i++)this.drops[i]=emptyDrop();
  }
  spawnDrop(){
    const index=this.drops.findIndex(d=>!d.active);if(index<0)return;
    const drop=emptyDrop();drop.x=this.randomUnit()*368;drop.fallSpeedPxS=this.spawnFallSpeed;drop.active=true;
    drop.predictedCollision=this.predict(drop);drop.predictedAtSpawn=drop.predictedCollision;
    this.drops[index]=drop;this.activeDropCount++;this.spawned++;
  }
  predict(drop){return predictsHit(drop,this.predictionMode,this.targetX,this.targetWidth,this.targetHeight,this.effectiveWind,this.targetSpeed);}
  overlapsNow(drop){const r=wrap(drop.x-this.targetX);return drop.y+4>=400-this.targetHeight&&drop.y-4<=400&&(r<=this.targetWidth+4||r>=364);}
  update(delta,motion={}){
    if(!Number.isFinite(delta)||delta<=0)return;
    this.nowMs=motion.nowMs??0;
    const fresh=motion.available&&motion.hasSample&&this.nowMs-(motion.sampledAtMs??-Infinity)<=200;
    this.imuControlReady=Boolean(this.imuWindEnabled&&motion.calibrationReady&&fresh);
    this.imuCalibrating=Boolean(this.imuWindEnabled&&motion.calibrating);
    this.imuCalibrationFailed=Boolean(this.imuWindEnabled&&motion.calibrationFailed);
    this.imuCalibrationProgress=clamp(motion.calibrationProgressPercent??0,0,100);
    this.imuMotionValid=!this.imuControlReady||[motion.horizontalG,motion.verticalG,motion.magnitudeG].every(Number.isFinite)&&motion.magnitudeG>=.75&&motion.magnitudeG<=1.25;
    let targetWind=0,targetOffset=0,targetSpawn=this.fallSpeed;
    if(this.imuControlReady&&this.imuMotionValid){
      targetWind=rainWindTargetFromTilt(motion.horizontalG);
      targetOffset=rainTargetSpeedFromTilt(motion.horizontalG);
      targetSpawn=this.fallSpeed*rainSpawnSpeedScaleFromPitch(motion.verticalG);
    }else targetWind=this.imuWindEnabled?0:this.manualWind;
    const dt=Math.min(delta,.08),response=1-Math.exp(-dt/.12);
    this.effectiveWind=clamp(this.effectiveWind+(clamp(targetWind,-140,140)-this.effectiveWind)*response,-140,140);
    this.spawnFallSpeed=clamp(this.spawnFallSpeed,70,430)+(clamp(targetSpawn,70,430)-clamp(this.spawnFallSpeed,70,430))*clamp(dt*12,0,1);
    this.targetSpeedImu=clamp(this.targetSpeedImu+(clamp(targetOffset,-166,166)-this.targetSpeedImu)*response,-166,166);
    this.targetSpeed=clamp(this.targetSpeedManual+this.targetSpeedImu,-166,166);
    if(this.paused)return;
    this.targetX=wrap(this.targetX+this.targetSpeed*dt);
    this.spawnAccumulator+=this.spawnRate*dt;
    while(this.spawnAccumulator>=1&&this.activeDropCount<144){this.spawnDrop();this.spawnAccumulator-=1;}
    if(this.activeDropCount>=144)this.spawnAccumulator=Math.min(this.spawnAccumulator,1);
    this.predictedHits=0;
    for(const drop of this.drops){
      if(!drop.active)continue;
      drop.x=wrap(drop.x+this.effectiveWind*dt);drop.y+=drop.fallSpeedPxS*dt;
      drop.predictedCollision=this.predict(drop);if(drop.predictedCollision)this.predictedHits++;
      if(!drop.actualCollision&&this.overlapsNow(drop)){
        drop.actualCollision=true;this.hits++;
        if(!drop.predictedCollision){drop.falseNegativeCollision=true;this.falseNegatives++;}
        this.impactFlashUntil=this.nowMs+110;this.hasImpact=true;
      }
      if(drop.y<=400)continue;
      if(!drop.actualCollision){this.misses++;if(drop.predictedCollision||drop.predictedAtSpawn)this.falsePositives++;}
      drop.active=false;this.activeDropCount--;
    }
  }
  adjustSpawnRate(d){if(Number.isFinite(d))this.spawnRate=clamp(this.spawnRate+d,0,90);}
  adjustFallSpeed(d){if(Number.isFinite(d)){this.fallSpeed=clamp(this.fallSpeed+d,112,336);this.spawnFallSpeed=this.fallSpeed;}}
  adjustTargetWidth(d){if(Number.isFinite(d))this.targetWidth=clamp(this.targetWidth+Math.trunc(d),32,100);}
  adjustTargetSpeed(d){if(Number.isFinite(d)){this.targetSpeedManual=clamp(this.targetSpeedManual+d,-166,166);this.targetSpeed=clamp(this.targetSpeedManual+this.targetSpeedImu,-166,166);}}
  adjustManualWind(d){if(Number.isFinite(d))this.manualWind=clamp(this.manualWind+d,-140,140);}
  cyclePrediction(){
    this.predictionMode=this.predictionMode===RainPrediction.SWEPT?RainPrediction.LEGACY:RainPrediction.SWEPT;
    this.predictedHits=0;
    for(const d of this.drops){if(!d.active)continue;d.predictedCollision=this.predict(d);d.predictedAtSpawn=d.predictedCollision;if(d.predictedCollision)this.predictedHits++;}
  }
  snapshot(){return {targetX:this.targetX,targetWidth:this.targetWidth,targetHeight:this.targetHeight,effectiveWind:this.effectiveWind,
    spawnFallSpeed:this.spawnFallSpeed,targetSpeed:this.targetSpeed,spawnRate:this.spawnRate,fallSpeed:this.fallSpeed,manualWind:this.manualWind,
    activeDropCount:this.activeDropCount,spawned:this.spawned,hits:this.hits,misses:this.misses,predictedHits:this.predictedHits,
    falsePositives:this.falsePositives,falseNegatives:this.falseNegatives,paused:this.paused,imuWindEnabled:this.imuWindEnabled,
    imuControlReady:this.imuControlReady,imuMotionValid:this.imuMotionValid,imuCalibrating:this.imuCalibrating,
    imuCalibrationFailed:this.imuCalibrationFailed,imuCalibrationProgress:this.imuCalibrationProgress,
    impactFlash:this.hasImpact&&this.nowMs>=this.impactFlashUntil-110&&this.nowMs<this.impactFlashUntil,predictionMode:this.predictionMode};}
}
