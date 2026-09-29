import { APP_DEFS } from '../core/reference-catalog.js';
import { currentApp, clamp } from '../core/state.js';
import { plotRange, TRACE_VIEWS, visibleSamples } from '../apps/udaq/model.js';
import { PALETTE as P, Surface } from '../gfx/surface.js';

const TITLE = { rain:'RAIN PROBLEM', udaq:'uDAQ MOTION' };
const TRACE_COLOR = { x:P.cyan, y:P.violet, z:P.gold, m:P.green };

export class NativeShell {
  constructor(canvas, app) {
    this.canvas=canvas; this.app=app; this.surface=new Surface(canvas);
    this.sheet=''; this.touch=null;
    canvas.addEventListener('pointerdown', event=>this.pointerDown(event));
    canvas.addEventListener('pointerup', event=>this.pointerUp(event));
    canvas.addEventListener('pointercancel', ()=>{this.touch=null;});
  }
  get active() { return this.app.state.drawerOpen || ['rain','udaq'].includes(currentApp(this.app.state).id); }
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
  }
  pointerUp(event) {
    if(!this.touch)return;
    const from=this.touch,to=this.point(event),dx=to.x-from.x,dy=to.y-from.y;
    this.touch=null;
    if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.3){this.sheet='';this.app.goNext(dx<0?1:-1);return;}
    if(this.app.state.drawerOpen){
      if(to.y<37){this.app.setDrawerScope(to.x>126?'labs':'core');return;}
      const row=Math.floor((to.y-49)/51),col=to.x>=120?1:0;
      if(row<0||row>3)return;
      const indices=this.app.drawerIndices(),index=indices[(this.drawerStartRow||0)*2+row*2+col];
      if(index!==undefined)this.app.openApp(index);
      return;
    }
    if(dy>45&&from.y<36){this.sheet='actions';this.draw();return;}
    if(dy<-45&&from.y>this.surface.height-37){this.sheet='controls';this.draw();return;}
    if(this.sheet){this.sheetTap(to);return;}
    if(to.y<24){if(to.x<24)this.app.openDrawer();else{this.sheet='actions';this.draw();}return;}
    if(to.y>this.surface.height-25){this.sheet='controls';this.draw();return;}
    const id=currentApp(this.app.state).id;
    if(id==='udaq'&&to.y>212+this.surface.height-282){this.app.dispatchAction('udaq-run');return;}
    if(id==='rain'&&to.y>207+this.surface.height-282){this.app.primaryAction(false);return;}
  }
  sheetTap(point) {
    if(point.y<47||point.y>this.surface.height-29){this.sheet='';this.draw();return;}
    const id=currentApp(this.app.state).id,row=Math.floor((point.y-55)/38);
    const actions=id==='rain'
      ? this.sheet==='actions'?['rain-reset','rain-mode','rain-predictor']:['rain-mode','rain-predictor','rain-reset']
      : this.sheet==='actions'?['udaq-run','udaq-clear','udaq-zero','udaq-export']:['udaq-source','udaq-rate','udaq-run','udaq-clear'];
    const action=actions[row];
    this.sheet='';
    if(action)this.app.dispatchAction(action);else this.draw();
  }
  onWheel(direction) {
    if(this.sheet){this.sheet='';this.draw();return false;}
    if(this.app.state.drawerOpen)return false;
    const id=currentApp(this.app.state).id;
    if(id==='rain'){
      const r=this.app.state.rain;
      if(r.windMode==='MANUAL')r.manualWind=clamp(r.manualWind+direction*8,-140,140);
      else r.spawnRate=clamp(r.spawnRate+direction,0,90);
      this.app.renderAndSave();return true;
    }
    return false;
  }
  draw() {
    if(!this.active)return;
    const s=this.surface;s.clear();
    if(this.app.state.drawerOpen){this.drawDrawer();return;}
    const id=currentApp(this.app.state).id;
    s.rect(0,0,240,23,P.panel);s.line(0,23,240,23,P.line);
    s.text('<',6,7,1.5,P.muted);s.text(TITLE[id],24,7,1.5,id==='rain'?P.water:P.cyan,190);
    if(id==='rain')this.drawRain();else this.drawUdaq();
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
    const s=this.surface,r=this.app.state.rain;
    s.rect(5,29,230,66,P.panel);s.frame(5,29,230,66);
    s.text(`H ${r.hits}   M ${r.misses}`,13,37,1.5,P.green,220);
    s.text(`WIND ${Math.round(r.windMode==='MANUAL'?r.manualWind:r.effectiveWind)}`,13,58,2,P.cyan,210);
    s.text(`${r.windMode}  RATE ${r.spawnRate}/S  ADAPTED`,13,83,1,P.muted,220);
    const extra=s.height-282;
    s.rect(5,100,230,106+extra,'#041019');s.frame(5,100,230,106+extra);
    const count=Math.min(r.activeDrops,this.app.rainDrops.length);
    for(let i=0;i<count;i++){
      const d=this.app.rainDrops[i];
      s.rect(8+d.x,102+d.y*(.84+extra/119),2,2,i%4===0?P.green:P.water);
    }
    s.rect(99,180+extra,clamp(r.targetWidth,12,100),22,P.text);
    s.rect(104,180+extra,clamp(r.targetWidth-10,4,90),3,P.bg);
    s.rect(5,211+extra,230,42,P.panel);s.frame(5,211+extra,230,42);
    s.text(r.running?'RUN / SIDE PAUSE':'PAUSE / SIDE RUN',13,224+extra,1.5,r.running?P.green:P.amber,214);
    s.text('WHEEL: '+(r.windMode==='MANUAL'?'WIND':'RATE'),13,242+extra,1,P.muted);
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
      ? this.sheet==='actions'?['RESET SIM','WIND MODE','PREDICTOR']:['WIND MODE','PREDICTOR','RESET SIM']
      : this.sheet==='actions'?['RUN / PAUSE','CLEAR TRACE','ZERO IMU','EXPORT CSV']:['SOURCE / DEMO','SAMPLE RATE','RUN / PAUSE','CLEAR TRACE'];
    s.rect(0,35,240,s.height-59,P.panel);s.frame(0,35,240,s.height-59,P.cyan);
    s.text(this.sheet.toUpperCase(),12,43,1.5,P.cyan);
    rows.forEach((label,i)=>{const y=55+i*38;s.rect(7,y,226,33,P.raised);s.frame(7,y,226,33);s.text(label,17,y+12,1.5,P.text,205);});
    s.text('TAP OUTSIDE TO CLOSE',41,s.height-40,1,P.muted);
  }
}
