import { APP_DEFS } from '../core/reference-catalog.js';
import { currentApp, clamp } from '../core/state.js';
import { plotRange, TRACE_VIEWS, visibleSamples } from '../apps/udaq/model.js';
import { hsvAtPlane } from '../apps/hsv/model.js';
import { resolveSynthParams, midiToFrequency } from '../apps/synth/model.js';
import { MOD_TARGETS, MOD_CURVES } from '../apps/synth/model.js';
import { PALETTE as P, Surface } from '../gfx/surface.js';

const TITLE = { rain:'RAIN PROBLEM', hsv:'HSV CONE SLICER', aem:'AEM ELECTROLYZER', synth:'SYNTH PAD', percussion:'DRUM XY', recorder:'RECORDER', udaq:'uDAQ MOTION' };
const TRACE_COLOR = { x:P.cyan, y:P.violet, z:P.gold, m:P.green };

export class NativeShell {
  constructor(canvas, app) {
    this.canvas=canvas; this.app=app; this.surface=new Surface(canvas);
    this.sheet=''; this.sheetPage=0;this.sheetSelection=0;this.touch=null;this.hsvRaster=null;this.hsvRasterFit=null;
    canvas.addEventListener('pointerdown', event=>this.pointerDown(event));
    canvas.addEventListener('pointermove', event=>this.pointerMove(event));
    canvas.addEventListener('pointerup', event=>this.pointerUp(event));
    canvas.addEventListener('pointercancel', ()=>{const kind=this.touch?.kind;this.touch=null;if(kind==='synth')this.app.stopSynth();if(kind==='percussion')this.app.finishPercussionContact();});
  }
  get active() {
    if(!this.app.state.settings.firstRunComplete||this.app.state.settings.patternMode)return false;
    return this.app.state.drawerOpen || ['rain','hsv','aem','synth','percussion','recorder','udaq'].includes(currentApp(this.app.state).id);
  }
  sync() {
    const active=this.active;
    this.canvas.hidden=!active;
    this.app.root.hidden=active;
    if(active)this.draw(); else this.sheet='';
  }
  point(event) {
    const r=this.canvas.getBoundingClientRect();
    return {x:(event.clientX-r.left)*240/r.width,y:(event.clientY-r.top)*this.surface.height/r.height};
  }
  pointerDown(event) {
    this.touch={...this.point(event),time:performance.now()};
    this.canvas.setPointerCapture?.(event.pointerId);
    if(this.sheet||this.app.state.drawerOpen)return;
    const id=currentApp(this.app.state).id,{x,y}=this.touch;
    if(id==='synth'&&x>12&&x<228&&y>36&&y<213){this.touch.kind='synth';this.setSynthPoint(x,y,true);}
    if(id==='percussion'&&this.app.state.percussion.page!=='pattern'&&x>12&&x<228&&y>63&&y<209){this.touch.kind='percussion';this.app.beginPercussionPad(clamp((x-12)/216,0,1),clamp((y-63)/146,0,1));}
  }
  pointerMove(event){
    if(!this.touch?.kind)return;
    const {x,y}=this.point(event);
    if(this.touch.kind==='synth')this.setSynthPoint(x,y,false);
    else this.app.movePercussionPad(clamp((x-12)/216,0,1),clamp((y-63)/146,0,1));
  }
  setSynthPoint(x,y,start){
    const synth=this.app.state.synth;
    synth.padX=clamp((x-12)/216,0,1);synth.padY=1-clamp((y-36)/177,0,1);
    if(!this.app.state.settings.reducedMotion){
      const now=performance.now();
      this.app.synthTrail.push({x:synth.padX,y:synth.padY,at:now});this.app.synthTrail=this.app.synthTrail.slice(-14);
      if(start){this.app.synthRings.push({x:synth.padX,y:synth.padY,at:now});this.app.synthRings=this.app.synthRings.slice(-8);}
    }
    if(start)this.app.startSynthAtCurrent();
    else this.app.audio.updatePadVoice(synth.padX,synth.padY,this.app.synthOptions());
    this.app.drawCurrent();
  }
  pointerUp(event) {
    if(!this.touch)return;
    const from=this.touch,to=this.point(event),dx=to.x-from.x,dy=to.y-from.y;
    this.touch=null;
    if(from.kind==='synth'){if(!this.app.state.synth.latch)this.app.stopSynth();return;}
    if(from.kind==='percussion'){this.app.finishPercussionContact();return;}
    const id=currentApp(this.app.state).id;
    if(!this.sheet&&!this.app.state.drawerOpen&&id==='hsv'&&from.x>24&&from.y>29&&from.y<130&&to.y<137){
      const h=this.app.state.hsv;
      h.cameraYaw=((h.cameraYaw+dx*.45)%360+360)%360;
      h.cameraPitch=clamp(h.cameraPitch+dy*.35,-60,60);
      this.app.renderAndSave();return;
    }
    if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.3){this.sheet='';this.app.goNext(dx<0?1:-1);return;}
    if(this.app.state.drawerOpen){
      if(to.y<37){this.app.setDrawerScope(to.x>126?'labs':'core');return;}
      const row=Math.floor((to.y-49)/51),col=to.x>=120?1:0;
      if(row<0||row>3)return;
      const indices=this.app.drawerIndices(),index=indices[(this.drawerStartRow||0)*2+row*2+col];
      if(index!==undefined)this.app.openApp(index);
      return;
    }
    if(dy>45&&from.y<36){this.sheet='actions';this.sheetPage=0;this.sheetSelection=0;this.draw();return;}
    if(dy<-45&&from.y>this.surface.height-37){this.sheet='controls';this.sheetPage=0;this.sheetSelection=0;this.draw();return;}
    if(this.sheet){this.sheetTap(to);return;}
    if(to.y<24){if(to.x<24)this.app.openDrawer();else{this.sheet='actions';this.sheetPage=0;this.sheetSelection=0;this.draw();}return;}
    if(to.y>this.surface.height-25){this.sheet='controls';this.sheetPage=0;this.sheetSelection=0;this.draw();return;}
    if(id==='udaq'&&to.y>212+this.surface.height-282){this.app.dispatchAction('udaq-run');return;}
    if(id==='rain'&&to.y>207+this.surface.height-282){this.app.primaryAction(false);return;}
    if(id==='hsv'&&to.y>=137&&to.y<=254+(this.surface.height-292)){
      const x=clamp((to.x-8)/224,0,1),y=clamp((to.y-137)/(117+this.surface.height-292),0,1);
      this.app.hsvSamplePoint={x,y};
      const sample=this.app.hsvModel.sample(x,y,224,117+this.surface.height-292);
      if(sample){this.app.syncHsvState();this.app.renderAndSave();}else this.app.flashStatus('OUTSIDE CONE');
      return;
    }
    if(id==='aem'&&to.y>this.surface.height-80&&to.y<this.surface.height-24){
      this.app.state.aem.focus='DRIVER';
      if(to.x<78)this.app.adjustAemFocus(-1);
      else if(to.x>162)this.app.adjustAemFocus(1);
      else this.app.dispatchAction('aem-driver');
      this.app.renderAndSave();return;
    }
    if(id==='recorder'&&to.y>53&&to.y<206){
      const r=this.app.state.recorder;
      if(['review','saved'].includes(r.state)&&to.y>=135&&to.y<=177){
        r.position=clamp((to.x-17)/206,0,1)*r.duration;
        if(this.app.recordingAudio)this.app.recordingAudio.currentTime=r.position;
        this.draw();return;
      }
      this.app.recordPrimary();return;
    }
    if(id==='percussion'&&this.app.state.percussion.page==='pattern'&&to.y>=78&&to.y<190){
      const voice=['kick','snare','tom','hat'][clamp(Math.floor((to.y-78)/27),0,3)];
      this.app.togglePercStep(voice,clamp(Math.floor((to.x-12)/13.5),0,15));return;
    }
  }
  sheetTap(point) {
    const id=currentApp(this.app.state).id;
    if(['rain','hsv','aem','synth','percussion','recorder'].includes(id)&&this.sheet==='controls'){
      if(point.y>this.surface.height-59&&point.y<this.surface.height-23){const pages=id==='synth'?7:['rain','hsv','aem','percussion'].includes(id)?2:1;this.sheetPage=(this.sheetPage+1)%pages;this.sheetSelection=0;this.draw();return;}
      if(point.y<47||point.y>this.surface.height-23){this.sheet='';this.draw();return;}
      const row=Math.floor((point.y-55)/38);if(row<0||row>3)return;
      this.sheetSelection=row;
      if(id==='rain')this.activateRainControl(row,point.x<80?-1:1);
      else if(id==='hsv')this.activateHsvControl(row,point.x<80?-1:1);
      else if(id==='aem')this.activateAemControl(row,point.x<80?-1:1);
      else if(id==='synth')this.activateSynthControl(row,point.x<80?-1:1);
      else if(id==='percussion')this.activatePercussionControl(row,point.x<80?-1:1);
      else this.activateRecorderControl(row);
      return;
    }
    if(point.y<47||point.y>this.surface.height-29){this.sheet='';this.draw();return;}
    const row=Math.floor((point.y-55)/38);
    const actions=id==='rain'
      ? this.sheet==='actions'?['primary','rain-reset','udaq-zero']:['rain-mode','rain-predictor','rain-reset']
      : id==='hsv'?['primary','hsv-preset','hsv-undo','hsv-clear']
      : id==='aem'?['aem-degas','udaq-zero','aem-driver']
      : id==='synth'?['synth-latch','synth-wave','synth-preset','synth-mute']
      : id==='percussion'?['perc-toggle','perc-kit','perc-view','perc-motion']
      : id==='recorder'?['record','record-save','record-discard','record-share']
      : this.sheet==='actions'?['udaq-run','udaq-clear','udaq-zero','udaq-export']:['udaq-source','udaq-rate','udaq-run','udaq-clear'];
    const action=actions[row];
    this.sheet='';
    if(action)this.app.dispatchAction(action);else this.draw();
  }
  onWheel(direction) {
    if(this.sheet){const id=currentApp(this.app.state).id,max=this.sheet==='controls'?3:['rain','aem'].includes(id)?2:3;this.sheetSelection=clamp(this.sheetSelection+direction,0,max);this.draw();return true;}
    if(this.app.state.drawerOpen)return false;
    const id=currentApp(this.app.state).id;
    if(id==='rain'){
      const r=this.app.state.rain;
      if(r.windMode==='MANUAL')r.manualWind=clamp(r.manualWind+direction*8,-140,140);
      else r.spawnRate=clamp(r.spawnRate+direction,0,90);
      this.app.renderAndSave();return true;
    }
    if(id==='synth'){const p=this.app.state.synth;p.tempo=clamp(p.tempo+direction*2,40,240);this.app.renderAndSave();return true;}
    if(id==='percussion'){const p=this.app.state.percussion;p.bpm=clamp(p.bpm+direction*2,40,240);this.app.audio.updateSequencer(p.pattern,p.bpm,p.volume/100);this.app.renderAndSave();return true;}
    if(id==='recorder'){if(this.app.state.recorder.state==='review'||this.app.state.recorder.state==='saved')this.app.seekRecording(direction);return true;}
    return false;
  }
  onPrimaryAction(){
    if(!this.sheet)return false;
    if(currentApp(this.app.state).id==='rain'&&this.sheet==='controls')this.activateRainControl(this.sheetSelection,1);
    else if(currentApp(this.app.state).id==='hsv'&&this.sheet==='controls')this.activateHsvControl(this.sheetSelection,1);
    else if(currentApp(this.app.state).id==='aem'&&this.sheet==='controls')this.activateAemControl(this.sheetSelection,1);
    else if(currentApp(this.app.state).id==='synth'&&this.sheet==='controls')this.activateSynthControl(this.sheetSelection,1);
    else if(currentApp(this.app.state).id==='percussion'&&this.sheet==='controls')this.activatePercussionControl(this.sheetSelection,1);
    else if(currentApp(this.app.state).id==='recorder'&&this.sheet==='controls')this.activateRecorderControl(this.sheetSelection);
    else this.sheetTap({x:160,y:55+this.sheetSelection*38});
    return true;
  }
  rainControlRows(){
    const r=this.app.state.rain;
    return this.sheetPage===0?
      [`PREDICTOR  ${r.predictor}`,`RAIN RATE  ${r.spawnRate}/S`,`FALL SPEED  ${r.fallSpeed}`,`TARGET SPEED  ${r.targetSpeed}`]:
      [`TARGET WIDTH  ${r.targetWidth}`,`MANUAL WIND  ${r.manualWind}`,`WIND MODE  ${r.windMode}`,`ZERO IMU`];
  }
  activateRainControl(row,direction){
    const fields=this.sheetPage===0?['rain-predictor','spawnRate','fallSpeed','targetSpeed']:['targetWidth','manualWind','rain-mode','udaq-zero'];
    const field=fields[row];if(!field)return;
    if(field.startsWith('rain-')||field==='udaq-zero')this.app.dispatchAction(field);
    else this.app.adjustRainControl(field,direction);
    this.draw();
  }
  hsvControlRows(){
    const h=this.app.state.hsv;
    return this.sheetPage===0?[`PLANE TILT  ${h.tilt.toFixed(0)}`,`PLANE SPIN  ${h.spin.toFixed(0)}`,
      `PLANE OFFSET  ${h.offset.toFixed(2)}`,`SECTION PRESET  ${h.preset}`]:
      [`IMU PLANE  ${h.imuPlane?'ON':'OFF'}`,`ZERO IMU`,`UNDO SWATCH`,`CLEAR SWATCHES`];
  }
  activateHsvControl(row,direction){
    const fields=this.sheetPage===0?['TILT','SPIN','OFFSET','hsv-preset']:['hsv-imu','udaq-zero','hsv-undo','hsv-clear'];
    const field=fields[row];if(!field)return;
    if(field.includes('-'))this.app.dispatchAction(field);else this.app.adjustHsvControl(field,direction);
    this.draw();
  }
  aemControlRows(){
    const a=this.app.state.aem;
    return this.sheetPage===0?
      [`DRIVER MODE  ${a.driver}`,`DRIVER  ${a.driver==='CURRENT'?a.currentSetpoint.toFixed(2):a.voltageSetpoint.toFixed(2)}`,
        `EFFICIENCY  ${Math.round(a.faradaicEfficiency*100)}%`,`WATER FEED  ${a.waterPacketsPerSecond.toFixed(0)}/S`]:
      [`MEMBRANE  ${a.membraneCapacityPackets} PKT`,`IMU VISUAL  ${a.imuControl?'ON':'OFF'}`,`ZERO IMU`,`PRESET  ${a.modelPreset||'BENCH'}`];
  }
  activateAemControl(row,direction){
    const actions=this.sheetPage===0?['aem-driver','DRIVER','EFF','WATER']:['MEM','aem-imu','udaq-zero','aem-preset'];
    const action=actions[row];if(!action)return;
    if(action.startsWith('aem-')||action==='udaq-zero')this.app.dispatchAction(action);
    else{this.app.state.aem.focus=action;this.app.adjustAemFocus(direction);this.app.renderAndSave();}
    this.draw();
  }
  synthControlRows(){
    const p=this.app.state.synth;
    if(this.sheetPage===0)return [`TEMPO  ${p.tempo} BPM`,`WAVEFORM  ${p.waveform}`,`PRESET  ${p.preset}`,`MUTE  ${p.muted?'ON':'OFF'}`];
    if(this.sheetPage===1)return [`TRANSPOSE  ${p.transpose}`,`ARP DIR  ${p.arpDirection}`,`ARP SPAN  ${p.arpSpan}`,`ARP RATE  ${p.arpRate}`];
    if(this.sheetPage===6)return [`SAVE USER PATCH`,`LOAD USER PATCH`,`GRID  ${p.grid}`,`IMU FX  ${p.imuMotion?'ON':'OFF'}`];
    const name=['X1','X2','Y1','Y2'][this.sheetPage-2],mod=p.mods[this.sheetPage-2];
    return [`${name} TARGET  ${mod.target}`,`MINIMUM  ${mod.minimum.toFixed(2)}`,`MAXIMUM  ${mod.maximum.toFixed(2)}`,`CURVE  ${mod.curve}`];
  }
  activateSynthControl(row,direction){
    const p=this.app.state.synth;
    if(this.sheetPage===0){
      if(row===0)p.tempo=clamp(p.tempo+direction*2,40,240);
      else if(row===1)this.app.cycleSynthWaveform();
      else if(row===2)this.app.cycleSynthPreset();
      else p.muted=!p.muted;
    }else if(this.sheetPage===1){
      if(row===0)p.transpose=clamp(p.transpose+direction,-24,24);
      else if(row===1){const directions=['UP','DOWN','UPDOWN','CONVERGE'];p.arpDirection=directions[((directions.indexOf(p.arpDirection)+direction)%4+4)%4];}
      else if(row===2)p.arpSpan=clamp(p.arpSpan+direction,1,4);
      else p.arpRate=clamp(p.arpRate+direction,1,4);
    }else if(this.sheetPage===6){
      if(row===0)this.app.saveSynthUserPatch();
      else if(row===1)this.app.loadSynthUserPatch();
      else if(row===2){const modes=['OFF','SCALE','FULL'];p.grid=modes[(modes.indexOf(p.grid)+1)%modes.length];}
      else p.imuMotion=!p.imuMotion;
    }else{
      const mod=p.mods[this.sheetPage-2];
      if(row===0)mod.target=MOD_TARGETS[((MOD_TARGETS.indexOf(mod.target)+direction)%MOD_TARGETS.length+MOD_TARGETS.length)%MOD_TARGETS.length];
      else if(row===3)mod.curve=MOD_CURVES[((MOD_CURVES.indexOf(mod.curve)+direction)%MOD_CURVES.length+MOD_CURVES.length)%MOD_CURVES.length];
      else{const step=mod.target==='PITCH'||mod.target==='FILTER'?mod.target==='PITCH'?1:100:.02;const key=row===1?'minimum':'maximum';mod[key]=clamp(mod[key]+direction*step,mod.target==='PITCH'?24:mod.target==='FILTER'?250:0,mod.target==='PITCH'?84:mod.target==='FILTER'?7000:1);}
    }
    this.app.audio.updatePadVoice(p.padX,p.padY,this.app.synthOptions());this.app.renderAndSave();this.draw();
  }
  percussionControlRows(){
    const p=this.app.state.percussion;
    return this.sheetPage===0?[`KIT  ${p.kit}`,`VOLUME  ${p.volume}%`,`MUTE  ${p.muted?'ON':'OFF'}`,`TEMPO  ${p.bpm} BPM`]:
      [`ENERGY  ${p.energy}/4`,`GROOVE  ${p.groove}/4`,`PATTERN VIEW  ${p.page==='pattern'?'ON':'OFF'}`,`CLEAR PULSE`];
  }
  activatePercussionControl(row,direction){
    const p=this.app.state.percussion;
    if(this.sheetPage===0){if(row===0)this.app.cyclePercKit();else if(row===1)p.volume=clamp(p.volume+direction*2,0,100);
      else if(row===2)p.muted=!p.muted;else p.bpm=clamp(p.bpm+direction*2,40,240);}
    else{if(row===0)p.energy=clamp(p.energy+direction,1,4);else if(row===1)p.groove=clamp(p.groove+direction,1,4);
      else if(row===2)p.page=p.page==='pattern'?'xy':'pattern';else{this.app.audio.stopSequencer();p.playing=false;p.currentStep=-1;p.variation='WHOLE KIT';}}
    this.app.refreshPercussionPattern();this.app.renderAndSave();this.draw();
  }
  recorderControlRows(){const r=this.app.state.recorder;return [`${r.saved?'DONE / NEW':'SAVE CLIP'}`,`DISCARD TAKE`,`PLAY / PAUSE`,`SHARE <=15 S`];}
  activateRecorderControl(row){
    if(row===0)this.app.dispatchAction(this.app.state.recorder.saved?'record-done':'record-save');
    else if(row===1)this.app.dispatchAction('record-discard');
    else if(row===2)this.app.dispatchAction('record-replay');
    else this.app.dispatchAction('record-share');
    this.draw();
  }
  draw() {
    if(!this.active)return;
    const s=this.surface;s.clear();
    if(this.app.state.drawerOpen){this.drawDrawer();return;}
    const id=currentApp(this.app.state).id;
    s.rect(0,0,240,23,P.panel);s.line(0,23,240,23,P.line);
    s.text('<',6,7,1.5,P.muted);s.text(TITLE[id],24,7,1.5,id==='rain'?P.water:P.cyan,190);
    if(id==='rain')this.drawRain();else if(id==='hsv')this.drawHsv();else if(id==='aem')this.drawAem();
    else if(id==='synth')this.drawSynth();else if(id==='percussion')this.drawPercussion();else if(id==='recorder')this.drawRecorder();
    else this.drawUdaq();
    const footerY=s.height-23;
    s.rect(0,footerY,240,23,P.panel);s.line(0,footerY,240,footerY,P.line);
    s.text('^ CONTROLS',67,footerY+7,1.5,P.muted);
    if(this.sheet)this.drawSheet();
  }
  drawDrawer() {
    const s=this.surface,indices=this.app.drawerIndices(),scope=this.app.state.drawerScope;
    const selected=Math.max(0,indices.indexOf(this.app.state.drawerIndex));
    this.drawerStartRow=clamp(Math.floor(selected/2)-1,0,Math.max(0,Math.ceil(indices.length/2)-4));
    s.rect(0,0,240,40,P.panel);s.text('lilLED',10,9,2,P.cyan);
    s.text(scope==='core'?'CORE  > LABS':'< CORE  LABS',95,14,1,P.muted);
    indices.slice(this.drawerStartRow*2,this.drawerStartRow*2+8).forEach((index,i)=>{
      const x=(i%2)*120+5,y=48+Math.floor(i/2)*51;
      s.rect(x,y,111,45,index===this.app.state.drawerIndex?P.raised:P.panel);
      s.frame(x,y,111,45,index===this.app.state.drawerIndex?P.cyan:P.line);
      s.text(String(this.drawerStartRow*2+i+1).padStart(2,'0'),x+7,y+8,1,P.muted);
      s.text(APP_DEFS[index].title.toUpperCase(),x+7,y+25,1,P.text,99);
    });
    s.text('WHEEL TO SCROLL / TAP TO OPEN',24,s.height-19,1,P.muted);
  }
  drawRain() {
    const s=this.surface,r=this.app.state.rain,m=this.app.rainModel,extra=s.height-282;
    s.rect(5,29,230,66,P.panel);s.frame(5,29,230,66);
    s.text(`H ${r.hits}  M ${r.misses}  P ${r.predicted}`,13,36,1.5,P.green,216);
    s.text(`WIND ${Math.round(r.effectiveWind)}`,13,54,2,P.cyan,150);
    s.text(r.imuStatus,165,59,1,r.windMode==='IMU'&&r.imuStatus!=='IMU WIND'?P.amber:P.green,67);
    s.text(`FP ${r.falsePositives||0}  FN ${r.falseNegatives||0}  SPAWN ${Math.round(r.effectiveFallSpeed)}`,13,82,1,P.muted,216);
    const top=100,height=106+extra,sx=230/368,sy=height/400;
    s.rect(5,top,230,height,'#041019');s.frame(5,top,230,height);
    const targetY=top+(400-m.targetHeight)*sy,targetH=m.targetHeight*sy;
    for(const offset of [0,-368]){
      const x=5+(m.targetX+offset)*sx,w=m.targetWidth*sx;
      if(x+w<5||x>235)continue;
      s.rect(x,targetY,w,targetH,r.impactFlash?P.gold:P.text);
      s.rect(x+3,targetY+3,Math.max(0,w-6),3,P.bg);
    }
    for(const d of m.drops){
      if(!d.active)continue;
      const x=5+d.x*sx,y=top+d.y*sy,color=d.falseNegativeCollision?P.amber:d.predictedCollision?P.red:P.green;
      s.circle(x,y,Math.max(2,4*sx),color);
      if(d.actualCollision)s.circle(x,y,Math.max(3,4*sx+1),P.text,true);
    }
    s.rect(5,211+extra,230,42,P.panel);s.frame(5,211+extra,230,42);
    s.text(r.running?'RUN / SIDE PAUSE':'PAUSE / SIDE RUN',13,222+extra,1.5,r.running?P.green:P.amber,214);
    s.text(`${r.predictor}  ${r.windMode}  ${r.spawnRate}/S`,13,242+extra,1,r.windMode==='IMU'&&r.imuStatus!=='IMU WIND'?P.amber:P.violet,216);
  }
  drawAem(){
    const s=this.surface,a=this.app.state.aem,extra=s.height-282;
    s.rect(5,29,230,45,P.panel);s.frame(5,29,230,45);
    s.text(`V ${a.voltage.toFixed(2)}   J ${a.currentDensity.toFixed(2)}   H2 ${a.supportedH2Rate.toFixed(2)} G/H`,11,35,1.5,P.hydrogen,219);
    s.text(`HHV ${Math.round(a.realizedEfficiency*100)}%  ${a.regime.toUpperCase()}  ${a.bottleneck}${a.transportLimited?' LIMIT':''}`,11,58,1,P.gold,219);
    const top=79,bottom=205+extra,height=bottom-top,phase=performance.now()/1000;
    s.rect(5,top,230,height,'#07121a');s.frame(5,top,230,height);
    s.rect(83,top,74,height,'#382d10');s.line(83,top,83,bottom,P.gold);s.line(157,top,157,bottom,P.gold);
    s.text('CATHODE',13,top+8,1,P.water);s.text('AEM',105,top+8,1.5,P.gold);s.text('ANODE',176,top+8,1,P.oxygen);
    const waterCount=Math.round(clamp(a.effectiveWaterPacketsPerSecond/80*12,0,12));
    for(let i=0;i<waterCount;i++){
      const x=13+((i*19+phase*92)%68),y=top+29+((i*31)%75);
      s.circle(x,y,2,P.water);
    }
    const membraneSpeed=a.hydroxideVisualVelocityPxS||125;
    for(let i=0;i<8;i++){
      const x=87+((i*17+phase*membraneSpeed)%65),y=top+30+(i%4)*17;
      s.circle(x,y,2,P.gold);
    }
    const gasCount=clamp(Math.round(a.supportedH2Rate/3.7*9),0,18),rise=a.degas?52*2.2:52;
    for(let i=0;i<gasCount;i++){
      const y=bottom-8-((i*23+phase*rise)%(height-35)),x=169+(i*11)%59;
      s.circle(x,y,Math.max(2,i%3+2),i%3?P.hydrogen:P.oxygen);
    }
    s.text(`FEED ${a.effectiveWaterPacketsPerSecond.toFixed(0)}/S`,12,bottom-15,1,P.water,72);
    s.text(`${a.membraneCapacityPackets} PKT`,99,bottom-15,1,P.gold,53);
    s.text(a.degas?'DEGAS X2.2':'GAS RISE',170,bottom-15,1,a.degas?P.amber:P.hydrogen,65);
    s.rect(5,211+extra,230,42,P.panel);s.frame(5,211+extra,230,42);
    const driver=a.driver==='CURRENT'?`${a.currentSetpoint.toFixed(2)} A/CM2`:`${a.voltageSetpoint.toFixed(2)} V`;
    s.text('-',17,220+extra,2,P.cyan);s.text(driver,57,220+extra,1.5,P.text,142);s.text('+',211,220+extra,2,P.cyan);
    s.text(`${a.driver}  ${a.imuStatus}  SIDE DEGAS`,14,241+extra,1,a.imuControl&&a.imuStatus!=='IMU MODEL'?P.amber:P.muted,213);
  }
  drawHsv(){
    const s=this.surface,h=this.app.state.hsv,m=this.app.hsvModel,extra=s.height-292;
    s.rect(5,29,230,103,P.panel);s.frame(5,29,230,103);
    const centerX=70,topY=45,apexY=121,radiusX=51,radiusY=8+Math.abs(Math.sin(h.cameraPitch*Math.PI/180))*8;
    s.line(centerX-radiusX,topY,centerX,apexY,P.muted);s.line(centerX+radiusX,topY,centerX,apexY,P.muted);
    s.ctx.strokeStyle=P.violet;s.ctx.beginPath();s.ctx.ellipse(centerX,topY,radiusX,radiusY,0,0,Math.PI*2);s.ctx.stroke();
    const bandY=topY+clamp(.5-h.offset,0,1)*(apexY-topY),bandHalf=radiusX*(1-(bandY-topY)/(apexY-topY));
    s.line(centerX-bandHalf,bandY-3,centerX+bandHalf,bandY+3,P.cyan,2);
    s.text(h.sectionLabel,131,39,1,P.violet,100);
    s.text(`T ${h.tilt.toFixed(1)} S ${Math.round(h.spin)}`,131,60,1,P.text,100);
    s.text(`O ${h.offset.toFixed(2)}`,131,77,1,P.text,100);
    s.text(h.imuPlane?h.imuStatus:'TOUCH PLANE',131,103,1,h.imuPlane&&h.imuStatus!=='IMU PLANE'?P.amber:P.green,100);
    const sectionY=137,sectionH=117+extra;
    s.rect(5,sectionY,230,sectionH,P.panel);s.frame(5,sectionY,230,sectionH);
    if(this.hsvRasterFit!==m.fit){
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
      const ctx=canvas.getContext('2d'),image=ctx.createImageData(64,36);
      for(let y=0;y<36;y++)for(let x=0;x<64;x++){
        const sample=m.fit.empty?null:this.sampleHsvRasterPoint((x+.5)/64,(y+.5)/36,224,sectionH);
        const i=(y*64+x)*4,c=sample?.color;
        image.data[i]=c?.r??5;image.data[i+1]=c?.g??12;image.data[i+2]=c?.b??19;image.data[i+3]=255;
      }
      ctx.putImageData(image,0,0);this.hsvRaster=canvas;this.hsvRasterFit=m.fit;
    }
    if(this.hsvRaster){const c=s.ctx;c.save();c.imageSmoothingEnabled=false;c.drawImage(this.hsvRaster,8,sectionY+2,224,sectionH-4);c.restore();}
    const x=8+this.app.hsvSamplePoint.x*224,y=sectionY+this.app.hsvSamplePoint.y*sectionH;
    s.line(x-4,y,x+4,y,P.text);s.line(x,y-4,x,y+4,P.text);
    if(m.selected){s.rect(10,sectionY+sectionH-20,78,16,P.panel);s.text(m.selected.color.hex,15,sectionY+sectionH-16,1,P.text);}
    m.swatches.forEach((swatch,i)=>{s.rect(113+i*23,sectionY+sectionH-18,19,14,swatch.color.hex);});
  }
  drawSynth(){
    const s=this.surface,p=this.app.state.synth,extra=s.height-292;
    const x=12,y=36,w=216,h=177+extra;
    s.rect(x,y,w,h,'#06121b');s.frame(x,y,w,h,P.violet);
    if(p.grid!=='OFF'){
      for(let col=1;col<5;col++)s.line(x+col*w/5,y,x+col*w/5,y+h,P.line);
      for(let row=1;row<5;row++)s.line(x,y+row*h/5,x+w,y+row*h/5,P.line);
    }
    const now=performance.now();
    this.app.synthTrail=this.app.synthTrail.filter(item=>now-item.at<550);
    this.app.synthRings=this.app.synthRings.filter(item=>now-item.at<700);
    if(!this.app.state.settings.reducedMotion){
      for(const item of this.app.synthTrail)s.circle(x+item.x*w,y+(1-item.y)*h,2,P.cyan);
      for(const item of this.app.synthRings)s.circle(x+item.x*w,y+(1-item.y)*h,3+(now-item.at)/700*18,P.violet,true);
    }
    const cx=x+p.padX*w,cy=y+(1-p.padY)*h;
    s.circle(cx,cy,12,P.violet,true);s.line(cx-17,cy,cx+17,cy,P.cyan);s.line(cx,cy-17,cx,cy+17,P.cyan);
    s.text('X: DELAY / FEEDBACK',20,y+8,1,P.muted,197);
    s.text('Y: PITCH / REVERB',20,y+h-15,1,P.muted,197);
    const resolved=resolveSynthParams(p,p.padX,1-p.padY,{ready:p.imuStatus==='MOTION MAP',delay:p.imuDelayMod||0,reverb:p.imuReverbMod||0});
    s.rect(5,218+extra,230,44,P.panel);s.frame(5,218+extra,230,44);
    s.text(`${p.preset} ${p.waveform} ${p.tempo} BPM ${p.latch?'LATCH':'GATE'}`,11,224+extra,1,P.gold,218);
    s.text(`${Math.round(midiToFrequency(resolved.rootMidi))}HZ DLY ${Math.round(resolved.delay*1000)} FB ${Math.round(resolved.feedback*100)} RV ${Math.round(resolved.reverb*100)}`,11,240+extra,1,P.text,218);
    s.text(`${p.audioStatus}  ${p.imuStatus}`,11,251+extra,1,p.audioStatus==='AUDIO READY'?P.green:P.amber,218);
  }
  drawPercussion(){
    const s=this.surface,p=this.app.state.percussion,extra=s.height-292;
    s.rect(5,30,230,29,P.panel);s.frame(5,30,230,29);
    s.text(`${p.kit} / ${p.variation}`,11,37,1.5,P.gold,218);
    const x=12,y=63,w=216,h=146+extra;
    s.rect(x,y,w,h,'#07121a');s.frame(x,y,w,h,P.gold);
    if(p.page==='pattern'){
      ['kick','snare','tom','hat'].forEach((voice,row)=>{
        s.text(voice.toUpperCase(),13,y+8+row*27,1,P.text,44);
        for(let step=0;step<16;step++)s.rect(12+step*13.5,y+23+row*27,11,8,p.pattern[voice]?.[step]?P.gold:P.line);
      });
    }else{
      for(let i=1;i<4;i++){s.line(x+i*w/4,y,x+i*w/4,y+h,P.line);s.line(x,y+i*h/4,x+w,y+i*h/4,P.line);}
      const cx=x+p.padX*w,cy=y+p.padY*h;
      s.circle(cx,cy,10,P.gold,true);s.line(cx-10,cy,cx+10,cy,P.text);s.line(cx,cy-10,cx,cy+10,P.text);
    }
    for(let step=0;step<16;step++){
      const any=['kick','snare','tom','hat'].some(voice=>p.pattern[voice]?.[step]);
      s.rect(7+step*14,218+extra,12,13,step===p.currentStep?P.cyan:any?P.gold:P.line);
    }
    s.text(`ENERGY ${p.energy}/4  GROOVE ${p.groove}/4  ${p.bpm} BPM`,12,238+extra,1,P.text,215);
    s.text(p.playing?p.stopAtBoundary?'STOP AT LOOP':'PLAY / RETOUCH <=650MS':'TOUCH PAD OR SIDE TO PLAY',12,251+extra,1,p.playing?P.green:P.muted,215);
  }
  drawRecorder(){
    const s=this.surface,r=this.app.state.recorder,extra=s.height-292;
    s.rect(5,30,230,229+extra,P.panel);s.frame(5,30,230,229+extra);
    const state=r.state.toUpperCase();
    s.text(state==='IDLE'?'READY':state,13,43,2,state==='RECORDING'?P.red:state==='REVIEW'?P.gold:P.green,215);
    s.text(`${Math.floor(r.seconds/60)}:${String(Math.floor(r.seconds%60)).padStart(2,'0')}`,54,78,3,P.text,175);
    if(r.state==='recording'||r.state==='idle'){
      s.circle(120,168+extra/2,42,r.state==='recording'?P.red:P.line);
      if(r.state==='recording')s.rect(106,154+extra/2,28,28,P.text);
      else s.circle(120,168+extra/2,29,P.red);
      s.text(r.state==='recording'?'TAP OR SIDE TO STOP':'TAP OR SIDE TO RECORD',25,224+extra,1.5,P.muted,201);
    }else{
      s.rect(13,135+extra/2,214,41,'#07121a');s.frame(13,135+extra/2,214,41);
      if(r.waveform?.length)r.waveform.forEach((peak,index)=>{
        const x=17+index*206/r.waveform.length,amplitude=clamp(peak,0,1)*15;
        s.line(x,155+extra/2-amplitude,x,155+extra/2+amplitude,P.water);
      });
      const fraction=r.duration?clamp(r.position/r.duration,0,1):0;
      s.rect(17,155+extra/2,206*fraction,3,P.cyan);
      s.text(`${r.position.toFixed(1)} / ${r.duration.toFixed(1)} S`,25,187+extra,1.5,P.text,190);
      s.text(r.saved?'SAVED / DONE IN CONTROLS':'SAVE OR DISCARD IN CONTROLS',21,226+extra,1,P.muted,205);
    }
    s.text(r.error||`${r.format}  ${r.saved?'SAVED':'LOCAL'}`,12,246+extra,1,r.error?P.red:r.format==='WAV'?P.green:P.amber,215);
  }
  sampleHsvRasterPoint(x,y,width,height){
    const fit=this.app.hsvModel.fit,side=Math.min(width,height);
    const u=fit.centerU+(x*2-1)*fit.halfExtent*width/side;
    const v=fit.centerV+(1-y*2)*fit.halfExtent*height/side;
    return hsvAtPlane(fit.basis,u,v);
  }
  drawUdaq() {
    const s=this.surface,u=this.app.state.udaq;
    const status=u.inputSource==='DEMO'?'DEMO':u.sourceFresh?'LIVE':u.sourceAvailable?'STALE':'WAIT';
    s.rect(5,29,230,48,P.panel);s.frame(5,29,230,48);
    s.text(`${status} ${u.source}`,12,36,1.5,status==='DEMO'?P.amber:status==='LIVE'?P.green:P.muted,210);
    const values=u.sourceAvailable||u.inputSource==='DEMO'
      ? `X${u.x.toFixed(2)} Y${u.y.toFixed(2)} Z${u.z.toFixed(2)}`:'X-- Y-- Z--';
    s.text(values,12,60,1,P.text,215);
    const extra=s.height-282;
    s.rect(5,82,230,125+extra,'#041019');s.frame(5,82,230,125+extra);
    const samples=visibleSamples(u.history),channels=TRACE_VIEWS[u.view]||TRACE_VIEWS.XYZ;
    for(let i=1;i<4;i++){s.line(5+i*57.5,83,5+i*57.5,206+extra,P.line);s.line(6,82+i*(125+extra)/4,234,82+i*(125+extra)/4,P.line);}
    if(samples.length){
      const range=plotRange(samples,channels);
      for(const key of channels){
        let previous=null;
        samples.forEach((sample,i)=>{
          const value=sample[key],x=7+i*226/Math.max(1,samples.length-1);
          if(!Number.isFinite(value)){previous=null;return;}
          const y=202+extra-(value-range.min)/(range.max-range.min)*(116+extra);
          if(previous&&sample.seq-previous.sample.seq<=1&&sample.t-previous.sample.t<=1000)s.line(previous.x,previous.y,x,y,TRACE_COLOR[key],1.5);
          previous={x,y,sample};
        });
      }
      s.text(range.max.toFixed(2),9,87,1,P.text);
      s.text(range.min.toFixed(2),9,195+extra,1,P.text);
    } else s.text(u.running?'WAITING FOR FRESH IMU':'PAUSED / NO SAMPLES',18,143+extra/2,1,P.muted,210);
    s.rect(5,212+extra,230,41,P.panel);s.frame(5,212+extra,230,41);
    s.text(`${u.running?'RUN':'PAUSE'}  ${u.view}  ${u.sampleRate}HZ`,13,222+extra,1.5,P.cyan,216);
    s.text(`${u.history.length}/300   ${u.inputSource==='DEMO'?'EXPLICIT DEMO':'SENSOR ONLY'}`,13,242+extra,1,P.muted,216);
  }
  drawSheet() {
    const s=this.surface,id=currentApp(this.app.state).id;
    const rows=id==='rain'
      ? this.sheet==='actions'?['PAUSE / RESUME','RESET SIM','ZERO IMU']:this.rainControlRows()
      : id==='hsv'?this.sheet==='actions'?['SAMPLE','SECTION PRESET','UNDO SWATCH','CLEAR SWATCHES']:this.hsvControlRows()
      : id==='aem'?this.sheet==='actions'?['DEGAS','ZERO IMU','DRIVER MODE']:this.aemControlRows()
      : id==='synth'?this.sheet==='actions'?['LATCH','WAVEFORM','PRESET','MUTE']:this.synthControlRows()
      : id==='percussion'?this.sheet==='actions'?['PLAY / STOP','KIT','PATTERN VIEW','MOTION FX']:this.percussionControlRows()
      : id==='recorder'?this.sheet==='actions'?['RECORD / PLAY','SAVE','DISCARD','SHARE']:this.recorderControlRows()
      : this.sheet==='actions'?['RUN / PAUSE','CLEAR TRACE','ZERO IMU','EXPORT CSV']:['SOURCE / DEMO','SAMPLE RATE','RUN / PAUSE','CLEAR TRACE'];
    s.rect(0,35,240,s.height-59,P.panel);s.frame(0,35,240,s.height-59,P.cyan);
    s.text(this.sheet.toUpperCase(),12,43,1.5,P.cyan);
    rows.forEach((label,i)=>{const y=55+i*38;s.rect(7,y,226,33,P.raised);s.frame(7,y,226,33,i===this.sheetSelection?P.cyan:P.line);s.text(label,17,y+12,1.5,P.text,205);});
    if(['rain','hsv','aem','synth','percussion'].includes(id)&&this.sheet==='controls')s.text(`PAGE ${this.sheetPage+1}/${id==='synth'?7:2}  TAP HERE TO CHANGE`,25,s.height-43,1,P.cyan);
    else s.text('TAP OUTSIDE TO CLOSE',41,s.height-40,1,P.muted);
  }
}
