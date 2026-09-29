import { AudioEngine } from './audio/audio-engine.js';
import { R1Platform } from './platform/r1-platform.js';
import { APP_DEFS, CORE_APP_COUNT, PERCUSSION_VOICES, percussionPatternFor } from './core/reference-catalog.js';
import { clamp, currentApp, createDefaultState, nextApp, normalizeState, serializePersistentState, wrap } from './core/state.js';
import { render } from './ui/render.js';
import { SensorHub } from './services/sensor-hub.js';
import { InteractionRouter } from './services/interaction-router.js';
import { NavigationGuard } from './services/navigation-guard.js';
import { InputFocus } from './services/input-focus.js';
import { PatternService } from './services/pattern-service.js';
import { MediaRepository } from './services/storage/media-repository.js';
import { TransportManager } from './services/transport-manager.js';

const STORAGE_KEY = 'lilled_r1_state_v3';
const UDAQ_VIEWS = ['XYZ','ALL','AX','AY','AZ','|A|','XY|A|','XZ|A|','YZ|A|'];
const COMM_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_';
const MOTION_APPS = new Set(['rain','hsv','aem','synth','percussion','udaq','settings']);
const HSV_PRESETS = ['ELLIPSE','HORIZONTAL','DIAGONAL','VERTICAL'];
const SYNTH_MAPS = ['PITCH','DELAY','REVERB','CUTOFF','RESONANCE'];
const PARTICLE_PRESETS = ['ORBIT','CLOUD','GRAVITY','FIREFLIES'];

function transformPercussion(base, variation) {
  const copy = Object.fromEntries(Object.entries(base).map(([k,v]) => [k,[...v]]));
  if (!variation || variation === 'WHOLE KIT') return copy;
  if (variation === 'ACCENT') { for (const v of PERCUSSION_VOICES) copy[v] = copy[v].map((on,i) => on || i % 4 === 0 ? 1 : 0); }
  if (variation === 'FORWARD FILL') { copy.tom = copy.tom.map((_,i) => i >= 10 ? 1 : copy.tom[i]); copy.snare[15]=1; }
  if (variation === 'REVERSE FILL') { copy.tom = copy.tom.map((_,i) => i <= 5 ? 1 : copy.tom[i]); copy.snare[0]=1; }
  if (variation === 'BRIGHT ROLL') { copy.hat = copy.hat.map((_,i) => i >= 8 ? 1 : copy.hat[i]); }
  if (variation === 'HEAVY DROP') { copy.kick = copy.kick.map((on,i) => on || [0,3,6,8,11,14].includes(i) ? 1 : 0); }
  return copy;
}

class LilLedR1App {
  constructor(root) {
    this.root = root;
    this.platform = new R1Platform();
    this.audio = new AudioEngine();
    this.state = createDefaultState();
    this.sensorHub = new SensorHub(this.platform, { frequency: 30 });
    this.interactions = new InteractionRouter();
    this.navigationGuard = new NavigationGuard();
    this.inputFocus = new InputFocus();
    this.media = new MediaRepository();
    this.transport = new TransportManager();
    this.patternService = null;
    this.motionUnsubscribe = null;
    this.saveTimer = null;
    this.tickTimer = null;
    this.swipe = null;
    this.patternGesture = null;
    this.rainDrops = Array.from({ length: 144 }, (_, i) => ({ x:(i*37)%220, y:(i*53)%119, speed:0.8+(i%7)*0.19 }));
    this.recording = null;
    this.recordingChunks = [];
    this.recordingBlob = null;
    this.recordingUrl = null;
    this.recordingAudio = null;
    this.recordingLoadPending = false;
    this.recordingStartedAt = 0;
    this.cameraStream = null;
    this.cameraPendingBlob = null;
    this.particles = [];
    this.particleTarget = { x:110, y:68 };
    this.lastTick = performance.now();
    this.lastAppId = null;
    this.lastPowerRead = 0;
    this.lastWhoFiFrame = 0;
  }

  async start() {
    const stored = await this.platform.loadJson(STORAGE_KEY);
    this.state = normalizeState(stored);
    this.patternService = new PatternService(this.state.settings);
    this.sensorHub.setCalibration(this.state.motion.calibration);
    this.applyQuerySelection();
    this.audio.setVolume(this.state.settings.volume / 100);
    this.seedParticles();
    this.installPlatformHandlers();
    this.installDomHandlers();
    this.platform.onPluginMessage(data => this.onPluginMessage(data));
    this.transport.onMessage(event => this.onTransportEvent(event));
    this.tickTimer = setInterval(() => this.tick(), 50);
    await this.refreshMediaFiles();
    this.render();
  }

  applyQuerySelection() {
    const query = new URLSearchParams(location.search);
    const screen = query.get('screen');
    if (screen) {
      const index = APP_DEFS.findIndex(app => app.id === screen);
      if (index >= 0) Object.assign(this.state,{appIndex:index,screenIndex:index,drawerIndex:index,drawerOpen:false});
    }
    const page=query.get('page');if(page&&screen&&this.state[screen]&&typeof this.state[screen]==='object')this.state[screen].page=page;
    if(query.get('drawer')==='1')this.state.drawerOpen=true;if(query.get('scope')==='labs')this.state.drawerScope='labs';
  }

  installPlatformHandlers() {
    this.platform.on('wheel', d => this.onWheel(d));
    this.platform.on('sideHoldStart', () => this.primaryAction(true));
    this.platform.on('sideHoldEnd', () => this.primaryRelease());
    this.platform.on('sideClick', () => this.flashStatus('SIDE BUTTON: HOLD ACTIONS ONLY'));
    this.platform.on('apps', () => this.openDrawer());
    this.platform.on('next', () => this.goNext(1));
  }

  installDomHandlers() {
    this.root.addEventListener('click', e => this.onClick(e));
    this.root.addEventListener('pointerdown', e => this.onPointerDown(e));
    this.root.addEventListener('pointermove', e => this.onPointerMove(e));
    this.root.addEventListener('pointerup', e => this.onPointerUp(e));
    this.root.addEventListener('pointercancel', e => this.onPointerCancel(e));
    this.root.addEventListener('input', e => this.onInput(e));
  }

  onClick(event) {
    const open=event.target.closest('[data-open-screen]');if(open){this.openApp(Number(open.dataset.openScreen));return;}
    const step=event.target.closest('[data-perc-step]');if(step){const [v,i]=step.dataset.percStep.split(':');this.togglePercStep(v,Number(i));return;}
    const file=event.target.closest('[data-file-index]');if(file){this.state.transfer.selected=Number(file.dataset.fileIndex);this.renderAndSave();return;}
    const setting=event.target.closest('[data-setting-focus]');if(setting){this.state.settings.focus=Number(setting.dataset.settingFocus);this.renderAndSave();return;}
    const focus=event.target.closest('[data-focus]');if(focus){this.setFocus(focus.dataset.focus);return;}
    const who=event.target.closest('[data-whofi-page]');if(who){this.state.whofi.page=who.dataset.whofiPage;this.renderAndSave();return;}
    const notebook=event.target.closest('[data-notebook-page]');if(notebook){this.state.notebook.page=notebook.dataset.notebookPage;this.renderAndSave();return;}
    const scene=event.target.closest('[data-midi-scene]');if(scene){this.state.lilmidi.scene=scene.dataset.midiScene;this.state.lilmidi.draftDirty=true;this.renderAndSave();return;}
    const action=event.target.closest('[data-action]');if(action)this.dispatchAction(action.dataset.action);
  }

  onInput(event) {
    if (event.target.id === 'recordSeek') {
      const value = clamp(Number(event.target.value)||0,0,this.state.recorder.duration||0);
      this.state.recorder.position=value;
      if(this.recordingAudio)this.recordingAudio.currentTime=value;
    }
  }

  dispatchAction(action) {
    switch(action) {
      case 'apps':this.openDrawer();break;case 'next':this.goNext(1);break;case 'primary':this.primaryAction(false);break;
      case 'drawer-core':this.setDrawerScope('core');break;case 'drawer-labs':this.setDrawerScope('labs');break;
      case 'rain-mode':this.state.rain.windMode=this.state.rain.windMode==='IMU'?'MANUAL':'IMU';this.renderAndSave();break;
      case 'rain-predictor':this.state.rain.predictor=this.state.rain.predictor==='LIVE SWEPT'?'SPAWN SWEPT':this.state.rain.predictor==='SPAWN SWEPT'?'LEGACY ENDPOINT':'LIVE SWEPT';this.renderAndSave();break;
      case 'rain-reset':Object.assign(this.state.rain,{hits:0,misses:0,predicted:0});this.resetRainDrops();this.renderAndSave();break;
      case 'hsv-imu':this.state.hsv.imuPlane=!this.state.hsv.imuPlane;if(!this.state.hsv.imuPlane){this.state.hsv.tilt=this.state.hsv.manualTilt;this.state.hsv.spin=this.state.hsv.manualSpin;}this.renderAndSave();break;
      case 'hsv-preset':this.cycleHsvPreset();break;case 'hsv-undo':this.state.hsv.swatches.shift();this.renderAndSave();break;case 'hsv-clear':this.state.hsv.swatches=[];this.renderAndSave();break;
      case 'aem-driver':this.state.aem.driver=this.state.aem.driver==='CURRENT'?'VOLTAGE':'CURRENT';this.recomputeAem();this.renderAndSave();break;case 'aem-imu':this.state.aem.imuControl=!this.state.aem.imuControl;this.renderAndSave();break;case 'aem-degas':this.toggleDegas();break;
      case 'synth-perform':this.state.synth.page='perform';this.renderAndSave();break;case 'synth-map':this.state.synth.page='map';this.renderAndSave();break;case 'synth-sound':this.state.synth.page='sound';this.renderAndSave();break;case 'synth-imu':this.state.synth.imuMotion=!this.state.synth.imuMotion;this.renderAndSave();break;case 'synth-wave':this.cycleSynthWaveform();break;case 'synth-mute':this.state.synth.muted=!this.state.synth.muted;this.renderAndSave();break;
      case 'perc-view':this.state.percussion.page=this.state.percussion.page==='xy'?'pattern':'xy';this.renderAndSave();break;case 'perc-motion':this.state.percussion.motionFx=!this.state.percussion.motionFx;this.renderAndSave();break;case 'perc-kit':this.cyclePercKit();break;
      case 'record':this.recordPrimary();break;case 'record-replay':this.playRecording();break;case 'record-save':this.saveRecording();break;case 'record-discard':this.discardRecording();break;case 'record-back':this.seekRecording(-5);break;case 'record-forward':this.seekRecording(5);break;case 'record-share':this.shareRecording();break;
      case 'udaq-rate':this.cycleUdaqRate();break;case 'udaq-clear':this.state.udaq.history=[];this.render();break;case 'udaq-zero':this.centerMotion();break;case 'udaq-export':this.exportUdaqCsv();break;
      case 'settings-center':this.centerMotion();break;case 'settings-pattern-reset':this.resetSharedPattern();break;case 'settings-intro':this.state.settings.introSeen=false;this.flashStatus('INTRO REPLAY FLAG SET');this.scheduleSave();break;
      case 'transfer-home':this.state.transfer.browserPage='home';this.renderAndSave();break;case 'transfer-browser':this.state.transfer.browserPage='browser';this.refreshMediaFiles().then(()=>this.renderAndSave());break;case 'transfer-preview':this.state.transfer.browserPage='preview';this.renderAndSave();break;case 'transfer-wireless':this.state.transfer.browserPage='wireless';this.renderAndSave();break;case 'transfer-toggle-wireless':this.toggleTransferWireless();break;case 'transfer-lock':this.lockArea('transfer');break;case 'transfer-export':this.exportState();break;
      case 'comm-home':this.state.communications.section='home';this.renderAndSave();break;case 'comm-compose':this.state.communications.section='compose';this.renderAndSave();break;case 'comm-journal':this.state.communications.section='journal';this.renderAndSave();break;case 'comm-review':this.state.communications.section='review';this.renderAndSave();break;case 'comm-quick':this.applyQuickMessage();break;case 'comm-lock':this.lockArea('communications');break;case 'comm-char-back':this.state.communications.draft=this.state.communications.draft.slice(0,-1);this.renderAndSave();break;case 'comm-char-add':this.addCommChar();break;case 'comm-save-local':this.saveLocalMessage();break;case 'comm-rabbit-ping':this.sendRabbitPing();break;case 'comm-clear':this.state.communications.journal=[];this.renderAndSave();break;
      case 'whofi-menu':this.state.whofi.page='menu';this.renderAndSave();break;case 'whofi-tools':this.state.whofi.page='tools';this.renderAndSave();break;case 'whofi-signal':this.state.whofi.page='signal';this.renderAndSave();break;case 'whofi-advanced':this.state.whofi.page='advanced';this.renderAndSave();break;case 'whofi-toggle':this.toggleWhoFi();break;case 'whofi-freeze':this.state.whofi.frozen=!this.state.whofi.frozen;this.renderAndSave();break;case 'whofi-plot':this.cycleWhoFiPlot();break;case 'whofi-gain':this.state.whofi.fixedSpan=!this.state.whofi.fixedSpan;this.renderAndSave();break;case 'whofi-clear':this.state.whofi.history=[];this.render();break;case 'whofi-raw':this.toggleWhoFiRaw();break;case 'whofi-detail':this.state.whofi.detailPage=(this.state.whofi.detailPage+1)%3;this.renderAndSave();break;case 'whofi-provider-sim':this.state.whofi.provider='SIM';this.renderAndSave();break;case 'whofi-dimmer':this.state.whofi.brightness=clamp(this.state.whofi.brightness-16,32,255);this.renderAndSave();break;case 'whofi-brighter':this.state.whofi.brightness=clamp(this.state.whofi.brightness+16,32,255);this.renderAndSave();break;case 'whofi-cue-down':this.state.whofi.cueLevel=clamp(this.state.whofi.cueLevel-10,0,100);this.renderAndSave();break;case 'whofi-cue-up':this.state.whofi.cueLevel=clamp(this.state.whofi.cueLevel+10,0,100);this.renderAndSave();break;case 'whofi-cues':this.state.whofi.cues=!this.state.whofi.cues;this.renderAndSave();break;
      case 'midi-perform':this.state.lilmidi.page='perform';this.renderAndSave();break;case 'midi-map':this.state.lilmidi.page='map';this.renderAndSave();break;case 'midi-scenes':this.state.lilmidi.page='scenes';this.renderAndSave();break;case 'midi-review':this.state.lilmidi.page='review';this.renderAndSave();break;case 'midi-apply':this.applyMidiDraft();break;case 'midi-discard':this.discardMidiDraft();break;
      case 'particles-pause':this.state.particles.paused=!this.state.particles.paused;this.renderAndSave();break;case 'particles-reset':this.seedParticles(false);this.flashStatus('WORLD RESET');break;case 'particles-preset':this.cycleParticlePreset();break;case 'particles-grid':this.state.particles.grid=!this.state.particles.grid;this.renderAndSave();break;
      case 'notebook-home':this.state.notebook.page='home';this.renderAndSave();break;case 'notebook-timer-toggle':this.state.notebook.timerRunning=!this.state.notebook.timerRunning;this.renderAndSave();break;case 'notebook-timer-reset':this.state.notebook.timerRunning=false;this.state.notebook.timerRemaining=this.state.notebook.timerSeconds;this.renderAndSave();break;case 'notebook-stopwatch-toggle':this.state.notebook.stopwatchRunning=!this.state.notebook.stopwatchRunning;this.renderAndSave();break;case 'notebook-stopwatch-reset':this.state.notebook.stopwatchRunning=false;this.state.notebook.stopwatchMs=0;this.renderAndSave();break;case 'notebook-calc-clear':this.state.notebook.calc='0';this.renderAndSave();break;case 'notebook-calc-plus':this.state.notebook.calc=String((Number(this.state.notebook.calc)||0)+1);this.renderAndSave();break;case 'notebook-accent':this.state.notebook.accent=this.state.notebook.accent==='CYAN'?'GOLD':this.state.notebook.accent==='GOLD'?'VIOLET':'CYAN';this.renderAndSave();break;case 'notebook-dim':this.state.notebook.idleDimming=!this.state.notebook.idleDimming;this.renderAndSave();break;
      case 'camera-toggle':this.toggleCamera();break;case 'camera-snap':this.captureCameraFrame();break;case 'camera-flip':this.flipCamera();break;case 'camera-save':this.saveCameraFrame();break;
      default:break;
    }
  }

  onPointerDown(event) {
    this.state.settings.touchDown += 1;
    const pattern=event.target.closest('.pattern-grid');if(pattern){this.interactions.claim(event,`pattern:${pattern.dataset.patternApp}`,pattern);this.startPatternGesture(event,pattern);return;}
    const synth=event.target.closest('#synthPad');if(synth){this.interactions.claim(event,'synth',synth);this.setSynthPad(event,synth,true);return;}
    const perc=event.target.closest('#percussionPad');if(perc){this.interactions.claim(event,'percussion',perc);this.beginPercussionContact(event,perc);return;}
    const hsvSection=event.target.closest('#hsvPad');if(hsvSection){this.interactions.claim(event,'hsv-sample',hsvSection);this.setHsvSample(event,hsvSection);return;}
    const hsvCone=event.target.closest('#hsvCone');if(hsvCone){this.interactions.claim(event,'hsv-orbit',hsvCone);this.interactions.active.data={x:event.clientX,y:event.clientY,yaw:this.state.hsv.cameraYaw};return;}
    const aem=event.target.closest('#aemStack');if(aem){this.interactions.claim(event,'aem',aem);this.setAemFromPointer(event,aem);return;}
    const midi=event.target.closest('#midiPad');if(midi){this.interactions.claim(event,'midi',midi);this.setMidiPad(event,midi);return;}
    const particles=event.target.closest('#particlesCanvas');if(particles){this.interactions.claim(event,'particles',particles);this.setParticleTarget(event,particles);return;}
    const daq=event.target.closest('#daqCanvas');if(daq){this.state.udaq.running=!this.state.udaq.running;this.renderAndSave();return;}
    if(!event.target.closest('[data-interactive]'))this.swipe={x:event.clientX,y:event.clientY,t:performance.now(),id:event.pointerId};
  }

  onPointerMove(event) {
    const owner=this.interactions.owner();
    if(this.patternGesture&&this.interactions.owns(event)){this.extendPatternGesture(event);return;}
    if(!event.buttons)return;
    const el=this.interactions.active?.element;
    if(owner==='synth')this.setSynthPad(event,el,false);
    else if(owner==='percussion')this.updatePercussionContact(event,el);
    else if(owner==='hsv-sample')this.setHsvSample(event,el);
    else if(owner==='hsv-orbit')this.updateHsvOrbit(event);
    else if(owner==='aem')this.setAemFromPointer(event,el);
    else if(owner==='midi')this.setMidiPad(event,el);
    else if(owner==='particles')this.setParticleTarget(event,el);
  }

  onPointerUp(event) {
    this.state.settings.touchUp += 1;
    if(this.patternGesture&&this.interactions.owns(event)){this.finishPatternGesture();this.interactions.release(event);return;}
    const owner=this.interactions.owner();
    if(owner==='synth')this.stopSynth();
    if(owner==='percussion')this.finishPercussionContact();
    this.interactions.release(event);
    if(!this.swipe||this.swipe.id!==event.pointerId)return;
    const dx=event.clientX-this.swipe.x,dy=event.clientY-this.swipe.y,dt=performance.now()-this.swipe.t;this.swipe=null;
    if(dt<650&&Math.abs(dx)>=48&&Math.abs(dx)>Math.abs(dy)*1.35)this.goNext(dx<0?1:-1);
  }

  onPointerCancel(event) {
    this.state.settings.touchDrop += 1;this.swipe=null;
    if(this.patternGesture&&this.interactions.owns(event))this.patternGesture=null;
    const owner=this.interactions.owner();if(owner==='synth')this.stopSynth();if(owner==='percussion')this.finishPercussionContact();this.interactions.cancel(event);
  }

  render() {
    this.configureFocus();
    this.refreshGuards();
    this.root.innerHTML=render(this.state,this.platform);
    this.root.style.setProperty('--app-brightness',String((.55+(this.state.settings.brightness/255)*.70).toFixed(3)));
    this.afterRender();
  }

  async afterRender() {
    const id=currentApp(this.state).id;
    if(id!==this.lastAppId){const previous=this.lastAppId;this.leaveAppCleanup(previous);this.lastAppId=id;if(id==='power'&&!this.state.drawerOpen)this.readBattery();if(id==='transfer')this.refreshMediaFiles();}
    await this.updateMotionLifecycle();
    if(id==='camera'&&this.state.camera.state==='live')this.attachCameraVideo();
    if(id==='recorder'&&this.state.recorder.savedId&&!this.recordingUrl&&!this.recordingLoadPending)this.loadSavedRecording();
    this.drawCurrent();
  }

  async updateMotionLifecycle() {
    const id=currentApp(this.state).id,needed=!this.state.drawerOpen&&MOTION_APPS.has(id);
    if(needed&&!this.motionUnsubscribe){this.motionUnsubscribe=this.sensorHub.subscribe('runtime',sample=>this.onMotion(sample));const ok=await this.sensorHub.ensureStarted();if(!ok){this.state.motion.available=false;this.state.motion.source='SIM';}}
    if(!needed&&this.motionUnsubscribe){this.motionUnsubscribe();this.motionUnsubscribe=null;await this.sensorHub.stop();}
  }

  onMotion(sample) {
    if(!sample)return;const m=this.state.motion;
    Object.assign(m,{available:true,source:'R1',fresh:sample.status.fresh,validGravity:sample.status.validGravity,ageMs:sample.status.ageMs,rawX:sample.raw.x,rawY:sample.raw.y,rawZ:sample.raw.z,x:sample.filtered.x,y:sample.filtered.y,z:sample.filtered.z,magnitude:sample.magnitudeG,pitch:sample.attitude.pitch,roll:sample.attitude.roll,jerk:sample.motion.jerk,shake:sample.motion.shake,sequence:sample.sequence,calibration:this.sensorHub.exportCalibration()});
    const valid=sample.status.fresh&&sample.status.validGravity;
    const r=this.state.rain;if(r.windMode==='IMU'){r.imuStatus=valid?'IMU WIND':sample.status.fresh?'MOVE SLOW':'IMU STALE';r.effectiveWind=valid?clamp(sample.attitude.roll/45*140,-140,140):r.effectiveWind*.88;r.effectiveTargetSpeed=clamp(r.targetSpeed+(valid?sample.attitude.roll/45*83:0),-166,166);r.effectiveFallSpeed=clamp(r.fallSpeed*(1+(valid?sample.attitude.pitch/60*.45:0)),70,430);}else{r.imuStatus='MANUAL';r.effectiveWind=r.manualWind;r.effectiveTargetSpeed=r.targetSpeed;r.effectiveFallSpeed=r.fallSpeed;}
    const h=this.state.hsv;if(h.imuPlane){h.imuStatus=valid?'IMU PLANE':sample.status.fresh?'MOVE SLOW':'IMU STALE';if(valid){h.tilt=clamp(h.manualTilt+sample.attitude.pitch*.85,-75,75);h.spin=wrap(h.manualSpin-sample.attitude.roll*1.35,360);}}
    const a=this.state.aem;if(a.imuControl){a.imuStatus=valid?'IMU MODEL':sample.status.fresh?'MOVE SLOW':'IMU STALE';if(valid){a.load=clamp(a.baselineLoad+sample.attitude.pitch*.32,0,100);a.effectiveWater=clamp((a.baselineWater??a.water)+sample.attitude.roll*.28,0,100);if(sample.motion.shake&&!a.degas)this.startDegas(1500);this.recomputeAem(false);}}else{a.imuStatus='BASELINE';a.load=a.baselineLoad;a.effectiveWater=a.baselineWater??a.water;this.recomputeAem(false);}
    const s=this.state.synth;if(s.imuMotion){s.imuStatus=valid?'MOTION MAP':sample.status.fresh?'MOVE SLOW':'IMU STALE';if(valid){s.delay=clamp(s.baseDelay+Math.max(0,sample.attitude.roll)/90*.35,0,.55);s.reverb=clamp(s.baseReverb+Math.max(0,-sample.attitude.roll)/90*.32,0,.6);s.arpDirection=sample.attitude.roll>8?'UP':sample.attitude.roll<-8?'DOWN':'ALT';s.arpSpan=clamp(1+Math.floor(Math.abs(sample.attitude.pitch)/16),1,4);s.arpRate=clamp(2+Math.round(sample.attitude.pitch/18),1,6);this.audio.updatePadVoice(s.padX,s.padY,this.synthOptions());}}else s.imuStatus='MOTION OFF';
    const p=this.state.percussion;if(p.motionFx){p.imuStatus=valid?'MOTION FX':sample.status.fresh?'MOVE SLOW':'IMU STALE';if(valid){p.delay=clamp(Math.max(0,sample.attitude.roll)/90*.35,0,.4);p.reverb=clamp(.12+Math.max(0,-sample.attitude.roll)/90*.35,.05,.5);}}else p.imuStatus='FX OFF';
    Object.assign(this.state.udaq,{source:'R1',sourceAvailable:true,sourceFresh:sample.status.fresh,x:sample.filtered.x,y:sample.filtered.y,z:sample.filtered.z,magnitude:sample.magnitudeG,pitch:sample.attitude.pitch,roll:sample.attitude.roll,jerk:sample.motion.jerk});
  }

  leaveAppCleanup(id) {
    if(!id)return;if(id==='synth')this.stopSynth(false);if(id==='camera')this.stopCamera(false);if(id==='transfer')this.lockArea('transfer',false);if(id==='communications')this.lockArea('communications',false);if(id==='whofi'&&!this.state.whofi.rawStream){this.state.whofi.running=false;this.state.whofi.connecting=false;}
  }

  refreshGuards() {
    this.navigationGuard.set('recorder',this.state.recorder.state==='recording'||this.state.recorder.dirty,'Recorder capture/review must be saved or discarded');
    this.navigationGuard.set('camera',this.state.camera.dirty,'Camera capture must be saved before leaving');
    this.navigationGuard.set('whofi',this.state.whofi.rawStream,'End WhoFi remote stream before leaving');
    this.navigationGuard.set('transfer',this.state.transfer.transferState==='ACTIVE','Active transfer must finish or cancel');
    this.state.interaction.navigationBlocked=this.navigationGuard.blocked();
  }

  canNavigate() {this.refreshGuards();if(!this.navigationGuard.blocked())return true;this.flashStatus(this.navigationGuard.reason(),2400);return false;}
  renderAndSave(){this.render();this.scheduleSave();}
  scheduleSave(){clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.platform.saveJson(STORAGE_KEY,serializePersistentState(this.state)).catch(e=>console.error('save',e)),220);}
  flashStatus(message,ms=1500){this.state.statusMessage=String(message).slice(0,80);this.state.statusUntil=Date.now()+ms;this.render();}

  setDrawerScope(scope){this.state.drawerScope=scope;this.state.drawerIndex=scope==='core'?Math.min(this.state.appIndex,CORE_APP_COUNT-1):Math.max(CORE_APP_COUNT,this.state.appIndex);if(scope==='labs'&&this.state.drawerIndex<CORE_APP_COUNT)this.state.drawerIndex=CORE_APP_COUNT;this.render();}
  drawerIndices(){return this.state.drawerScope==='labs'?APP_DEFS.map((_,i)=>i).slice(CORE_APP_COUNT):APP_DEFS.map((_,i)=>i).slice(0,CORE_APP_COUNT);}
  openDrawer(){if(!this.canNavigate())return;this.state.drawerOpen=true;this.state.drawerIndex=this.state.appIndex;this.state.drawerScope=this.state.appIndex>=CORE_APP_COUNT?'labs':'core';this.render();}
  openApp(index){if(!this.canNavigate())return;this.state.appIndex=wrap(index,APP_DEFS.length);this.state.screenIndex=this.state.appIndex;this.state.drawerIndex=this.state.appIndex;this.state.drawerOpen=false;this.renderAndSave();}
  goNext(delta){if(!this.canNavigate())return;this.state.drawerOpen=false;nextApp(this.state,delta);this.renderAndSave();}

  configureFocus() {
    if(this.state.drawerOpen){this.state.interaction.wheelLabel='APP SELECT';return;}
    const id=currentApp(this.state).id,s=this.state;
    const labels={rain:`${s.rain.focus} BASE`,hsv:`${s.hsv.focus}`,aem:`${s.aem.focus}`,synth:`${s.synth.focus}`,percussion:s.percussion.page==='xy'?`${s.percussion.focus}`:'BPM',udaq:`VIEW ${s.udaq.view}`,settings:`ROW ${s.settings.focus+1}`,transfer:'FILE SELECT',communications:s.communications.section==='compose'?'CHARACTER':'',whofi:'SPAN',lilmidi:`${s.lilmidi.focus}`,particles:`${s.particles.focus}`,notebook:s.notebook.page==='home'?'UTILITY':s.notebook.page==='timer'?'TIMER':s.notebook.page==='calendar'?'DATE':s.notebook.page==='ruler'?'RULER':''};
    this.state.interaction.wheelLabel=labels[id]||'';
  }
  setFocus(focus){const id=currentApp(this.state).id;if(this.state[id]&&'focus' in this.state[id])this.state[id].focus=focus;this.renderAndSave();}

  onWheel(direction) {
    if(this.state.drawerOpen){const indices=this.drawerIndices(),at=Math.max(0,indices.indexOf(this.state.drawerIndex));this.state.drawerIndex=indices[wrap(at+direction,indices.length)];this.render();return;}
    const id=currentApp(this.state).id,s=this.state;
    if(id==='rain'){const r=s.rain;if(r.focus==='WIND')r.manualWind=clamp(r.manualWind+direction*8,-140,140);else if(r.focus==='RATE')r.spawnRate=clamp(r.spawnRate+direction*2,0,90);else if(r.focus==='FALL')r.fallSpeed=clamp(r.fallSpeed+direction*8,112,336);else if(r.focus==='TARGET')r.targetSpeed=clamp(r.targetSpeed+direction*8,-166,166);if(r.windMode==='MANUAL')Object.assign(r,{effectiveWind:r.manualWind,effectiveFallSpeed:r.fallSpeed,effectiveTargetSpeed:r.targetSpeed});}
    else if(id==='hsv'){const h=s.hsv;if(h.focus==='OFFSET')h.offset=clamp(h.offset+direction*.05,-1,1);else if(h.focus==='TILT'){h.manualTilt=clamp(h.manualTilt+direction*2,-75,75);if(!h.imuPlane)h.tilt=h.manualTilt;}else if(h.focus==='SPIN'){h.manualSpin=wrap(h.manualSpin+direction*5,360);if(!h.imuPlane)h.spin=h.manualSpin;}}
    else if(id==='aem')this.adjustAemFocus(direction);
    else if(id==='synth')this.adjustSynthFocus(direction);
    else if(id==='percussion'){const p=s.percussion;if(p.page==='pattern')p.bpm=clamp(p.bpm+direction*2,40,240);else if(p.focus==='ENERGY'){p.energy=clamp(p.energy+direction,1,4);this.refreshPercussionPattern();}else if(p.focus==='GROOVE'){p.groove=clamp(p.groove+direction,1,4);this.refreshPercussionPattern();}else if(p.focus==='BPM')p.bpm=clamp(p.bpm+direction*2,40,240);this.audio.updateSequencer(p.pattern,p.bpm,p.volume/100);}
    else if(id==='udaq'){s.udaq.viewIndex=wrap(s.udaq.viewIndex+direction,UDAQ_VIEWS.length);s.udaq.view=UDAQ_VIEWS[s.udaq.viewIndex];}
    else if(id==='settings')this.adjustSetting(direction);
    else if(id==='transfer'&&s.transfer.unlocked&&s.transfer.browserPage==='browser')s.transfer.selected=clamp(s.transfer.selected+direction,0,s.transfer.files.length-1);
    else if(id==='communications'&&s.communications.unlocked&&s.communications.section==='compose')s.communications.charIndex=wrap(s.communications.charIndex+direction,COMM_CHARS.length);
    else if(id==='whofi')s.whofi.span=clamp(s.whofi.span+direction*10,20,160);
    else if(id==='lilmidi')this.adjustMidiFocus(direction);
    else if(id==='particles')this.adjustParticleFocus(direction);
    else if(id==='notebook'){const n=s.notebook;if(n.page==='home')n.selected=wrap(n.selected+direction,7);else if(n.page==='timer'&&!n.timerRunning){n.timerSeconds=clamp(n.timerSeconds+direction*60,60,3600);n.timerRemaining=n.timerSeconds;}else if(n.page==='calendar')n.calendarOffset+=direction;else if(n.page==='ruler')n.rulerMm=clamp(n.rulerMm+direction,10,200);}
    this.renderAndSave();
  }

  adjustSetting(direction){const s=this.state.settings;if(s.page===0){if(s.focus===0)s.brightness=clamp(s.brightness+direction*16,64,255);else if(s.focus===1){const v=['30 SEC','1 MIN','2 MIN','5 MIN'];s.screenIdle=v[wrap(v.indexOf(s.screenIdle)+direction,v.length)];}else if(s.focus===2)this.flashStatus(`${s.touchDown} DOWN / ${s.touchUp} UP / ${s.touchDrop} DROP`);else if(s.focus===3)this.centerMotion();}else if(s.page===1){if(s.focus===0){const v=['SMALL','LARGE','XL'];s.textSize=v[wrap(v.indexOf(s.textSize)+direction,v.length)];}else if(s.focus===1)s.messageSound=!s.messageSound;else if(s.focus===2)s.reducedMotion=!s.reducedMotion;else if(s.focus===3)s.diagnostics=!s.diagnostics;}}

  primaryAction(fromHold) {
    if(this.state.drawerOpen){this.openApp(this.state.drawerIndex);return;}const id=currentApp(this.state).id;
    if(id==='rain'){this.state.rain.running=!this.state.rain.running;this.renderAndSave();}
    else if(id==='hsv')this.sampleHsvSwatch();
    else if(id==='aem')this.toggleDegas();
    else if(id==='synth'){if(fromHold)this.startSynthAtCurrent();else this.cycleSynthWaveform();}
    else if(id==='percussion')this.togglePercussion();
    else if(id==='recorder')this.recordPrimary();
    else if(id==='udaq'){this.state.udaq.running=!this.state.udaq.running;this.renderAndSave();}
    else if(id==='settings'){this.state.settings.page=(this.state.settings.page+1)%3;this.renderAndSave();}
    else if(id==='transfer'){if(!this.state.transfer.unlocked)this.flashStatus('DRAW PATTERN');else{this.state.transfer.browserPage='home';this.render();}}
    else if(id==='communications'){if(!this.state.communications.unlocked)this.flashStatus('DRAW PATTERN');else{this.state.communications.section='home';this.render();}}
    else if(id==='whofi')this.toggleWhoFi();
    else if(id==='lilmidi'){this.state.lilmidi.scene=this.state.lilmidi.scenes[wrap(this.state.lilmidi.scenes.indexOf(this.state.lilmidi.scene)+1,this.state.lilmidi.scenes.length)];this.renderAndSave();}
    else if(id==='particles'){this.state.particles.paused=!this.state.particles.paused;this.renderAndSave();}
    else if(id==='notebook'){const pages=['calendar','weather','timer','stopwatch','calculator','ruler','settings'];if(this.state.notebook.page==='home'){this.state.notebook.page=pages[this.state.notebook.selected%pages.length];this.renderAndSave();}else{this.state.notebook.page='home';this.renderAndSave();}}
    else if(id==='power')this.readBattery(true);
    else if(id==='camera')this.toggleCamera();
  }
  primaryRelease(){if(currentApp(this.state).id==='synth'&&this.state.synth.active)this.stopSynth();}

  resetRainDrops(){this.rainDrops.forEach((d,i)=>{d.x=(i*37)%220;d.y=(i*53)%119;});}
  cycleHsvPreset(){const h=this.state.hsv;h.preset=HSV_PRESETS[wrap(HSV_PRESETS.indexOf(h.preset)+1,HSV_PRESETS.length)];const presets={ELLIPSE:[28,40,0],HORIZONTAL:[0,0,0],DIAGONAL:[45,35,.05],VERTICAL:[72,90,0]};[h.manualTilt,h.manualSpin,h.offset]=presets[h.preset];if(!h.imuPlane){h.tilt=h.manualTilt;h.spin=h.manualSpin;}this.renderAndSave();}
  setHsvSample(event,el){const r=el.getBoundingClientRect(),x=clamp((event.clientX-r.left)/r.width,0,1),y=clamp((event.clientY-r.top)/r.height,0,1),h=this.state.hsv;h.selectedHue=wrap(Math.round(h.spin+x*180),360);h.selectedSaturation=Math.round(x*100);h.selectedValue=Math.round((1-y)*100);this.render();}
  updateHsvOrbit(event){const d=this.interactions.active?.data;if(!d)return;this.state.hsv.cameraYaw=wrap(d.yaw+(event.clientX-d.x)*.9,360);this.render();}
  sampleHsvSwatch(){const h=this.state.hsv;h.swatches.unshift({h:h.selectedHue,s:h.selectedSaturation,v:h.selectedValue});h.swatches=h.swatches.slice(0,8);this.flashStatus(`SWATCH H${h.selectedHue} S${h.selectedSaturation} V${h.selectedValue}`);this.scheduleSave();}

  recomputeAem(rerender=true){const a=this.state.aem,water=a.effectiveWater??a.water;const driver=a.driver==='CURRENT'?a.load:(a.load*.92);a.currentDensity=.30+driver*.010;a.voltage=1.68+a.currentDensity*.21+(100-water)*.0015;a.h2Rate=a.currentDensity*3.77*(a.efficiency/100);if(rerender)this.render();}
  setAemFromPointer(event,el){const r=el.getBoundingClientRect();this.state.aem.baselineLoad=clamp(Math.round(((event.clientX-r.left)/r.width)*100),0,100);if(!this.state.aem.imuControl)this.state.aem.load=this.state.aem.baselineLoad;this.recomputeAem();this.scheduleSave();}
  adjustAemFocus(d){const a=this.state.aem;if(a.focus==='LOAD')a.baselineLoad=clamp(a.baselineLoad+d*3,0,100);else if(a.focus==='WATER'){a.water=clamp(a.water+d*3,0,100);a.baselineWater=a.water;}else if(a.focus==='EFF')a.efficiency=clamp(a.efficiency+d*2,40,100);else if(a.focus==='MEM')a.membrane=clamp(a.membrane+d*3,0,100);if(!a.imuControl)a.load=a.baselineLoad;this.recomputeAem(false);}
  startDegas(ms=3000){const a=this.state.aem;a.degas=true;a.degasUntil=Math.max(a.degasUntil,Date.now()+ms);this.render();}
  toggleDegas(){if(this.state.aem.degas){this.state.aem.degas=false;this.state.aem.degasUntil=0;}else this.startDegas(3000);this.renderAndSave();}

  synthOptions(){const s=this.state.synth;return{waveform:s.waveform,transpose:s.transpose,cutoff:s.cutoff,resonance:s.resonance,delay:s.delay,reverb:s.reverb,voiceVolume:s.muted?0:s.volume};}
  async setSynthPad(event,el,start){const r=el.getBoundingClientRect(),x=clamp((event.clientX-r.left)/r.width,0,1),y=1-clamp((event.clientY-r.top)/r.height,0,1),s=this.state.synth;s.padX=x;s.padY=y;try{if(start||!s.active){await this.audio.startPadVoice(x,y,this.synthOptions());s.active=true;}else this.audio.updatePadVoice(x,y,this.synthOptions());}catch(e){this.flashStatus(e.message);}this.render();}
  async startSynthAtCurrent(){try{await this.audio.startPadVoice(this.state.synth.padX,this.state.synth.padY,this.synthOptions());this.state.synth.active=true;this.render();}catch(e){this.flashStatus(e.message);}}
  stopSynth(rerender=true){if(!this.state.synth.active)return;this.audio.stopPadVoice();this.state.synth.active=false;if(rerender)this.render();}
  cycleSynthWaveform(){const v=['SINE','SQUARE','TRIANGLE','SAW'];const s=this.state.synth;s.waveform=v[wrap(v.indexOf(s.waveform)+1,v.length)];this.renderAndSave();}
  adjustSynthFocus(d){const s=this.state.synth,f=s.focus;if(f==='CUTOFF')s.cutoff=clamp(s.cutoff+d*250,250,7000);else if(f==='RESONANCE')s.resonance=clamp(s.resonance+d*.05,0,.9);else if(f==='DELAY'){s.baseDelay=clamp(s.baseDelay+d*.03,0,.55);s.delay=s.baseDelay;}else if(f==='REVERB'){s.baseReverb=clamp(s.baseReverb+d*.03,0,.6);s.reverb=s.baseReverb;}else if(f==='VOLUME')s.volume=clamp(s.volume+d*3,0,100);else if(f==='TRANSPOSE')s.transpose=clamp(s.transpose+d,-24,24);else if(f==='MAPX')s.mapX=SYNTH_MAPS[wrap(SYNTH_MAPS.indexOf(s.mapX)+d,SYNTH_MAPS.length)];else if(f==='MAPY')s.mapY=SYNTH_MAPS[wrap(SYNTH_MAPS.indexOf(s.mapY)+d,SYNTH_MAPS.length)];else if(f==='ARPDIR'){const v=['UP','DOWN','ALT'];s.arpDirection=v[wrap(v.indexOf(s.arpDirection)+d,v.length)];}else if(f==='ARPSPAN')s.arpSpan=clamp(s.arpSpan+d,1,4);else if(f==='ARPRATE')s.arpRate=clamp(s.arpRate+d,1,6);else if(f==='TEMPO')s.tempo=clamp(s.tempo+d*2,40,240);this.audio.updatePadVoice(s.padX,s.padY,this.synthOptions());}

  beginPercussionContact(event,el){const now=performance.now(),p=this.state.percussion,r=el.getBoundingClientRect(),x=clamp((event.clientX-r.left)/r.width,0,1),y=clamp((event.clientY-r.top)/r.height,0,1),retouch=p.playing&&Date.now()<=p.graceDeadline;p.contact=true;p.contactX=x;p.contactY=y;p.padX=x;p.padY=y;p.energy=clamp(1+Math.floor(x*4),1,4);p.groove=clamp(1+Math.floor(y*4),1,4);p.variationArmed=retouch?'ACCENT':'';p.stopAtBoundary=false;this.interactions.active.data={x:event.clientX,y:event.clientY,t:now};this.refreshPercussionPattern();if(!p.playing)this.startPercussion();this.render();}
  updatePercussionContact(event,el){const d=this.interactions.active?.data;if(!d)return;const p=this.state.percussion,r=el.getBoundingClientRect();p.padX=clamp((event.clientX-r.left)/r.width,0,1);p.padY=clamp((event.clientY-r.top)/r.height,0,1);if(p.variationArmed&&performance.now()-d.t<=180){const dx=event.clientX-d.x,dy=event.clientY-d.y;if(Math.hypot(dx,dy)>12){if(Math.abs(dx)>Math.abs(dy))p.variationArmed=dx>0?'FORWARD FILL':'REVERSE FILL';else p.variationArmed=dy<0?'BRIGHT ROLL':'HEAVY DROP';}}this.render();}
  finishPercussionContact(){const p=this.state.percussion;if(!p.contact)return;p.contact=false;p.releasedAt=Date.now();p.graceDeadline=p.releasedAt+650;p.stopAtBoundary=true;this.render();}
  refreshPercussionPattern(){const p=this.state.percussion;p.pattern=percussionPatternFor(p.energy,p.groove);this.audio.updateSequencer(p.pattern,p.bpm,p.volume/100);}
  togglePercStep(v,i){if(!PERCUSSION_VOICES.includes(v)||i<0||i>15)return;this.state.percussion.pattern[v][i]^=1;this.audio.updateSequencer(this.state.percussion.pattern,this.state.percussion.bpm,this.state.percussion.volume/100);this.renderAndSave();}
  async startPercussion(){const p=this.state.percussion;try{await this.audio.startSequencer(p.pattern,p.bpm,step=>this.onPercussionStep(step),p.volume/100);p.playing=true;p.stopAtBoundary=false;this.renderAndSave();}catch(e){this.flashStatus(e.message);}}
  onPercussionStep(step){const p=this.state.percussion;p.currentStep=step;if(step===0){if(p.stopAtBoundary&&!p.contact&&Date.now()>p.graceDeadline){this.audio.stopSequencer();p.playing=false;p.currentStep=-1;p.stopAtBoundary=false;p.variation='WHOLE KIT';this.renderAndSave();return;}if(p.variationArmed){p.variation=p.variationArmed;this.audio.updateSequencer(transformPercussion(p.pattern,p.variationArmed),p.bpm,p.volume/100);p.variationArmed='';}else if(p.variation!=='WHOLE KIT'){p.variation='WHOLE KIT';this.audio.updateSequencer(p.pattern,p.bpm,p.volume/100);}}if(currentApp(this.state).id==='percussion'&&!this.state.drawerOpen)this.render();}
  togglePercussion(){const p=this.state.percussion;if(p.playing){this.audio.stopSequencer();Object.assign(p,{playing:false,currentStep:-1,contact:false,stopAtBoundary:false,variation:'WHOLE KIT'});this.renderAndSave();}else this.startPercussion();}
  cyclePercKit(){const v=['CIRCUIT','WARM','METAL'],p=this.state.percussion;p.kit=v[wrap(v.indexOf(p.kit)+1,v.length)];this.renderAndSave();}

  async recordPrimary(){if(this.state.recorder.state==='recording'){this.stopRecording();return;}if(this.state.recorder.hasClip){this.playRecording();return;}await this.startRecording();}
  async startRecording(){if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){this.state.recorder.error='MIC API UNAVAILABLE';this.render();return;}try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});this.recordingChunks=[];const rec=new MediaRecorder(stream);rec.addEventListener('dataavailable',e=>{if(e.data?.size)this.recordingChunks.push(e.data);});rec.addEventListener('stop',()=>this.finishRecording(rec,stream),{once:true});rec.start(100);this.recording=rec;this.recordingStartedAt=performance.now();Object.assign(this.state.recorder,{state:'recording',error:'',dirty:true,hasClip:false,review:false,seconds:0});this.render();}catch(e){this.state.recorder.error=`MIC: ${e.name||'ERROR'}`;this.render();}}
  finishRecording(rec,stream){this.recordingBlob=new Blob(this.recordingChunks,{type:rec.mimeType||'audio/webm'});if(this.recordingUrl)URL.revokeObjectURL(this.recordingUrl);this.recordingUrl=URL.createObjectURL(this.recordingBlob);stream.getTracks().forEach(t=>t.stop());this.recording=null;const duration=(performance.now()-this.recordingStartedAt)/1000;Object.assign(this.state.recorder,{state:'review',hasClip:this.recordingBlob.size>0,clipBytes:this.recordingBlob.size,error:'',review:true,duration,seconds:duration,position:0,dirty:this.recordingBlob.size>0,saved:false});this.render();}
  stopRecording(){if(this.recording?.state==='recording')this.recording.stop();}
  async loadSavedRecording(){
    if(this.recordingLoadPending||!this.state.recorder.savedId)return;
    this.recordingLoadPending=true;
    try{
      const item=await this.media.get(this.state.recorder.savedId);
      if(!item?.blob)return;
      this.recordingBlob=item.blob;
      if(this.recordingUrl)URL.revokeObjectURL(this.recordingUrl);
      this.recordingUrl=URL.createObjectURL(item.blob);
      Object.assign(this.state.recorder,{hasClip:true,state:'review',review:true,saved:true,dirty:false,clipBytes:item.blob.size,duration:Number(item.duration||this.state.recorder.duration||0),seconds:Number(item.duration||this.state.recorder.seconds||0)});
      if(currentApp(this.state).id==='recorder')this.render();
    }catch(e){
      this.state.recorder.error=`LOAD: ${e.name||'ERROR'}`;
    }finally{
      this.recordingLoadPending=false;
    }
  }
  async playRecording(){if(!this.recordingUrl)return;try{this.recordingAudio?.pause();const a=new Audio(this.recordingUrl);this.recordingAudio=a;a.volume=this.state.settings.volume/100;a.currentTime=clamp(this.state.recorder.position,0,this.state.recorder.duration||0);a.addEventListener('timeupdate',()=>{this.state.recorder.position=a.currentTime;},{passive:true});a.addEventListener('ended',()=>{this.state.recorder.position=0;if(currentApp(this.state).id==='recorder')this.render();},{once:true});await a.play();}catch(e){this.flashStatus(e.message);}}
  seekRecording(delta){const r=this.state.recorder;r.position=clamp(r.position+delta,0,r.duration||0);if(this.recordingAudio)this.recordingAudio.currentTime=r.position;this.render();}
  async saveRecording(){if(!this.recordingBlob){this.flashStatus('NO UNSAVED CLIP');return;}const rec=await this.media.put({kind:'audio',name:`Recording-${new Date().toISOString().replace(/[:.]/g,'-')}.webm`,mime:this.recordingBlob.type,blob:this.recordingBlob,duration:this.state.recorder.duration});Object.assign(this.state.recorder,{saved:true,savedId:rec.id,dirty:false});await this.refreshMediaFiles();this.flashStatus('RECORDING SAVED LOCALLY');this.scheduleSave();}
  async shareRecording(){const id=this.state.recorder.savedId;if(!id){this.flashStatus('SAVE BEFORE SHARE');return;}this.state.communications.voiceAssetId=id;this.state.communications.draft='[voice recording]';this.flashStatus('VOICE STAGED FOR COMMUNICATIONS');this.scheduleSave();}
  discardRecording(){this.recordingAudio?.pause();if(this.recordingUrl)URL.revokeObjectURL(this.recordingUrl);this.recordingUrl=null;this.recordingBlob=null;this.state.recorder={...createDefaultState().recorder,savedId:this.state.recorder.savedId};this.renderAndSave();}

  cycleUdaqRate(){const v=[5,10,25],u=this.state.udaq;u.sampleRate=v[wrap(v.indexOf(u.sampleRate)+1,v.length)];this.renderAndSave();}
  advanceUdaq(now){const u=this.state.udaq;if(!u.running)return;const period=1000/u.sampleRate;if(now>=u.lastSampleMs&&now-u.lastSampleMs<period)return;u.lastSampleMs=now;if(u.source!=='R1'){const t=now/950;u.x=Math.sin(t)*.42;u.y=Math.cos(t*.73)*.29;u.z=.93+Math.sin(t*.41)*.04;u.magnitude=Math.hypot(u.x,u.y,u.z);u.pitch=Math.atan2(u.y,Math.hypot(u.x,u.z))*180/Math.PI;u.roll=Math.atan2(u.x,Math.hypot(u.y,u.z))*180/Math.PI;}u.history.push({t:Date.now(),x:u.x,y:u.y,z:u.z,m:u.magnitude,pitch:u.pitch,roll:u.roll,jerk:u.jerk,source:u.source,fresh:u.sourceFresh,seq:this.state.motion.sequence});if(u.history.length>300)u.history.splice(0,u.history.length-300);}
  exportUdaqCsv(){const rows=['timestamp,sequence,source,x,y,z,magnitude,pitch,roll,jerk,fresh',...this.state.udaq.history.map(s=>[s.t,s.seq,s.source,s.x,s.y,s.z,s.m,s.pitch,s.roll,s.jerk,s.fresh].join(','))];this.downloadBlob(new Blob([rows.join('\n')],{type:'text/csv'}),'lilled-r1-udaq.csv');this.flashStatus('uDAQ CSV EXPORT REQUESTED');}
  centerMotion(){if(this.sensorHub.center()){this.state.motion.calibration=this.sensorHub.exportCalibration();this.state.settings.imuZero=`CENTERED G${this.state.motion.calibration.generation}`;this.flashStatus('MOTION CENTERED');this.scheduleSave();}else this.flashStatus('NO LIVE MOTION SAMPLE');}

  startPatternGesture(event,grid){const app=grid.dataset.patternApp,lock=this.state[app];if(!lock||lock.lockoutUntil>Date.now())return;lock.gesture=[];this.patternGesture={app,grid,pointerId:event.pointerId};this.extendPatternGesture(event);}
  extendPatternGesture(event){const g=this.patternGesture;if(!g)return;const r=g.grid.getBoundingClientRect(),x=clamp(event.clientX-r.left,0,r.width-.01),y=clamp(event.clientY-r.top,0,r.height-.01),idx=Math.floor(y/(r.height/3))*3+Math.floor(x/(r.width/3)),lock=this.state[g.app];if(lock.gesture.at(-1)!==idx&&!lock.gesture.includes(idx)){lock.gesture.push(idx);g.grid.querySelector(`[data-pattern-dot="${idx}"]`)?.classList.add('active');}}
  finishPatternGesture(){const g=this.patternGesture;this.patternGesture=null;if(!g)return;const lock=this.state[g.app],path=[...lock.gesture];lock.gesture=[];const result=this.patternService.verify(path,lock);if(result.ok){lock.unlocked=true;if(g.app==='transfer')lock.browserPage='home';if(g.app==='communications')lock.section='home';this.flashStatus(g.app==='transfer'?'FILES UNLOCKED':'MESSAGING UNLOCKED');}else this.flashStatus(result.reason,2400);this.scheduleSave();}
  resetSharedPattern(){this.state.settings.pattern=[0,1,2,5,8];this.state.settings.patternEnrolled=true;this.flashStatus('DEMO PATTERN RESET');this.scheduleSave();}
  lockArea(app,rerender=true){const s=this.state[app];if(!s)return;s.unlocked=false;s.gesture=[];if(app==='transfer')s.browserPage='home';if(app==='communications')s.section='home';if(rerender)this.renderAndSave();}

  async refreshMediaFiles(){const media=await this.media.list().catch(()=>[]),base=createDefaultState().transfer.files;this.state.transfer.files=[...base,...media.slice(0,12).map(m=>({id:m.id,name:`Media/${m.name}`,type:(m.kind||'MEDIA').toUpperCase(),size:m.blob?.size?`${Math.round(m.blob.size/1024)} KB`:'LOCAL',preview:m.kind==='audio'?`Audio ${Number(m.duration||0).toFixed(1)}s`:m.kind==='image'?'Captured image':'Local media'}))];}
  toggleTransferWireless(){const t=this.state.transfer;if(t.wireless==='ON'){this.transport.disconnect();t.wireless='OFF';t.transferState='IDLE';}else{t.wireless='ON';t.transferState=this.state.lilmidi.bridgeUrl&&this.transport.connect(this.state.lilmidi.bridgeUrl)?'CONNECTING':'NO HOST URL';}this.renderAndSave();}
  exportState(){this.downloadBlob(new Blob([JSON.stringify(serializePersistentState(this.state),null,2)],{type:'application/json'}),'lilled-r1-state.json');this.flashStatus('STATE EXPORT REQUESTED');}
  downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

  addCommChar(){const c=this.state.communications;if(c.draft.length<200)c.draft+=COMM_CHARS[c.charIndex%COMM_CHARS.length];this.renderAndSave();}
  applyQuickMessage(){const q=['YES','NO','ON MY WAY','NEED HELP'],c=this.state.communications;c.decisionIndex=wrap(c.decisionIndex+1,q.length);c.draft=q[c.decisionIndex];c.section='review';this.renderAndSave();}
  saveLocalMessage(){const c=this.state.communications;if(!c.draft.trim()){this.flashStatus('DRAFT IS EMPTY');return;}c.journal.push({id:`m-${Date.now()}`,from:'LOCAL',text:c.draft.trim(),time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),receipt:'LOCAL'});c.draft='';c.section='journal';c.receipt='LOCAL';this.renderAndSave();}
  sendRabbitPing(){try{this.platform.sendMessage('Return only valid JSON: {"ack":"lilLED R1 bridge ok"}',{useLLM:true,wantsR1Response:false,wantsJournalEntry:false});Object.assign(this.state.communications,{bridge:'WAIT',lastBridge:'Ping sent…',receipt:'UNKNOWN'});this.render();}catch(e){Object.assign(this.state.communications,{bridge:'OFF',lastBridge:e.message,receipt:'FAILED'});this.render();}}
  onPluginMessage(data){const candidate=data?.data||data?.message||'Message received';let text=candidate;if(typeof candidate==='string'){try{const p=JSON.parse(candidate);text=p.ack||p.message||candidate;}catch{}}Object.assign(this.state.communications,{bridge:'OK',lastBridge:String(text).slice(0,80),receipt:'ACKNOWLEDGED'});if(currentApp(this.state).id==='communications')this.render();}
  onTransportEvent(event){const status=event.status||this.transport.status;this.state.lilmidi.bridge=status;if(this.state.transfer.wireless==='ON')this.state.transfer.transferState=status;if(currentApp(this.state).id==='lilmidi'||currentApp(this.state).id==='transfer')this.render();}

  toggleWhoFi(){const w=this.state.whofi;if(w.running){w.running=false;w.connecting=false;w.csiRate=0;if(w.rawStream){this.flashStatus('END STREAM BEFORE STOP');w.running=true;return;}}else{w.connecting=true;setTimeout(()=>{w.connecting=false;w.running=true;w.csiRate=24;if(currentApp(this.state).id==='whofi')this.render();},350);}this.renderAndSave();}
  toggleWhoFiRaw(){const w=this.state.whofi;if(!w.running){this.flashStatus('START CSI FIRST');return;}w.rawStream=!w.rawStream;this.renderAndSave();}
  cycleWhoFiPlot(){const v=['WATERFALL','BINS','CHANGE'],w=this.state.whofi;w.plot=v[wrap(v.indexOf(w.plot)+1,v.length)];this.renderAndSave();}
  advanceWhoFi(){const w=this.state.whofi;w.phase+=.12;w.rssi=Math.round(-62+Math.sin(w.phase*.7)*6);w.csiRate=Math.round(22+Math.sin(w.phase)*5);if(Math.random()<.01)w.drops+=1;if(!w.frozen){w.history.push({t:Date.now(),v:(Math.sin(w.phase)+Math.sin(w.phase*.31)+2)/4,rssi:w.rssi});if(w.history.length>120)w.history.shift();}if(w.rawStream)w.records+=1;}

  setMidiPad(event,el){const r=el.getBoundingClientRect(),x=clamp((event.clientX-r.left)/r.width,0,1),y=1-clamp((event.clientY-r.top)/r.height,0,1),m=this.state.lilmidi;m.padX=x;m.padY=y;m.valueX=Math.round(x*127);m.valueY=Math.round(y*127);const payload={type:'midi-control',channel:m.channel,x:{map:m.mapX,value:m.valueX},y:{map:m.mapY,value:m.valueY},scene:m.scene};if(this.transport.status==='ONLINE')this.transport.send(payload);this.render();}
  adjustMidiFocus(d){const m=this.state.lilmidi;if(m.focus==='CHANNEL')m.channel=clamp(m.channel+d,1,16);else if(m.focus==='MAPX'){const v=['CC74','CC71','PITCH','VELOCITY'];m.mapX=v[wrap(v.indexOf(m.mapX)+d,v.length)];}else if(m.focus==='MAPY'){const v=['CC71','CC74','PITCH','MOD'];m.mapY=v[wrap(v.indexOf(m.mapY)+d,v.length)];}else if(m.focus==='GROUP'){const v=['A','B','C','D'];m.group=v[wrap(v.indexOf(m.group)+d,v.length)];}else if(m.focus==='ROUTE'){const v=['HOST','LOCAL','GROUP'];m.route=v[wrap(v.indexOf(m.route)+d,v.length)];}else if(m.focus==='SCENE')m.scene=m.scenes[wrap(m.scenes.indexOf(m.scene)+d,m.scenes.length)];m.draftDirty=true;}
  applyMidiDraft(){const m=this.state.lilmidi;m.revision+=1;m.ackRevision=this.transport.status==='ONLINE'?m.revision:m.ackRevision;m.draftDirty=false;m.page='perform';this.flashStatus(this.transport.status==='ONLINE'?'APPLIED / HOST ACK PATH':'APPLIED LOCALLY / NO HOST ACK');this.scheduleSave();}
  discardMidiDraft(){this.state.lilmidi.draftDirty=false;this.state.lilmidi.page='perform';this.renderAndSave();}

  seedParticles(keep=false){const count=this.state.particles.count;if(!keep)this.particles=[];while(this.particles.length<count)this.particles.push({x:Math.random()*220,y:Math.random()*135,vx:(Math.random()-.5)*1.3,vy:(Math.random()-.5)*1.3,trail:[]});if(this.particles.length>count)this.particles.length=count;}
  setParticleTarget(event,el){const r=el.getBoundingClientRect();this.particleTarget.x=clamp(event.clientX-r.left,0,r.width);this.particleTarget.y=clamp(event.clientY-r.top,0,r.height);this.state.particles.padX=this.particleTarget.x/r.width;this.state.particles.padY=this.particleTarget.y/r.height;}
  adjustParticleFocus(d){const p=this.state.particles;if(p.focus==='ATTRACTION')p.attraction=clamp(p.attraction+d*.02,0,.8);else if(p.focus==='ORBIT')p.orbitRadius=clamp(p.orbitRadius+d*4,10,100);else if(p.focus==='GRAVITY')p.gravity=clamp(p.gravity+d*.02,-.4,.6);else if(p.focus==='COUNT'){p.count=clamp(p.count+d*6,12,120);this.seedParticles(true);}}
  cycleParticlePreset(){const p=this.state.particles;p.preset=PARTICLE_PRESETS[wrap(PARTICLE_PRESETS.indexOf(p.preset)+1,PARTICLE_PRESETS.length)];if(p.preset==='ORBIT')Object.assign(p,{gravity:.02,attraction:.20,orbitRadius:42,orbitalDrive:.35,damping:.994});if(p.preset==='CLOUD')Object.assign(p,{gravity:0,attraction:.04,orbitRadius:70,orbitalDrive:.08,damping:.998});if(p.preset==='GRAVITY')Object.assign(p,{gravity:.24,attraction:.02,orbitRadius:25,orbitalDrive:.05,damping:.992});if(p.preset==='FIREFLIES')Object.assign(p,{gravity:-.02,attraction:.10,orbitRadius:55,orbitalDrive:.22,damping:.996});this.seedParticles(false);this.renderAndSave();}
  advanceParticles(dt){const pstate=this.state.particles;if(pstate.paused)return;this.seedParticles(true);for(let i=0;i<this.particles.length;i++){const p=this.particles[i],dx=this.particleTarget.x-p.x,dy=this.particleTarget.y-p.y,d=Math.max(10,Math.hypot(dx,dy)),nx=dx/d,ny=dy/d,tangentX=-ny,tangentY=nx,orbitError=(d-pstate.orbitRadius)/Math.max(10,pstate.orbitRadius);p.vx+=(nx*pstate.attraction*orbitError+tangentX*pstate.orbitalDrive+pstate.gravity*.04)*dt*24;p.vy+=(ny*pstate.attraction*orbitError+tangentY*pstate.orbitalDrive+pstate.gravity)*dt*24;p.vx*=pstate.damping;p.vy*=pstate.damping;p.trail.push([p.x,p.y]);if(p.trail.length>pstate.trailLength)p.trail.shift();p.x+=p.vx*dt*45;p.y+=p.vy*dt*45;if(p.x<0||p.x>220){p.vx*=-pstate.rebound;p.x=clamp(p.x,0,220);}if(p.y<0||p.y>135){p.vy*=-pstate.rebound;p.y=clamp(p.y,0,135);}}}

  async readBattery(show=false){if(!navigator.getBattery){this.state.power.supported=false;if(show)this.flashStatus('BATTERY API UNAVAILABLE');this.render();return;}try{const b=await navigator.getBattery();Object.assign(this.state.power,{supported:true,level:b.level,charging:b.charging,chargingTime:b.chargingTime,dischargingTime:b.dischargingTime});this.state.power.history.push([Date.now(),b.level]);this.state.power.history=this.state.power.history.slice(-40);if(show)this.flashStatus('BATTERY REFRESHED');this.renderAndSave();}catch(e){this.state.power.supported=false;if(show)this.flashStatus(e.message);this.render();}}

  async toggleCamera(){if(this.state.camera.state==='live'){this.stopCamera();return;}if(this.state.camera.dirty){this.flashStatus('SAVE CAPTURE BEFORE RESTART');return;}try{this.cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:this.state.camera.facing},audio:false});this.state.camera.state='live';this.state.camera.error='';this.render();}catch(e){this.state.camera.state='error';this.state.camera.error=e.name||'CAMERA ERROR';this.flashStatus(this.state.camera.error);}}
  attachCameraVideo(){const v=document.getElementById('cameraVideo');if(v&&this.cameraStream&&v.srcObject!==this.cameraStream)v.srcObject=this.cameraStream;}
  stopCamera(rerender=true){this.cameraStream?.getTracks().forEach(t=>t.stop());this.cameraStream=null;this.state.camera.state='idle';if(rerender)this.render();}
  flipCamera(){if(this.state.camera.dirty){this.flashStatus('SAVE CAPTURE FIRST');return;}this.state.camera.facing=this.state.camera.facing==='environment'?'user':'environment';if(this.state.camera.state==='live'){this.stopCamera(false);this.toggleCamera();}else this.renderAndSave();}
  captureCameraFrame(){const v=document.getElementById('cameraVideo');if(!v||!v.videoWidth){this.flashStatus('NO FRAME YET');return;}const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);c.toBlob(blob=>{this.cameraPendingBlob=blob;this.state.camera.shots+=1;this.state.camera.dirty=Boolean(blob);this.flashStatus(`SNAP ${this.state.camera.shots} READY TO SAVE`);},'image/jpeg',.88);}
  async saveCameraFrame(){if(!this.cameraPendingBlob){this.flashStatus('NO CAPTURE');return;}const item=await this.media.put({kind:'image',name:`Camera-${Date.now()}.jpg`,mime:'image/jpeg',blob:this.cameraPendingBlob});this.state.camera.savedId=item.id;this.state.camera.dirty=false;this.cameraPendingBlob=null;await this.refreshMediaFiles();this.flashStatus('IMAGE SAVED LOCALLY');this.scheduleSave();}

  tick() {
    const now=performance.now(),dt=Math.min(.25,(now-this.lastTick)/1000),id=currentApp(this.state).id;this.lastTick=now;
    if(this.state.aem.degas&&Date.now()>this.state.aem.degasUntil){this.state.aem.degas=false;this.state.aem.degasUntil=0;if(id==='aem')this.render();}
    if(this.state.recorder.state==='recording'){this.state.recorder.seconds=(now-this.recordingStartedAt)/1000;if(id==='recorder'&&!this.state.drawerOpen)this.render();}
    if(this.state.notebook.timerRunning){this.state.notebook.timerRemaining=Math.max(0,this.state.notebook.timerRemaining-dt);if(this.state.notebook.timerRemaining<=0){this.state.notebook.timerRunning=false;this.flashStatus('TIMER COMPLETE');}}
    if(this.state.notebook.stopwatchRunning)this.state.notebook.stopwatchMs+=dt*1000;
    if(this.state.drawerOpen)return;
    if(id==='rain'&&this.state.rain.running)this.advanceRain(dt);
    if(id==='udaq')this.advanceUdaq(now);
    if(id==='whofi'&&this.state.whofi.running)this.advanceWhoFi();
    if(id==='particles')this.advanceParticles(dt);
    if(id==='power'&&Date.now()-this.lastPowerRead>10000){this.lastPowerRead=Date.now();this.readBattery(false);}
    if(id==='notebook'&&this.state.notebook.page!=='home')this.render();
    this.drawCurrent();
  }

  advanceRain(dt){if(this.state.settings.reducedMotion)return;const r=this.state.rain,wind=r.windMode==='IMU'?r.effectiveWind:r.manualWind,fall=r.windMode==='IMU'?r.effectiveFallSpeed:r.fallSpeed;for(const d of this.rainDrops){d.y+=d.speed*fall*dt*.12;d.x+=wind*dt*.09;if(d.x<0)d.x+=220;if(d.x>220)d.x-=220;if(d.y>119){d.y=-4;d.x=(d.x*1.37+31)%220;if(d.x>90&&d.x<90+r.targetWidth)r.hits+=1;else r.misses+=1;}}r.activeDrops=Math.min(144,Math.round(144*r.spawnRate/90));r.predicted=Math.round(r.activeDrops*(r.predictor==='LEGACY ENDPOINT'?.36:r.predictor==='SPAWN SWEPT'?.52:.58));}

  drawCurrent(){if(this.state.drawerOpen)return;const id=currentApp(this.state).id;if(id==='rain')this.drawRain();else if(id==='hsv')this.drawHsvCone();else if(id==='udaq')this.drawUdaq();else if(id==='whofi'&&id&&this.state.whofi.page==='view')this.drawWhoFi();else if(id==='particles')this.drawParticles();else if(id==='power')this.drawPower();}
  drawRain(){const c=document.getElementById('rainCanvas');if(!c)return;const x=c.getContext('2d');x.fillStyle='#03101a';x.fillRect(0,0,220,119);x.strokeStyle='#1b3441';for(let y=20;y<119;y+=20){x.beginPath();x.moveTo(0,y);x.lineTo(220,y);x.stroke();}const count=Math.min(this.state.rain.activeDrops,this.rainDrops.length);for(let i=0;i<count;i++){const d=this.rainDrops[i];x.strokeStyle=i%4===0?'#56dc91':'#41b5f2';x.beginPath();x.moveTo(d.x,d.y);x.lineTo(d.x-this.state.rain.effectiveWind*.015,d.y+7);x.stroke();}const w=this.state.rain.targetWidth;x.fillStyle='#f1f5f8';x.fillRect(90,91,w,24);x.fillStyle='#020b12';x.fillRect(94,91,Math.max(4,w-8),4);}
  drawHsvCone(){const c=document.getElementById('hsvCone');if(!c)return;const x=c.getContext('2d'),w=c.width,h=c.height,H=this.state.hsv;x.fillStyle='#061018';x.fillRect(0,0,w,h);for(let row=0;row<86;row++){const yy=18+row,half=44*(1-row/92);if(half<=0)continue;for(let col=-half;col<=half;col+=2){const hue=wrap(H.spin+H.cameraYaw+(col/half)*120+row*1.8,360);x.fillStyle=`hsl(${hue},85%,${48+row*.18}%)`;x.fillRect(w/2+col,yy,3,2);}}x.strokeStyle='#e9f3f6';x.beginPath();x.moveTo(9,16);x.lineTo(w/2,122);x.lineTo(w-9,16);x.closePath();x.stroke();const tilt=H.tilt*Math.PI/180,ry=clamp(12*Math.cos(tilt),2,12),rot=(H.spin+H.cameraYaw)*Math.PI/180;x.save();x.translate(w/2,54+H.offset*25);x.rotate(rot);x.scale(1,Math.sign(ry)||1);x.strokeStyle='#b180ef';x.beginPath();x.ellipse(0,0,39,Math.abs(ry),0,0,Math.PI*2);x.stroke();x.restore();}
  drawUdaq(){const c=document.getElementById('daqCanvas');if(!c)return;const x=c.getContext('2d'),w=220,h=112,u=this.state.udaq;x.fillStyle='#041019';x.fillRect(0,0,w,h);x.strokeStyle='#1c3343';for(let y=19;y<h;y+=19){x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke();}const defs=[['#43d7e5','x'],['#b180ef','y'],['#f7c148','z'],['#56dc91','m']];let channels=defs;if(['AX','AY','AZ','|A|'].includes(u.view)){const map={AX:'x',AY:'y',AZ:'z','|A|':'m'};channels=defs.filter(d=>d[1]===map[u.view]);}else if(u.view==='XY|A|')channels=defs.filter(d=>['x','y','m'].includes(d[1]));else if(u.view==='XZ|A|')channels=defs.filter(d=>['x','z','m'].includes(d[1]));else if(u.view==='YZ|A|')channels=defs.filter(d=>['y','z','m'].includes(d[1]));const hist=u.history.slice(-220);for(const [color,key] of channels){x.strokeStyle=color;x.beginPath();hist.forEach((s,i)=>{const px=hist.length>1?i*(w/(hist.length-1)):0,v=key==='m'?s[key]-1:s[key],py=h/2-v*42;if(i===0)x.moveTo(px,py);else x.lineTo(px,py);});x.stroke();}}
  drawWhoFi(){const c=document.getElementById('whofiCanvas');if(!c)return;const x=c.getContext('2d'),w=220,h=117,W=this.state.whofi,hist=W.history.slice(-100);x.fillStyle='#041019';x.fillRect(0,0,w,h);if(W.plot==='WATERFALL'){hist.forEach((s,i)=>{const v=s.v,xx=i*(w/Math.max(1,hist.length));x.fillStyle=`hsl(${190+v*95},85%,${32+v*34}%)`;x.fillRect(xx,h-v*h,Math.max(2,w/Math.max(1,hist.length)),v*h);});}else if(W.plot==='BINS'){for(let i=0;i<44;i++){const v=(Math.sin(i*.61+W.phase)+Math.sin(i*.17-W.phase*.6)+2)/4,hh=10+v*88;x.fillStyle=`hsl(${190+v*95},85%,${32+v*34}%)`;x.fillRect(i*5,h-hh,4,hh);}}else{x.strokeStyle='#f59e37';x.beginPath();hist.forEach((s,i)=>{const px=i*(w/Math.max(1,hist.length-1)),py=h-(s.v*h);if(i===0)x.moveTo(px,py);else x.lineTo(px,py);});x.stroke();}x.fillStyle='#f59e37';x.font='8px monospace';x.fillText(`${W.provider} / ${W.frozen?'FROZEN':'LIVE'}`,6,11);}
  drawParticles(){const c=document.getElementById('particlesCanvas');if(!c)return;const x=c.getContext('2d'),pstate=this.state.particles;x.fillStyle='rgba(4,16,25,.52)';x.fillRect(0,0,220,135);if(pstate.grid){x.strokeStyle='#17303d';for(let gx=22;gx<220;gx+=22){x.beginPath();x.moveTo(gx,0);x.lineTo(gx,135);x.stroke();}for(let gy=22;gy<135;gy+=22){x.beginPath();x.moveTo(0,gy);x.lineTo(220,gy);x.stroke();}}for(const p of this.particles){if(pstate.trailLength>0&&p.trail.length>1){x.strokeStyle='#2a7582';x.beginPath();p.trail.forEach(([tx,ty],i)=>i?x.lineTo(tx,ty):x.moveTo(tx,ty));x.stroke();}x.fillStyle='#43d7e5';x.beginPath();x.arc(p.x,p.y,pstate.particleRadius,0,Math.PI*2);x.fill();}if(pstate.showTarget){x.strokeStyle='#b180ef';x.beginPath();x.arc(this.particleTarget.x,this.particleTarget.y,9,0,Math.PI*2);x.stroke();x.beginPath();x.arc(this.particleTarget.x,this.particleTarget.y,pstate.orbitRadius,0,Math.PI*2);x.stroke();}}
  drawPower(){const c=document.getElementById('powerCanvas');if(!c)return;const x=c.getContext('2d'),h=60,hist=this.state.power.history;x.fillStyle='#041019';x.fillRect(0,0,220,h);if(hist.length<2)return;x.strokeStyle='#56dc91';x.beginPath();hist.forEach(([_,level],i)=>{const px=i*(220/(hist.length-1)),py=h-level*h;i?x.lineTo(px,py):x.moveTo(px,py);});x.stroke();}
}

const root=document.getElementById('app');
const app=new LilLedR1App(root);
app.start().catch(error=>{root.innerHTML=`<div style="padding:12px;color:#ef5b5b;font:11px monospace">STARTUP ERROR<br>${String(error.message||error)}</div>`;console.error(error);});
window.__lilledR1=app;
