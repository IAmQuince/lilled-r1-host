// Port of the cone/plane section math in LED/apps/hsv/presentations/
// touch-portrait-368x448/hsv_simulator.cpp and core/hsv_color.cpp.
const clamp=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
const wrap=n=>((n%360)+360)%360;
const add=(a,b)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const mul=(a,k)=>({x:a.x*k,y:a.y*k,z:a.z*k});
const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const norm=a=>{const n=Math.hypot(a.x,a.y,a.z);return n>1e-7?mul(a,1/n):{x:0,y:0,z:1};};

export function hsvToRgb(hueDegrees,saturation,value){
  const hue=wrap(hueDegrees),s=clamp(saturation,0,1),v=clamp(value,0,1);
  const chroma=v*s,x=chroma*(1-Math.abs((hue/60)%2-1)),m=v-chroma;
  let r=0,g=0,b=0;
  if(hue<60){r=chroma;g=x;}else if(hue<120){r=x;g=chroma;}
  else if(hue<180){g=chroma;b=x;}else if(hue<240){g=x;b=chroma;}
  else if(hue<300){r=x;b=chroma;}else{r=chroma;b=x;}
  r=Math.round((r+m)*255);g=Math.round((g+m)*255);b=Math.round((b+m)*255);
  return {r,g,b,rgb565:((r&0xF8)<<8)|((g&0xFC)<<3)|(b>>3),hex:`#${[r,g,b].map(n=>n.toString(16).padStart(2,'0')).join('').toUpperCase()}`};
}
export function planeBasis(tiltDegrees,spinDegrees,offset){
  const tilt=tiltDegrees*Math.PI/180,spin=spinDegrees*Math.PI/180;
  const normal={x:Math.sin(tilt)*Math.cos(spin),y:Math.sin(tilt)*Math.sin(spin),z:Math.cos(tilt)};
  const reference=Math.abs(normal.z)>.999?{x:0,y:1,z:0}:{x:0,y:0,z:1};
  const u=norm(cross(reference,normal)),v=norm(cross(normal,u));
  return {normal,u,v,point:mul(normal,offset)};
}
const pointOnPlane=(basis,u,v)=>add(basis.point,add(mul(basis.u,u),mul(basis.v,v)));
export function hsvAtPlane(basis,u,v){
  const point=pointOnPlane(basis,u,v),coneZ=point.z+.5,radius=Math.hypot(point.x,point.y);
  if(coneZ<-.0015||coneZ>1.0015||radius>coneZ+.0015)return null;
  const hue=wrap(Math.atan2(point.y,point.x)*180/Math.PI);
  const saturation=coneZ>1e-6?clamp(radius/coneZ,0,1):0,value=clamp(coneZ,0,1);
  return {hue,saturation,value,color:hsvToRgb(hue,saturation,value)};
}
export function computeSectionFit(tiltDegrees=28,spinDegrees=40,offset=0){
  const basis=planeBasis(tiltDegrees,spinDegrees,offset);
  let minU=Infinity,maxU=-Infinity,minV=Infinity,maxV=-Infinity,truncated=false,count=0;
  for(let row=0;row<64;row++)for(let column=0;column<64;column++){
    const u=((column/63)*2-1)*1.45,v=((row/63)*2-1)*1.45;
    const point=pointOnPlane(basis,u,v),coneZ=point.z+.5,radius=Math.hypot(point.x,point.y);
    if(coneZ<0||coneZ>1||radius>coneZ)continue;
    minU=Math.min(minU,u);maxU=Math.max(maxU,u);minV=Math.min(minV,v);maxV=Math.max(maxV,v);
    truncated ||= coneZ>.992;count++;
  }
  const empty=count===0,centerU=empty?0:(minU+maxU)*.5,centerV=empty?0:(minV+maxV)*.5;
  const halfExtent=empty?.6:Math.max(.14,Math.max((maxU-minU)*.5,(maxV-minV)*.5)*1.18+.03);
  let label=empty?'NO SECTION':tiltDegrees<.75?'CIRCLE':Math.abs(tiltDegrees-45)<=.75?'PARABOLA':tiltDegrees<45?'ELLIPSE':'HYPERBOLA';
  const apexDistance=Math.abs(dot(basis.normal,{x:0,y:0,z:-.5})-offset);
  if(!empty&&apexDistance<.012)label=`DEGENERATE ${label}`;
  else if(!empty&&truncated)label=`${label} / TRUNC`;
  return {basis,empty,truncated,centerU,centerV,halfExtent,label,count};
}
export function sampleSection(fit,localX,localY,width=1,height=1){
  if(fit.empty)return null;
  const side=Math.min(width,height),extentX=fit.halfExtent*width/side,extentY=fit.halfExtent*height/side;
  const u=fit.centerU+(localX*2-1)*extentX,v=fit.centerV+(1-localY*2)*extentY;
  return hsvAtPlane(fit.basis,u,v);
}
export function imuPlaneFromGravity(vector,offset=0){
  const mapped=norm({x:-vector.x,y:-vector.y,z:vector.z});
  const flipped=mapped.z<0,normal=flipped?mul(mapped,-1):mapped;
  const tilt=clamp(Math.acos(clamp(normal.z,-1,1))*180/Math.PI,0,72);
  return {tilt,spin:tilt>.75?wrap(Math.atan2(normal.y,normal.x)*180/Math.PI):null,
    offset:flipped?-offset:offset,flipped};
}
export class HsvModel{
  constructor(){this.tilt=28;this.spin=40;this.offset=0;this.fit=computeSectionFit(28,40,0);this.swatches=[];this.selected=null;this.hemisphereFlipped=false;}
  setPlane(tilt,spin,offset){
    const nextTilt=clamp(tilt,0,90),nextSpin=wrap(spin),nextOffset=clamp(offset,-.85,.85);
    if(nextTilt===this.tilt&&nextSpin===this.spin&&nextOffset===this.offset)return false;
    this.tilt=nextTilt;this.spin=nextSpin;this.offset=nextOffset;
    this.fit=computeSectionFit(this.tilt,this.spin,this.offset);return true;
  }
  updateImu(vector){
    const next=imuPlaneFromGravity(vector,this.offset);
    let offset=next.offset;
    if(next.flipped===this.hemisphereFlipped)offset=this.offset;
    this.hemisphereFlipped=next.flipped;
    const tilt=Math.abs(next.tilt-this.tilt)>=.5?next.tilt:this.tilt;
    const distance=Math.abs(((next.spin??this.spin)-this.spin+540)%360-180);
    const spin=next.spin!=null&&distance>=1.25?next.spin:this.spin;
    return this.setPlane(tilt,spin,offset);
  }
  sample(x,y,width=1,height=1){
    const sample=sampleSection(this.fit,x,y,width,height);if(!sample)return null;
    this.swatches.push(sample);if(this.swatches.length>5)this.swatches.shift();this.selected=sample;return sample;
  }
  undo(){this.swatches.pop();this.selected=this.swatches.at(-1)||null;}
  clear(){this.swatches=[];this.selected=null;}
  preset(name){
    const presets={CIRCLE:[0,0,.34],FAN:[90,25,0],PARABOLA:[45,140,.1],OBLIQUE:[28,40,0]};
    const values=presets[name];return values?this.setPlane(...values):false;
  }
}
