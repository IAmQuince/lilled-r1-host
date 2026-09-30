import { AudioEngine } from './audio/audio-engine.js';
import { R1Platform } from './platform/r1-platform.js';
import { APP_DEFS, CORE_APP_COUNT, PERCUSSION_VOICES, percussionPatternFor } from './core/reference-catalog.js';
import { clamp, currentApp, createDefaultState, nextApp, normalizeState, serializePersistentState, wrap } from './core/state.js';
import { render } from './ui/render.js';
import { SensorHub } from './services/sensor-hub.js';
import { InteractionRouter } from './services/interaction-router.js';
import { NavigationGuard } from './services/navigation-guard.js';
import { InputFocus } from './services/input-focus.js';
import { PatternService, appendPatternNode, samePattern, validPattern } from './services/pattern-service.js';
import { MediaRepository } from './services/storage/media-repository.js';
import { TransportManager } from './services/transport-manager.js';
import { drawUdaqPlot } from './apps/udaq/view.js';
import { RainModel, RainPrediction } from './apps/rain/model.js';
import { calculateAemMetrics } from './apps/aem/model.js';
import { HsvModel, hsvToRgb } from './apps/hsv/model.js';
import { factoryPatch, resolveSynthParams, midiToFrequency, SYNTH_PRESETS } from './apps/synth/model.js';
import { variationFromRetouch } from './apps/percussion/model.js';
import { NativeShell } from './ui/native-shell.js';
import { startPcmRecording, waveformPeaks } from './audio/wav.js';
import { recorderPrimaryIntent, recorderReadyState } from './apps/recorder/model.js';
import { virtualFiles, virtualFileText } from './apps/files/model.js';
import { encodeText as encodeQrText } from './services/qr.js';
import { QUICK_TREE, QUICK_PARENTS, chooseQuick, wheelCharacter, rotateCharacter, nextCharacterMode, appendMessageCharacter } from './apps/messages/model.js';

const STORAGE_KEY = 'lilled_r1_state_v4';
const LEGACY_STORAGE_KEY = 'lilled_r1_state_v3';
const UDAQ_VIEWS = ['XYZ','ALL','AX','AY','AZ','|A|','XY|A|','XZ|A|','YZ|A|'];
const MOTION_APPS = new Set(['rain','hsv','aem','synth','percussion','udaq','settings']);
const HSV_PRESETS = ['OBLIQUE','CIRCLE','FAN','PARABOLA'];
const SYNTH_MAPS = ['PITCH','DELAY','REVERB','CUTOFF','RESONANCE'];
const PARTICLE_PRESETS = ['ORBIT','CLOUD','GRAVITY','FIREFLIES'];

class LilLedR1App {
  constructor(root) {
    this.root = root;
    this.nativeShell = new NativeShell(document.getElementById('nativeScreen'),this);
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
    this.rainModel = new RainModel();
    this.rainMotionTime = -Infinity;
    this.hsvModel = new HsvModel();
    this.hsvSamplePoint={x:.5,y:.5};
    this.synthGeneration=0;
    this.synthTrail=[];this.synthRings=[];
    this.recording = null;
    this.recordingChunks = [];
    this.recordingBlob = null;
    this.recordingUrl = null;
    this.recordingAudio = null;
    this.recordingLoadPending = false;
    this.recordingStartedAt = 0;
    this.filePreview=null;this.filePreviewUrl=null;this.fileQr=null;this.fileDeleteConfirm=false;this.fileScroll=0;this.fileImage=null;this.fileAudio=null;
    this.journalAudio=null;this.journalAudioUrl=null;
    this.cameraStream = null;
    this.cameraPendingBlob = null;
    this.particles = [];
    this.particleTarget = { x:110, y:68 };
    this.lastTick = performance.now();
    this.lastAppId = null;
    this.lastPowerRead = 0;
    this.lastWhoFiFrame = 0;
    this.renderPending = false;
  }

  async start() {
    const current=await this.platform.loadJson(STORAGE_KEY);
    const legacy=current?null:await this.platform.loadJson(LEGACY_STORAGE_KEY);
    const stored=current||legacy;
    this.state = normalizeState(stored);
    this.syncRainControls();
    this.syncHsvModelFromState();
    this.recomputeAem(false);
    this.patternService = new PatternService(this.platform);
    try{await this.patternService.load();}
    catch(error){this.state.settings.patternError='CREDENTIAL STORAGE UNAVAILABLE';console.error('pattern storage',error);}
    this.syncPatternStatus();
    if(legacy){await this.platform.saveJson(STORAGE_KEY,serializePersistentState(this.state));await this.platform.deleteJson(LEGACY_STORAGE_KEY);}
    else if(current)await this.platform.deleteJson(LEGACY_STORAGE_KEY);
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
    this.platform.on('sideClick', () => this.primaryAction(false));
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
    document.getElementById('r1MessageKeyboard')?.addEventListener('input',e=>this.onInput(e));
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
    if(event.target.id==='r1MessageKeyboard'){this.state.communications.draft=String(event.target.value).slice(0,200);this.scheduleSave();this.nativeShell.draw();return;}
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
      case 'rain-predictor':this.state.rain.predictor=this.state.rain.predictor==='LIVE SWEPT'?'LEGACY':'LIVE SWEPT';this.syncRainControls();this.renderAndSave();break;
      case 'rain-reset':this.rainModel.resetRun();this.syncRainSnapshot();this.renderAndSave();break;
      case 'hsv-imu':this.state.hsv.imuPlane=!this.state.hsv.imuPlane;if(!this.state.hsv.imuPlane)this.hsvModel.setPlane(this.state.hsv.manualTilt,this.state.hsv.manualSpin,this.state.hsv.offset);this.syncHsvState();this.renderAndSave();break;
      case 'hsv-preset':this.cycleHsvPreset();break;case 'hsv-undo':this.hsvModel.undo();this.syncHsvState();this.renderAndSave();break;case 'hsv-clear':this.hsvModel.clear();this.syncHsvState();this.renderAndSave();break;
      case 'aem-driver':this.state.aem.driver=this.state.aem.driver==='CURRENT'?'VOLTAGE':'CURRENT';this.recomputeAem();this.renderAndSave();break;case 'aem-imu':this.state.aem.imuControl=!this.state.aem.imuControl;this.renderAndSave();break;case 'aem-degas':this.toggleDegas();break;
      case 'aem-preset':{const a=this.state.aem;a.modelPreset=a.modelPreset==='BENCH'?'STARVED':'BENCH';a.waterPacketsPerSecond=a.modelPreset==='BENCH'?32:4;a.membraneCapacityPackets=a.modelPreset==='BENCH'?36:12;a.effectiveWaterPacketsPerSecond=a.waterPacketsPerSecond;this.recomputeAem();this.renderAndSave();break;}
      case 'synth-perform':this.state.synth.page='perform';this.renderAndSave();break;case 'synth-map':this.state.synth.page='map';this.renderAndSave();break;case 'synth-sound':this.state.synth.page='sound';this.renderAndSave();break;case 'synth-imu':this.state.synth.imuMotion=!this.state.synth.imuMotion;this.renderAndSave();break;case 'synth-wave':this.cycleSynthWaveform();break;case 'synth-mute':this.state.synth.muted=!this.state.synth.muted;this.renderAndSave();break;
      case 'synth-latch':this.toggleSynthLatch();break;case 'synth-preset':this.cycleSynthPreset();break;
      case 'synth-save-user':this.saveSynthUserPatch();break;case 'synth-load-user':this.loadSynthUserPatch();break;
      case 'perc-view':this.state.percussion.page=this.state.percussion.page==='xy'?'pattern':'xy';this.renderAndSave();break;case 'perc-motion':this.state.percussion.motionFx=!this.state.percussion.motionFx;this.renderAndSave();break;case 'perc-kit':this.cyclePercKit();break;
      case 'perc-toggle':this.togglePercussion();break;
      case 'record':this.recordPrimary();break;case 'record-replay':this.playRecording();break;case 'record-save':this.saveRecording();break;case 'record-discard':this.discardRecording();break;case 'record-back':this.seekRecording(-5);break;case 'record-forward':this.seekRecording(5);break;case 'record-share':this.shareRecording();break;
      case 'record-done':this.doneRecording();break;
      case 'udaq-rate':this.cycleUdaqRate();break;case 'udaq-run':this.state.udaq.running=!this.state.udaq.running;this.renderAndSave();break;case 'udaq-source':this.state.udaq.inputSource=this.state.udaq.inputSource==='DEMO'?'AUTO':'DEMO';this.state.udaq.history=[];this.state.udaq.lastSequence=0;this.state.udaq.source=this.state.udaq.inputSource==='DEMO'?'DEMO':'WAIT';this.state.udaq.sourceAvailable=this.state.udaq.inputSource==='DEMO';this.state.udaq.sourceFresh=false;Object.assign(this.state.udaq,{x:0,y:0,z:0,magnitude:0});this.renderAndSave();break;case 'udaq-clear':this.state.udaq.history=[];this.render();break;case 'udaq-zero':this.centerMotion();break;case 'udaq-export':this.exportUdaqCsv();break;
      case 'settings-center':this.centerMotion();break;case 'settings-pattern-reset':this.resetSharedPattern();break;case 'settings-intro':this.state.settings.firstRunComplete=false;this.state.settings.introSeen=false;this.state.settings.introStep=0;this.renderAndSave();break;
      case 'pattern-start':this.beginPatternSetup();break;case 'pattern-cancel':this.cancelPatternSetup();break;
      case 'pattern-reset-start':this.state.settings.patternMode='reset-confirm';this.render();break;
      case 'pattern-reset-confirm':this.resetForgottenPattern();break;
      case 'intro-next':this.advanceIntroduction();break;case 'intro-pattern':this.beginPatternSetup();break;case 'intro-done':this.completeIntroduction();break;
      case 'transfer-home':this.state.transfer.browserPage='home';this.renderAndSave();break;case 'transfer-browser':this.state.transfer.browserPage='browser';this.refreshMediaFiles().then(()=>this.renderAndSave());break;case 'transfer-preview':this.openSelectedFile();break;case 'transfer-wireless':this.state.transfer.browserPage='wireless';this.renderAndSave();break;case 'transfer-toggle-wireless':this.toggleTransferWireless();break;case 'transfer-lock':this.lockArea('transfer');break;case 'transfer-export':this.exportSelectedFile();break;
      case 'transfer-open':this.openSelectedFile();break;case 'transfer-back':this.closeFilePreview();break;
      case 'transfer-delete':this.requestFileDelete();break;case 'transfer-delete-confirm':this.deleteSelectedFile();break;
      case 'transfer-qr':this.showSelectedFileQr();break;case 'transfer-export-state':this.exportState();break;
      case 'comm-home':this.state.communications.section='home';this.renderAndSave();break;case 'comm-compose':this.state.communications.section='compose';this.renderAndSave();break;case 'comm-journal':this.state.communications.section='journal';this.renderAndSave();break;case 'comm-review':this.state.communications.section='review';this.renderAndSave();break;case 'comm-quick':this.state.communications.quickNode='root';this.state.communications.section='quick';this.renderAndSave();break;case 'comm-voice':this.openApp(APP_DEFS.findIndex(app=>app.id==='recorder'));this.flashStatus('RECORD <=15S, SAVE, THEN SHARE');break;case 'comm-lock':this.lockArea('communications');break;case 'comm-char-back':this.state.communications.draft=this.state.communications.draft.slice(0,-1);this.renderAndSave();break;case 'comm-char-add':this.addCommChar();break;case 'comm-char-space':this.state.communications.draft=appendMessageCharacter(this.state.communications.draft,' ');this.renderAndSave();break;case 'comm-char-mode':this.state.communications.charMode=nextCharacterMode(this.state.communications.charMode);this.state.communications.charIndex=0;this.renderAndSave();break;case 'comm-keyboard':{const input=document.getElementById('r1MessageKeyboard');if(input){input.value=this.state.communications.draft;input.focus();}break;}case 'comm-save-local':this.saveLocalMessage();break;case 'comm-send-rabbit':this.sendRabbitJournal();break;case 'comm-dictate':this.toggleDictation();break;case 'comm-delete':this.state.communications.deleteConfirm=true;this.render();break;case 'comm-delete-confirm':this.deleteJournalMessage();break;case 'comm-clear':this.state.communications.clearConfirm=true;this.render();break;case 'comm-clear-confirm':this.state.communications.journal=[];this.state.communications.clearConfirm=false;this.renderAndSave();break;
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
    const pattern=event.target.closest('.pattern-grid');if(pattern){if(this.startPatternGesture(event,pattern))this.interactions.claim(event,`pattern:${pattern.dataset.patternApp}`,pattern);return;}
    const synth=event.target.closest('#synthPad');if(synth){this.interactions.claim(event,'synth',synth);this.setSynthPad(event,synth,true);return;}
    const perc=event.target.closest('#percussionPad');if(perc){this.interactions.claim(event,'percussion',perc);this.beginPercussionContact(event,perc);return;}
    const hsvSection=event.target.closest('#hsvPad');if(hsvSection){this.interactions.claim(event,'hsv-sample',hsvSection);this.setHsvSample(event,hsvSection);return;}
    const hsvCone=event.target.closest('#hsvCone');if(hsvCone){this.interactions.claim(event,'hsv-orbit',hsvCone);this.interactions.active.data={x:event.clientX,y:event.clientY,yaw:this.state.hsv.cameraYaw};return;}
    const aem=event.target.closest('#aemStack');if(aem){this.interactions.claim(event,'aem',aem);this.setAemFromPointer(event,aem);return;}
    const midi=event.target.closest('#midiPad');if(midi){this.interactions.claim(event,'midi',midi);this.setMidiPad(event,midi);return;}
    const particles=event.target.closest('#particlesCanvas');if(particles){this.interactions.claim(event,'particles',particles);this.setParticleTarget(event,particles);return;}
    const daq=event.target.closest('#daqCanvas');if(daq){this.interactions.claim(event,'udaq-cursor',daq);return;}
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
    if(this.patternGesture&&this.interactions.owns(event)){this.extendPatternGesture(event);this.finishPatternGesture();this.interactions.release(event);return;}
    const owner=this.interactions.owner();
    if(owner==='synth')this.stopSynth();
    if(owner==='percussion')this.finishPercussionContact();
    this.interactions.release(event);
    if(this.renderPending){this.renderPending=false;this.render();}
    if(!this.swipe||this.swipe.id!==event.pointerId)return;
    const dx=event.clientX-this.swipe.x,dy=event.clientY-this.swipe.y,dt=performance.now()-this.swipe.t;this.swipe=null;
    if(dt<650&&Math.abs(dx)>=48&&Math.abs(dx)>Math.abs(dy)*1.35)this.goNext(dx<0?1:-1);
  }

  onPointerCancel(event) {
    this.state.settings.touchDrop += 1;this.swipe=null;
    if(this.patternGesture&&this.interactions.owns(event))this.patternGesture=null;
    const owner=this.interactions.owner();if(owner==='synth')this.stopSynth();if(owner==='percussion')this.finishPercussionContact();this.interactions.cancel(event);
    if(this.renderPending){this.renderPending=false;this.render();}
  }

  render() {
    if(this.interactions.active){this.renderPending=true;this.drawCurrent();return;}
    this.configureFocus();
    this.refreshGuards();
    this.root.innerHTML=render(this.state,this.platform);
    this.nativeShell.sync();
    this.root.style.setProperty('--app-brightness',String((.55+(this.state.settings.brightness/255)*.70).toFixed(3)));
    this.afterRender();
  }

  async afterRender() {
    const id=currentApp(this.state).id;
    if(id!==this.lastAppId){const previous=this.lastAppId;this.leaveAppCleanup(previous);this.lastAppId=id;if(id==='power'&&!this.state.drawerOpen)this.readBattery();if(id==='transfer')this.refreshMediaFiles().then(()=>this.nativeShell.draw());}
    await this.updateMotionLifecycle();
    if(id==='camera'&&this.state.camera.state==='live')this.attachCameraVideo();
    if(id==='recorder'&&this.state.recorder.savedId&&!this.recordingUrl&&!this.recordingLoadPending)this.loadSavedRecording();
    this.drawCurrent();
  }

  async updateMotionLifecycle() {
    const id=currentApp(this.state).id,needed=this.state.settings.firstRunComplete&&!this.state.settings.patternMode&&MOTION_APPS.has(id);
    if(needed&&!this.motionUnsubscribe){this.motionUnsubscribe=this.sensorHub.subscribe('runtime',sample=>this.onMotion(sample));await this.sensorHub.ensureStarted();}
    if(!needed&&this.motionUnsubscribe){this.motionUnsubscribe();this.motionUnsubscribe=null;await this.sensorHub.stop();}
  }

  onMotion(sample) {
    if(!sample)return;const m=this.state.motion;
    Object.assign(m,{available:true,source:sample.source,fresh:sample.status.fresh,validGravity:sample.status.validGravity,ageMs:sample.status.ageMs,rawX:sample.raw.x,rawY:sample.raw.y,rawZ:sample.raw.z,x:sample.filtered.x,y:sample.filtered.y,z:sample.filtered.z,magnitude:sample.magnitudeG,pitch:sample.attitude.pitch,roll:sample.attitude.roll,jerk:sample.motion.jerk,shake:sample.motion.shake,sequence:sample.sequence,calibration:this.sensorHub.exportCalibration()});
    const valid=sample.status.fresh&&sample.status.validGravity;
    this.rainMotionTime=sample.timestamp;
    const h=this.state.hsv;if(h.imuPlane){
      h.imuStatus=valid&&sample.status.calibrated?'IMU PLANE':sample.status.fresh?'ZERO IMU':'IMU STALE';
      if(valid&&sample.status.calibrated){this.hsvModel.updateImu(sample.filtered);this.syncHsvState();}
    }else h.imuStatus='TOUCH';
    const a=this.state.aem;
    if(a.imuControl){
      a.imuStatus=valid?'IMU MODEL':sample.status.fresh?'MOVE SLOW':'IMU STALE';
      const tilt=g=>Math.abs(g)<=.14?0:Math.sign(g)*clamp((Math.abs(g)-.14)/(.75-.14),0,1)*.85;
      const pitch=tilt(Math.sin(sample.attitude.pitch*Math.PI/180)),roll=tilt(Math.sin(sample.attitude.roll*Math.PI/180));
      a.effectiveCurrentSetpoint=valid?clamp(a.currentSetpoint*(1+pitch),0,3.4825):a.currentSetpoint;
      a.effectiveWaterPacketsPerSecond=valid?clamp(a.waterPacketsPerSecond*(1+roll),0,80):a.waterPacketsPerSecond;
      if(sample.source==='ACCEL'&&sample.motion.shake&&!a.degas)this.startDegas(1000);
    }else{a.imuStatus='BASELINE';a.effectiveCurrentSetpoint=a.currentSetpoint;a.effectiveWaterPacketsPerSecond=a.waterPacketsPerSecond;}
    this.recomputeAem(false);
    const s=this.state.synth;if(s.imuMotion){s.imuStatus=valid?'MOTION MAP':sample.status.fresh?'MOVE SLOW':'IMU STALE';
      const scaled=value=>Math.abs(value)<=.08?0:Math.sign(value)*clamp((Math.abs(value)-.08)/(.75-.08),0,1);
      s.imuDelayMod=valid?scaled(sample.filtered.y):0;
      s.imuReverbMod=valid?scaled(sample.filtered.x):0;
      if(valid)this.audio.updatePadVoice(s.padX,s.padY,this.synthOptions());
    }else{s.imuStatus='MOTION OFF';s.imuDelayMod=0;s.imuReverbMod=0;}
    const p=this.state.percussion;if(p.motionFx){p.imuStatus=valid?'MOTION FX':sample.status.fresh?'MOVE SLOW':'IMU STALE';if(valid){p.delay=clamp(Math.max(0,sample.attitude.roll)/90*.35,0,.4);p.reverb=clamp(.12+Math.max(0,-sample.attitude.roll)/90*.35,.05,.5);}}else p.imuStatus='FX OFF';
    if(this.state.udaq.inputSource!=='DEMO')Object.assign(this.state.udaq,{source:sample.source,sourceAvailable:true,sourceFresh:sample.status.fresh,x:sample.filtered.x,y:sample.filtered.y,z:sample.filtered.z,magnitude:sample.magnitudeG,pitch:sample.attitude.pitch,roll:sample.attitude.roll,jerk:sample.motion.jerk});
    this.refreshLiveReadouts();
  }

  refreshLiveReadouts(){
    if(this.state.drawerOpen)return;
    const id=currentApp(this.state).id;
    if(id==='udaq'){
      const u=this.state.udaq,labels=this.root.querySelectorAll('.daq-meta span');
      for(const [i,value] of [u.x,u.y,u.z,u.magnitude].entries())if(labels[i])labels[i].textContent=`${['AX','AY','AZ','|A|'][i]} ${u.sourceAvailable?value.toFixed(2):'—'}`;
      const source=this.root.querySelector('.udaq-content .screen-subhead b');
      if(source)source.textContent=`${u.sourceFresh?'LIVE':u.sourceAvailable?'STALE':'WAIT'} ${u.source}`;
      const footer=this.root.querySelectorAll('.udaq-content .daq-footer span');
      if(footer[0])footer[0].textContent=u.running?'RUN':'PAUSE';
      if(footer[1])footer[1].textContent=`${u.sampleRate} Hz`;
      if(footer[2])footer[2].textContent=`${u.history.length}/300`;
    }
    if(id==='settings'&&this.state.settings.page===2){
      const m=this.state.motion,labels=this.root.querySelectorAll('.motion-table b');
      const values=[`${m.rawX.toFixed(2)} ${m.rawY.toFixed(2)} ${m.rawZ.toFixed(2)}`,`${m.x.toFixed(2)} ${m.y.toFixed(2)} ${m.z.toFixed(2)}`,`${m.pitch.toFixed(1)}°`,`${m.roll.toFixed(1)}°`,`${m.magnitude.toFixed(2)} / ${m.jerk.toFixed(2)}`,m.fresh?(m.validGravity?'VALID':'MOVE SLOW'):'STALE'];
      values.forEach((value,i)=>{if(labels[i])labels[i].textContent=value;});
    }
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

  canNavigate() {if(!this.state.settings.firstRunComplete||this.state.settings.patternMode){this.flashStatus('FINISH SETUP FIRST',2400);return false;}this.refreshGuards();if(!this.navigationGuard.blocked())return true;this.flashStatus(this.navigationGuard.reason(),2400);return false;}
  renderAndSave(){this.render();this.scheduleSave();}
  scheduleSave(){clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.platform.saveJson(STORAGE_KEY,serializePersistentState(this.state)).catch(e=>console.error('save',e)),220);}
  flashStatus(message,ms=1500){this.state.statusMessage=String(message).slice(0,80);this.state.statusUntil=Date.now()+ms;this.render();}

  setDrawerScope(scope){this.state.drawerScope=scope;this.state.drawerIndex=scope==='core'?Math.min(this.state.appIndex,CORE_APP_COUNT-1):Math.max(CORE_APP_COUNT,this.state.appIndex);if(scope==='labs'&&this.state.drawerIndex<CORE_APP_COUNT)this.state.drawerIndex=CORE_APP_COUNT;this.render();}
  drawerIndices(){return this.state.drawerScope==='labs'?APP_DEFS.map((_,i)=>i).slice(CORE_APP_COUNT):APP_DEFS.map((_,i)=>i).slice(0,CORE_APP_COUNT);}
  openDrawer(){if(!this.canNavigate())return;this.nativeShell.sheet='';this.state.drawerOpen=true;this.state.drawerIndex=this.state.appIndex;this.state.drawerScope=this.state.appIndex>=CORE_APP_COUNT?'labs':'core';this.render();}
  openApp(index){if(!this.canNavigate())return;this.nativeShell.sheet='';this.nativeShell.sheetPage=0;this.state.appIndex=wrap(index,APP_DEFS.length);this.state.screenIndex=this.state.appIndex;this.state.drawerIndex=this.state.appIndex;this.state.drawerOpen=false;this.renderAndSave();}
  goNext(delta){if(!this.canNavigate())return;this.nativeShell.sheet='';this.nativeShell.sheetPage=0;this.state.drawerOpen=false;nextApp(this.state,delta);this.renderAndSave();}

  configureFocus() {
    if(this.state.drawerOpen){this.state.interaction.wheelLabel='APP SELECT';return;}
    const id=currentApp(this.state).id,s=this.state;
    const labels={rain:`${s.rain.focus} BASE`,hsv:`${s.hsv.focus}`,aem:`${s.aem.focus}`,synth:`${s.synth.focus}`,percussion:s.percussion.page==='xy'?`${s.percussion.focus}`:'BPM',udaq:`VIEW ${s.udaq.view}`,settings:`ROW ${s.settings.focus+1}`,transfer:'FILE SELECT',communications:s.communications.section==='compose'?'CHARACTER':'',whofi:'SPAN',lilmidi:`${s.lilmidi.focus}`,particles:`${s.particles.focus}`,notebook:s.notebook.page==='home'?'UTILITY':s.notebook.page==='timer'?'TIMER':s.notebook.page==='calendar'?'DATE':s.notebook.page==='ruler'?'RULER':''};
    this.state.interaction.wheelLabel=labels[id]||'';
  }
  setFocus(focus){const id=currentApp(this.state).id;if(this.state[id]&&'focus' in this.state[id])this.state[id].focus=focus;this.renderAndSave();}

  onWheel(direction) {
    if(!this.state.settings.firstRunComplete||this.state.settings.patternMode)return;
    if(this.nativeShell.onWheel(direction))return;
    if(this.state.drawerOpen){const indices=this.drawerIndices(),at=Math.max(0,indices.indexOf(this.state.drawerIndex));this.state.drawerIndex=indices[wrap(at+direction,indices.length)];this.render();return;}
    const id=currentApp(this.state).id,s=this.state;
    if(id==='rain'){const r=s.rain;if(r.focus==='WIND')r.manualWind=clamp(r.manualWind+direction*8,-140,140);else if(r.focus==='RATE')r.spawnRate=clamp(r.spawnRate+direction*2,0,90);else if(r.focus==='FALL')r.fallSpeed=clamp(r.fallSpeed+direction*8,112,336);else if(r.focus==='TARGET')r.targetSpeed=clamp(r.targetSpeed+direction*8,-166,166);if(r.windMode==='MANUAL')Object.assign(r,{effectiveWind:r.manualWind,effectiveFallSpeed:r.fallSpeed,effectiveTargetSpeed:r.targetSpeed});}
    else if(id==='hsv'){const h=s.hsv;if(h.focus==='OFFSET')h.offset=clamp(h.offset+direction*.01,-.85,.85);else if(h.focus==='TILT')h.manualTilt=clamp(h.manualTilt+direction*2,0,90);else if(h.focus==='SPIN')h.manualSpin=wrap(h.manualSpin+direction*5,360);if(!h.imuPlane)this.hsvModel.setPlane(h.manualTilt,h.manualSpin,h.offset);else if(h.focus==='OFFSET')this.hsvModel.setPlane(this.hsvModel.tilt,this.hsvModel.spin,h.offset);this.syncHsvState();}
    else if(id==='aem')this.adjustAemFocus(direction);
    else if(id==='synth')this.adjustSynthFocus(direction);
    else if(id==='percussion'){const p=s.percussion;if(p.page==='pattern')p.bpm=clamp(p.bpm+direction*2,40,240);else if(p.focus==='ENERGY'){p.energy=clamp(p.energy+direction,1,4);this.refreshPercussionPattern();}else if(p.focus==='GROOVE'){p.groove=clamp(p.groove+direction,1,4);this.refreshPercussionPattern();}else if(p.focus==='BPM')p.bpm=clamp(p.bpm+direction*2,40,240);this.audio.updateSequencer(p.pattern,p.bpm,p.volume/100);}
    else if(id==='udaq'){s.udaq.viewIndex=wrap(s.udaq.viewIndex+direction,UDAQ_VIEWS.length);s.udaq.view=UDAQ_VIEWS[s.udaq.viewIndex];}
    else if(id==='settings')this.adjustSetting(direction);
    else if(id==='transfer'&&s.transfer.unlocked&&s.transfer.browserPage==='browser')s.transfer.selected=clamp(s.transfer.selected+direction,0,s.transfer.files.length-1);
    else if(id==='communications'&&s.communications.unlocked&&s.communications.section==='compose')s.communications.charIndex=rotateCharacter(s.communications.charMode,s.communications.charIndex,direction);
    else if(id==='whofi')s.whofi.span=clamp(s.whofi.span+direction*10,20,160);
    else if(id==='lilmidi')this.adjustMidiFocus(direction);
    else if(id==='particles')this.adjustParticleFocus(direction);
    else if(id==='notebook'){const n=s.notebook;if(n.page==='home')n.selected=wrap(n.selected+direction,7);else if(n.page==='timer'&&!n.timerRunning){n.timerSeconds=clamp(n.timerSeconds+direction*60,60,3600);n.timerRemaining=n.timerSeconds;}else if(n.page==='calendar')n.calendarOffset+=direction;else if(n.page==='ruler')n.rulerMm=clamp(n.rulerMm+direction,10,200);}
    this.renderAndSave();
  }

  adjustSetting(direction){const s=this.state.settings;if(s.page===0){if(s.focus===0)s.brightness=clamp(s.brightness+direction*16,64,255);else if(s.focus===1){const v=['30 SEC','1 MIN','2 MIN','5 MIN'];s.screenIdle=v[wrap(v.indexOf(s.screenIdle)+direction,v.length)];}else if(s.focus===2)this.flashStatus(`${s.touchDown} DOWN / ${s.touchUp} UP / ${s.touchDrop} DROP`);else if(s.focus===3)this.centerMotion();}else if(s.page===1){if(s.focus===0){const v=['SMALL','LARGE','XL'];s.textSize=v[wrap(v.indexOf(s.textSize)+direction,v.length)];}else if(s.focus===1)s.messageSound=!s.messageSound;else if(s.focus===2)s.reducedMotion=!s.reducedMotion;else if(s.focus===3)s.diagnostics=!s.diagnostics;}}

  primaryAction(fromHold) {
    if(this.state.settings.patternMode)return;
    if(!this.state.settings.firstRunComplete){this.advanceIntroduction();return;}
    if(this.nativeShell.onPrimaryAction())return;
    if(this.state.drawerOpen){this.openApp(this.state.drawerIndex);return;}const id=currentApp(this.state).id;
    if(id==='rain'){this.state.rain.running=!this.state.rain.running;this.renderAndSave();}
    else if(id==='hsv')this.sampleHsvSwatch();
    else if(id==='aem')this.toggleDegas();
    else if(id==='synth'){if(fromHold)this.startSynthArp();else this.toggleSynthLatch();}
    else if(id==='percussion')this.togglePercussion();
    else if(id==='recorder')this.recordPrimary(fromHold);
    else if(id==='udaq'){this.state.udaq.running=!this.state.udaq.running;this.renderAndSave();}
    else if(id==='settings'){this.state.settings.page=(this.state.settings.page+1)%4;this.renderAndSave();}
    else if(id==='transfer'){if(!this.state.transfer.unlocked)this.flashStatus('DRAW PATTERN');else if(this.state.transfer.browserPage==='browser')this.openSelectedFile();else this.dispatchAction('transfer-browser');}
    else if(id==='communications'){if(!this.state.communications.unlocked)this.flashStatus('DRAW PATTERN');else if(fromHold&&this.state.communications.section==='compose')this.toggleDictation(true);else if(this.state.communications.section==='compose')this.addCommChar();else if(this.state.communications.section==='quick')this.chooseQuickDirection(this.nativeShell.quickDirection||'up');else if(this.state.communications.section==='review')this.saveLocalMessage();else if(this.state.communications.section==='journal')this.state.communications.section='detail',this.render();else this.dispatchAction('comm-compose');}
    else if(id==='whofi')this.toggleWhoFi();
    else if(id==='lilmidi'){this.state.lilmidi.scene=this.state.lilmidi.scenes[wrap(this.state.lilmidi.scenes.indexOf(this.state.lilmidi.scene)+1,this.state.lilmidi.scenes.length)];this.renderAndSave();}
    else if(id==='particles'){this.state.particles.paused=!this.state.particles.paused;this.renderAndSave();}
    else if(id==='notebook'){const pages=['calendar','weather','timer','stopwatch','calculator','ruler','settings'];if(this.state.notebook.page==='home'){this.state.notebook.page=pages[this.state.notebook.selected%pages.length];this.renderAndSave();}else{this.state.notebook.page='home';this.renderAndSave();}}
    else if(id==='power')this.readBattery(true);
    else if(id==='camera')this.toggleCamera();
  }
  primaryRelease(){const id=currentApp(this.state).id;if(id==='synth'&&!this.state.synth.latch)this.stopSynth();
    if(id==='communications'&&this.state.communications.dictating)this.toggleDictation(false);
    if(id==='recorder'&&this.recordingHoldRequested){this.recordingHoldRequested=false;this.recordingHoldWasReleased=true;this.stopRecording();}}

  syncRainControls(){
    const r=this.state.rain,m=this.rainModel;
    m.adjustSpawnRate(r.spawnRate-m.spawnRate);m.adjustFallSpeed(r.fallSpeed-m.fallSpeed);
    m.adjustTargetSpeed(r.targetSpeed-m.targetSpeedManual);m.adjustTargetWidth(r.targetWidth-m.targetWidth);
    m.adjustManualWind(r.manualWind-m.manualWind);m.imuWindEnabled=r.windMode==='IMU';m.paused=!r.running;
    const mode=r.predictor==='LEGACY'?RainPrediction.LEGACY:RainPrediction.SWEPT;
    if(m.predictionMode!==mode)m.cyclePrediction();
  }
  syncRainSnapshot(){
    const r=this.state.rain,s=this.rainModel.snapshot();
    Object.assign(r,{targetX:s.targetX,effectiveWind:s.effectiveWind,effectiveFallSpeed:s.spawnFallSpeed,
      effectiveTargetSpeed:s.targetSpeed,activeDrops:s.activeDropCount,hits:s.hits,misses:s.misses,
      predicted:s.predictedHits,falsePositives:s.falsePositives,falseNegatives:s.falseNegatives,
      impactFlash:s.impactFlash,imuStatus:s.imuWindEnabled?s.imuControlReady?(s.imuMotionValid?'IMU WIND':'MOVE SLOW'):'IMU WAIT':'MANUAL'});
  }
  adjustRainControl(field,direction){
    const r=this.state.rain,steps={spawnRate:1,fallSpeed:15,targetSpeed:10,targetWidth:4,manualWind:15};
    const bounds={spawnRate:[0,90],fallSpeed:[112,336],targetSpeed:[-166,166],targetWidth:[32,100],manualWind:[-140,140]};
    if(!(field in steps))return;
    r[field]=clamp(r[field]+direction*steps[field],...bounds[field]);
    this.syncRainControls();this.renderAndSave();
  }
  syncHsvModelFromState(){
    const h=this.state.hsv;
    this.hsvModel.setPlane(h.tilt,h.spin,h.offset);
    this.hsvModel.swatches=h.swatches.slice(-5).map(item=>({hue:Number(item.h)||0,saturation:(Number(item.s)||0)/100,
      value:(Number(item.v)||0)/100,color:hsvToRgb(Number(item.h)||0,(Number(item.s)||0)/100,(Number(item.v)||0)/100)}));
    this.hsvModel.selected=this.hsvModel.swatches.at(-1)||null;
    this.syncHsvState();
  }
  syncHsvState(){
    const h=this.state.hsv,m=this.hsvModel;
    Object.assign(h,{tilt:m.tilt,spin:m.spin,offset:m.offset,sectionLabel:m.fit.label,
      swatches:m.swatches.map(s=>({h:Math.round(s.hue),s:Math.round(s.saturation*100),v:Math.round(s.value*100),hex:s.color.hex}))});
    Object.assign(h,m.selected
      ? {selectedHue:Math.round(m.selected.hue),selectedSaturation:Math.round(m.selected.saturation*100),selectedValue:Math.round(m.selected.value*100),selectedHex:m.selected.color.hex}
      : {selectedHue:0,selectedSaturation:0,selectedValue:0,selectedHex:'--'});
  }
  adjustHsvControl(field,direction){
    const h=this.state.hsv;
    if(field==='OFFSET')h.offset=clamp(h.offset+direction*.01,-.85,.85);
    else if(field==='TILT'&&!h.imuPlane)h.manualTilt=clamp(h.manualTilt+direction*2,0,90);
    else if(field==='SPIN'&&!h.imuPlane)h.manualSpin=wrap(h.manualSpin+direction*5,360);
    else return;
    this.hsvModel.setPlane(h.imuPlane?this.hsvModel.tilt:h.manualTilt,h.imuPlane?this.hsvModel.spin:h.manualSpin,h.offset);
    this.syncHsvState();this.renderAndSave();
  }
  cycleHsvPreset(){
    const h=this.state.hsv;h.preset=HSV_PRESETS[wrap(HSV_PRESETS.indexOf(h.preset)+1,HSV_PRESETS.length)];
    h.imuPlane=false;this.hsvModel.preset(h.preset);h.manualTilt=this.hsvModel.tilt;h.manualSpin=this.hsvModel.spin;
    this.syncHsvState();this.renderAndSave();
  }
  setHsvSample(event,el){
    const r=el.getBoundingClientRect(),x=clamp((event.clientX-r.left)/r.width,0,1),y=clamp((event.clientY-r.top)/r.height,0,1);
    this.hsvSamplePoint={x,y};const swatch=this.hsvModel.sample(x,y,r.width,r.height);
    if(swatch){this.syncHsvState();this.renderAndSave();}else this.flashStatus('OUTSIDE CONE');
  }
  updateHsvOrbit(event){const d=this.interactions.active?.data;if(!d)return;this.state.hsv.cameraYaw=wrap(d.yaw+(event.clientX-d.x)*.45,360);this.render();}
  sampleHsvSwatch(){
    const {x,y}=this.hsvSamplePoint,sample=this.hsvModel.sample(x,y,224,117);
    if(!sample){this.flashStatus('OUTSIDE CONE');return;}
    this.syncHsvState();this.flashStatus(`SWATCH ${sample.color.hex}`);this.scheduleSave();
  }

  recomputeAem(rerender=true){
    const a=this.state.aem;
    const m=calculateAemMetrics({voltageMode:a.driver==='VOLTAGE',usefulCurrentDensityAcm2:a.effectiveCurrentSetpoint,
      cellVoltageSetpointV:a.voltageSetpoint,activeAreaCm2:a.activeAreaCm2,faradaicEfficiency:a.faradaicEfficiency,
      membraneResistivityOhmCm:a.membraneResistivityOhmCm,membraneThicknessUm:a.membraneThicknessUm,
      membraneCapacityPackets:a.membraneCapacityPackets,waterPacketsPerSecond:a.effectiveWaterPacketsPerSecond});
    Object.assign(a,{currentDensity:m.totalCurrentDensityAcm2,voltage:m.cellVoltageV,h2Rate:m.hydrogenGramsPerHour,
      supportedH2Rate:m.supportedHydrogenGramsPerHour,realizedEfficiency:m.realizedEfficiency,
      regime:m.regime,bottleneck:m.bottleneck,transportLimited:m.transportLimited,
      membraneVisualWidthPx:m.membraneVisualWidthPx,hydroxideVisualVelocityPxS:m.hydroxideVisualVelocityPxS,
      transportLimitAcm2:m.transportLimitAcm2,voltageSetpointLimited:m.voltageSetpointLimited,
      load:Math.round(m.totalCurrentDensityAcm2/3.4825*100)});
    if(rerender)this.render();
  }
  setAemFromPointer(event,el){
    const r=el.getBoundingClientRect(),fraction=clamp((event.clientX-r.left)/r.width,0,1),a=this.state.aem;
    if(a.driver==='VOLTAGE')a.voltageSetpoint=1.229+fraction*(3.2-1.229);
    else a.currentSetpoint=fraction*3.4825;
    a.effectiveCurrentSetpoint=a.currentSetpoint;this.recomputeAem();this.scheduleSave();
  }
  adjustAemFocus(d){
    const a=this.state.aem;
    if(a.focus==='DRIVER'){
      if(a.driver==='VOLTAGE')a.voltageSetpoint=clamp(a.voltageSetpoint+d*.02,1.229,3.2);
      else a.currentSetpoint=clamp(a.currentSetpoint+d*.05,0,3.4825);
    }else if(a.focus==='WATER')a.waterPacketsPerSecond=clamp(a.waterPacketsPerSecond+d,0,80);
    else if(a.focus==='EFF')a.faradaicEfficiency=clamp(a.faradaicEfficiency+d*.01,0,1);
    else if(a.focus==='MEM')a.membraneCapacityPackets=clamp(a.membraneCapacityPackets+d*2,4,200);
    a.effectiveCurrentSetpoint=a.currentSetpoint;a.effectiveWaterPacketsPerSecond=a.waterPacketsPerSecond;
    this.recomputeAem(false);
  }
  startDegas(ms=3000){const a=this.state.aem;a.degas=true;a.degasUntil=Math.max(a.degasUntil,Date.now()+ms);this.render();}
  toggleDegas(){if(this.state.aem.degas){this.state.aem.degas=false;this.state.aem.degasUntil=0;}else this.startDegas(3000);this.renderAndSave();}

  synthOptions(){const s=this.state.synth,resolved=resolveSynthParams(s,s.padX,1-s.padY,{ready:s.imuMotion&&s.imuStatus==='MOTION MAP',delay:s.imuDelayMod||0,reverb:s.imuReverbMod||0});
    return{...resolved,waveform:s.waveform,frequency:midiToFrequency(clamp(resolved.rootMidi+s.transpose,s.pitchFloor,s.pitchCeiling)),
      cutoff:resolved.filterHz,resonance:s.resonance,voiceVolume:s.muted?0:s.volume*resolved.outputLevel};}
  async setSynthPad(event,el,start){const r=el.getBoundingClientRect(),x=clamp((event.clientX-r.left)/r.width,0,1),y=1-clamp((event.clientY-r.top)/r.height,0,1),s=this.state.synth;s.padX=x;s.padY=y;try{if(start||!s.active){await this.audio.startPadVoice(x,y,this.synthOptions());s.active=true;}else this.audio.updatePadVoice(x,y,this.synthOptions());}catch(e){this.flashStatus(e.message);}this.render();}
  async startSynthAtCurrent(){const generation=++this.synthGeneration;try{await this.audio.startPadVoice(this.state.synth.padX,this.state.synth.padY,this.synthOptions());if(generation!==this.synthGeneration){this.audio.stopPadVoice();return;}this.state.synth.active=true;this.state.synth.audioStatus='AUDIO READY';this.render();}catch(e){this.flashStatus(e.message);}}
  async startSynthArp(){const generation=++this.synthGeneration;try{await this.audio.startArp(()=>({patch:this.state.synth,resolved:resolveSynthParams(this.state.synth,this.state.synth.padX,1-this.state.synth.padY,{ready:this.state.synth.imuStatus==='MOTION MAP',delay:this.state.synth.imuDelayMod||0,reverb:this.state.synth.imuReverbMod||0})}));if(generation!==this.synthGeneration){this.audio.stopArp();return;}this.state.synth.active=true;this.state.synth.audioStatus='AUDIO READY';this.render();}catch(e){this.flashStatus(e.message);}}
  toggleSynthLatch(){const s=this.state.synth;s.latch=!s.latch;if(s.latch)this.startSynthArp();else this.stopSynth();this.renderAndSave();}
  stopSynth(rerender=true){this.synthGeneration++;this.audio.stopPadVoice();this.audio.stopArp();this.state.synth.active=false;this.state.synth.latch=false;if(rerender)this.render();}
  cycleSynthWaveform(){const v=['SINE','SQUARE','TRIANGLE','SAW','NOISE'];const s=this.state.synth;s.waveform=v[wrap(v.indexOf(s.waveform)+1,v.length)];this.renderAndSave();}
  cycleSynthPreset(){const s=this.state.synth,preset=SYNTH_PRESETS[wrap(SYNTH_PRESETS.indexOf(s.preset)+1,SYNTH_PRESETS.length)];Object.assign(s,factoryPatch(preset));this.audio.updatePadVoice(s.padX,s.padY,this.synthOptions());this.renderAndSave();}
  saveSynthUserPatch(){const s=this.state.synth;s.userPatch=structuredClone({waveform:s.waveform,volume:s.volume,tempo:s.tempo,transpose:s.transpose,
    pitchFloor:s.pitchFloor,pitchCeiling:s.pitchCeiling,mods:s.mods,arpDirection:s.arpDirection,arpSpan:s.arpSpan,arpRate:s.arpRate});this.flashStatus('USER PATCH SAVED');this.scheduleSave();}
  loadSynthUserPatch(){const s=this.state.synth;if(!s.userPatch){this.flashStatus('NO USER PATCH');return;}
    Object.assign(s,structuredClone(s.userPatch),{preset:'USER'});this.audio.updatePadVoice(s.padX,s.padY,this.synthOptions());this.renderAndSave();}
  adjustSynthFocus(d){const s=this.state.synth,f=s.focus;if(f==='CUTOFF')s.cutoff=clamp(s.cutoff+d*250,250,7000);else if(f==='RESONANCE')s.resonance=clamp(s.resonance+d*.05,0,.9);else if(f==='DELAY'){s.baseDelay=clamp(s.baseDelay+d*.03,0,.55);s.delay=s.baseDelay;}else if(f==='REVERB'){s.baseReverb=clamp(s.baseReverb+d*.03,0,.6);s.reverb=s.baseReverb;}else if(f==='VOLUME')s.volume=clamp(s.volume+d*3,0,100);else if(f==='TRANSPOSE')s.transpose=clamp(s.transpose+d,-24,24);else if(f==='MAPX')s.mapX=SYNTH_MAPS[wrap(SYNTH_MAPS.indexOf(s.mapX)+d,SYNTH_MAPS.length)];else if(f==='MAPY')s.mapY=SYNTH_MAPS[wrap(SYNTH_MAPS.indexOf(s.mapY)+d,SYNTH_MAPS.length)];else if(f==='ARPDIR'){const v=['UP','DOWN','ALT'];s.arpDirection=v[wrap(v.indexOf(s.arpDirection)+d,v.length)];}else if(f==='ARPSPAN')s.arpSpan=clamp(s.arpSpan+d,1,4);else if(f==='ARPRATE')s.arpRate=clamp(s.arpRate+d,1,6);else if(f==='TEMPO')s.tempo=clamp(s.tempo+d*2,40,240);this.audio.updatePadVoice(s.padX,s.padY,this.synthOptions());}

  beginPercussionContact(event,el){const r=el.getBoundingClientRect();this.beginPercussionPad(clamp((event.clientX-r.left)/r.width,0,1),clamp((event.clientY-r.top)/r.height,0,1));}
  updatePercussionContact(event,el){const r=el.getBoundingClientRect();this.movePercussionPad(clamp((event.clientX-r.left)/r.width,0,1),clamp((event.clientY-r.top)/r.height,0,1));}
  beginPercussionPad(x,y){const p=this.state.percussion,now=Date.now(),retouch=p.playing&&now<=p.graceDeadline;
    p.contact=true;p.contactX=x;p.contactY=y;p.padX=x;p.padY=y;p.contactStartedAt=performance.now();
    p.energy=clamp(1+Math.floor(x*4),1,4);p.groove=clamp(1+Math.floor(y*4),1,4);
    p.stopAtBoundary=false;
    if(retouch){const variation=variationFromRetouch(p.lastReleasePoint||{x,y},{x,y},now-p.releasedAt,1,p.variationSerial+1);
      if(variation){p.variationSerial=variation.serial;p.variationModel=variation;p.variationArmed=variation.mode;this.audio.setPercussionVariation(variation);}}
    this.refreshPercussionPattern();if(!p.playing)this.startPercussion();this.render();}
  movePercussionPad(x,y){const p=this.state.percussion;if(!p.contact)return;
    p.padX=x;p.padY=y;p.energy=clamp(1+Math.floor(x*4),1,4);p.groove=clamp(1+Math.floor(y*4),1,4);
    if(p.variationModel&&performance.now()-p.contactStartedAt<=180&&Math.hypot(x-p.contactX,y-p.contactY)>.04){
      const variation=variationFromRetouch({x:p.contactX,y:p.contactY},{x,y},p.variationModel.gapMs,performance.now()-p.contactStartedAt,p.variationSerial);
      if(variation){variation.seed=p.variationModel.seed;p.variationModel=variation;p.variationArmed=variation.mode;this.audio.setPercussionVariation(variation);}}
    this.refreshPercussionPattern();this.render();}
  finishPercussionContact(){const p=this.state.percussion;if(!p.contact)return;p.contact=false;p.lastReleasePoint={x:p.padX,y:p.padY};p.releasedAt=Date.now();p.graceDeadline=p.releasedAt+650;p.stopAtBoundary=true;this.render();}
  refreshPercussionPattern(){const p=this.state.percussion;p.pattern=percussionPatternFor(p.energy,p.groove);this.audio.updateSequencer(p.pattern,p.bpm,p.muted?0:p.volume/100,{kit:p.kit,energy:p.energy,groove:p.groove});}
  togglePercStep(v,i){if(!PERCUSSION_VOICES.includes(v)||i<0||i>15)return;this.state.percussion.pattern[v][i]^=1;this.audio.updateSequencer(this.state.percussion.pattern,this.state.percussion.bpm,this.state.percussion.volume/100);this.renderAndSave();}
  async startPercussion(){const p=this.state.percussion;try{await this.audio.startSequencer(p.pattern,p.bpm,(step,globalStep)=>this.onPercussionStep(step,globalStep),p.muted?0:p.volume/100,{kit:p.kit,energy:p.energy,groove:p.groove});p.playing=true;p.stopAtBoundary=false;this.renderAndSave();}catch(e){this.flashStatus(e.message);}}
  onPercussionStep(step,globalStep){const p=this.state.percussion;p.currentStep=step;if(step===0){if(p.stopAtBoundary&&!p.contact&&Date.now()>p.graceDeadline){this.audio.stopSequencer();p.playing=false;p.currentStep=-1;p.stopAtBoundary=false;p.variation='WHOLE KIT';this.renderAndSave();return;}if(p.variationArmed){p.variation=p.variationArmed;p.variationArmed='';}else if(p.variation!=='WHOLE KIT'&&globalStep>=((this.audio.sequenceState?.variationTarget??Infinity)+(p.variationModel?.durationSteps||0))){p.variation='WHOLE KIT';}}
    if(currentApp(this.state).id==='percussion'&&!this.state.drawerOpen)this.drawCurrent();}
  togglePercussion(){const p=this.state.percussion;if(p.playing){p.contact=false;p.stopAtBoundary=true;p.graceDeadline=Date.now();this.flashStatus('STOP AT LOOP');this.renderAndSave();}else this.startPercussion();}
  cyclePercKit(){const v=['CIRCUIT','WARM','METAL'],p=this.state.percussion;p.kit=v[wrap(v.indexOf(p.kit)+1,v.length)];this.audio.updateSequencer(p.pattern,p.bpm,p.volume/100,{kit:p.kit});this.renderAndSave();}

  async recordPrimary(fromHold=false){const intent=recorderPrimaryIntent(this.state.recorder.state);
    if(intent==='STOP'){this.stopRecording();return;}
    if(intent==='WAIT')return;
    if(intent==='PLAY'){this.playRecording();return;}
    if(intent==='DONE'){this.doneRecording();return;}
    if(fromHold)this.recordingHoldRequested=true;
    await this.startRecording();}
  async startRecording(){
    if(!navigator.mediaDevices?.getUserMedia){this.state.recorder.error='MIC API UNAVAILABLE';this.render();return;}
    let stream;
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:true});
      try{this.recording=await startPcmRecording(stream);}
      catch(workletError){
        if(!window.MediaRecorder)throw workletError;
        const recorder=new MediaRecorder(stream),chunks=[];
        recorder.addEventListener('dataavailable',event=>{if(event.data?.size)chunks.push(event.data);});
        recorder.start(100);
        this.recording={format:'WEBM FALLBACK',state:'recording',stop:()=>new Promise(resolve=>{
          recorder.addEventListener('stop',()=>resolve(new Blob(chunks,{type:recorder.mimeType||'audio/webm'})),{once:true});recorder.stop();})};
      }
      this.recordingStream=stream;this.recordingStartedAt=performance.now();
      Object.assign(this.state.recorder,{state:'recording',format:this.recording.format,error:'',dirty:true,hasClip:false,review:false,seconds:0});
      this.render();
      if(this.recordingHoldRequested===false&&this.recordingHoldWasReleased)this.stopRecording();
      this.recordingHoldWasReleased=false;
    }catch(error){stream?.getTracks().forEach(track=>track.stop());this.recording=null;
      this.state.recorder.error=`MIC: ${error.name||error.message||'ERROR'}`;this.state.recorder.dirty=false;this.render();}
  }
  async stopRecording(){
    if(this.state.recorder.state!=='recording'||!this.recording)return;
    const recorder=this.recording,stream=this.recordingStream;
    this.state.recorder.state='finalizing';this.render();
    try{
      const blob=await recorder.stop();
      this.recordingBlob=blob;
      this.state.recorder.waveform=recorder.format==='WAV'?waveformPeaks(recorder.chunks):[];
      if(this.recordingUrl)URL.revokeObjectURL(this.recordingUrl);
      this.recordingUrl=URL.createObjectURL(blob);
      const duration=(performance.now()-this.recordingStartedAt)/1000;
      Object.assign(this.state.recorder,{state:'review',hasClip:blob.size>44,clipBytes:blob.size,error:'',review:true,duration,seconds:duration,position:0,dirty:blob.size>44,saved:false});
    }catch(error){Object.assign(this.state.recorder,{state:'idle',dirty:false,error:`FINALIZE: ${error.message||error}`});}
    finally{stream?.getTracks().forEach(track=>track.stop());this.recording=null;this.recordingStream=null;this.render();}
  }
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
  async playRecording(){if(!this.recordingUrl)return;try{if(this.recordingAudio&&!this.recordingAudio.paused){this.recordingAudio.pause();this.render();return;}this.recordingAudio?.pause();const a=new Audio(this.recordingUrl);this.recordingAudio=a;a.volume=this.state.settings.volume/100;a.currentTime=clamp(this.state.recorder.position,0,this.state.recorder.duration||0);a.addEventListener('timeupdate',()=>{this.state.recorder.position=a.currentTime;},{passive:true});a.addEventListener('ended',()=>{this.state.recorder.position=0;if(currentApp(this.state).id==='recorder')this.render();},{once:true});await a.play();this.render();}catch(e){this.flashStatus(e.message);}}
  seekRecording(delta){const r=this.state.recorder;r.position=clamp(r.position+delta,0,r.duration||0);if(this.recordingAudio)this.recordingAudio.currentTime=r.position;this.render();}
  async saveRecording(){if(!this.recordingBlob||!this.state.recorder.dirty){this.flashStatus('NO UNSAVED CLIP');return;}const format=this.state.recorder.format==='WAV'?'wav':'webm';const rec=await this.media.put({kind:'audio',name:`Recording-${new Date().toISOString().replace(/[:.]/g,'-')}.${format}`,mime:this.recordingBlob.type,blob:this.recordingBlob,duration:this.state.recorder.duration});Object.assign(this.state.recorder,{state:'saved',saved:true,savedId:rec.id,dirty:false});await this.refreshMediaFiles();this.flashStatus('RECORDING SAVED LOCALLY');this.scheduleSave();}
  async shareRecording(){const id=this.state.recorder.savedId;if(!id){this.flashStatus('SAVE BEFORE SHARE');return;}if(this.state.recorder.duration>15){this.flashStatus('TOO LONG TO SEND');return;}this.state.communications.voiceAssetId=id;this.state.communications.draft='[voice recording]';this.state.communications.section='review';this.flashStatus('VOICE STAGED FOR LOCAL JOURNAL');this.scheduleSave();}
  doneRecording(){this.recordingAudio?.pause();if(this.recordingUrl)URL.revokeObjectURL(this.recordingUrl);this.recordingUrl=null;this.recordingBlob=null;this.state.recorder=recorderReadyState();this.renderAndSave();}
  discardRecording(){this.doneRecording();}

  cycleUdaqRate(){const v=[5,10,25],u=this.state.udaq;u.sampleRate=v[wrap(v.indexOf(u.sampleRate)+1,v.length)];this.renderAndSave();}
  advanceUdaq(now){
    const u=this.state.udaq;if(!u.running)return;
    const period=1000/u.sampleRate;
    if(now>=u.lastSampleMs&&now-u.lastSampleMs<period)return;
    if(u.inputSource==='DEMO'){
      const t=now/950;u.source='DEMO';u.sourceAvailable=true;u.sourceFresh=true;
      u.x=Math.sin(t)*.42;u.y=Math.cos(t*.73)*.29;u.z=.93+Math.sin(t*.41)*.04;
      u.magnitude=Math.hypot(u.x,u.y,u.z);u.pitch=Math.atan2(u.y,Math.hypot(u.x,u.z))*180/Math.PI;u.roll=Math.atan2(u.x,Math.hypot(u.y,u.z))*180/Math.PI;
    }else{
      const latest=this.sensorHub.latest(now);
      if(!latest?.status.fresh){u.sourceFresh=false;return;}
      if(latest.sequence===u.lastSequence)return;
      u.lastSequence=latest.sequence;
    }
    u.lastSampleMs=now;
    u.history.push({t:Date.now(),x:u.x,y:u.y,z:u.z,m:u.magnitude,pitch:u.pitch,roll:u.roll,jerk:u.jerk,source:u.source,fresh:u.sourceFresh,seq:this.state.motion.sequence});
    if(u.history.length>300)u.history.splice(0,u.history.length-300);
    this.refreshLiveReadouts();
  }
  exportUdaqCsv(){const rows=['timestamp,sequence,source,x,y,z,magnitude,pitch,roll,jerk,fresh',...this.state.udaq.history.map(s=>[s.t,s.seq,s.source,s.x,s.y,s.z,s.m,s.pitch,s.roll,s.jerk,s.fresh].join(','))];this.downloadBlob(new Blob([rows.join('\n')],{type:'text/csv'}),'lilled-r1-udaq.csv');this.flashStatus('uDAQ CSV EXPORT REQUESTED');}
  centerMotion(){if(this.sensorHub.center()){this.state.motion.calibration=this.sensorHub.exportCalibration();this.state.settings.imuZero=`CENTERED G${this.state.motion.calibration.generation}`;this.flashStatus('MOTION CENTERED');this.scheduleSave();}else this.flashStatus('NO LIVE MOTION SAMPLE');}

  syncPatternStatus(){const s=this.state.settings;s.patternEnrolled=this.patternService.enrolled;s.patternFailures=this.patternService.failures;s.patternLockoutUntil=this.patternService.lockoutUntil;}
  beginPatternSetup(){
    if(this.state.settings.patternError){this.flashStatus(this.state.settings.patternError,2400);return;}
    if(this.patternService.lockedOut()){this.flashStatus('PATTERN LOCKED OUT',2400);return;}
    const s=this.state.settings;s.patternMode=this.patternService.enrolled?'verify-change':'create';s.pendingPattern=[];this.state.drawerOpen=false;this.render();
  }
  cancelPatternSetup(){const s=this.state.settings;s.patternMode='';s.pendingPattern=[];this.render();}
  resetSharedPattern(){this.beginPatternSetup();}
  async resetForgottenPattern(){
    const s=this.state.settings;if(s.patternMode!=='reset-confirm'||this.patternBusy)return;
    this.patternBusy=true;
    try{
      await this.media.clear();
      this.state.communications={...createDefaultState().communications};
      this.state.transfer={...createDefaultState().transfer};
      this.state.recorder.savedId='';this.state.recorder.hasClip=false;this.state.recorder.review=false;
      this.state.camera.savedId='';this.state.camera.dirty=false;
      clearTimeout(this.saveTimer);
      await this.platform.saveJson(STORAGE_KEY,serializePersistentState(this.state));
      await this.patternService.clear();
      this.syncPatternStatus();s.patternMode='create';s.pendingPattern=[];
      this.flashStatus('PROTECTED CONTENT ERASED · SET NEW PATTERN',3000);
    }catch(error){console.error('password reset',error);this.flashStatus('RESET FAILED · CONTENT MAY BE PARTLY ERASED',3500);}
    finally{this.patternBusy=false;}
  }
  advanceIntroduction(){
    const s=this.state.settings;if(s.introStep<4)s.introStep++;
    else if(s.introStep===4){if(this.patternService.enrolled)s.introStep=5;else{this.beginPatternSetup();return;}}
    else this.completeIntroduction();
    this.renderAndSave();
  }
  completeIntroduction(){
    if(!this.patternService.enrolled){this.flashStatus('SET DEVICE PATTERN FIRST',2400);return;}
    const s=this.state.settings;s.firstRunComplete=true;s.introSeen=true;s.introStep=5;this.state.drawerOpen=true;this.renderAndSave();
  }
  patternNodeAt(event,grid){
    const r=grid.getBoundingClientRect(),x=event.clientX-r.left,y=event.clientY-r.top;
    const col=Math.floor(x/(r.width/3)),row=Math.floor(y/(r.height/3));
    if(col<0||col>2||row<0||row>2)return -1;
    const cx=(col+.5)*r.width/3,cy=(row+.5)*r.height/3;
    return Math.hypot(x-cx,y-cy)<=Math.min(r.width,r.height)*.13?row*3+col:-1;
  }
  startPatternGesture(event,grid){
    if(this.patternBusy||this.patternService.lockedOut())return false;
    const node=this.patternNodeAt(event,grid);if(node<0)return false;
    this.patternGesture={app:grid.dataset.patternApp,grid,path:[node],pointerId:event.pointerId,last:{x:event.clientX,y:event.clientY}};
    grid.querySelector(`[data-pattern-dot="${node}"]`)?.classList.add('active');
    return true;
  }
  extendPatternGesture(event){
    const g=this.patternGesture;if(!g)return;
    const dx=event.clientX-g.last.x,dy=event.clientY-g.last.y,steps=Math.max(1,Math.ceil(Math.hypot(dx,dy)/5));
    for(let i=1;i<=steps;i++){
      const node=this.patternNodeAt({clientX:g.last.x+dx*i/steps,clientY:g.last.y+dy*i/steps},g.grid);
      if(node<0)continue;
      const before=g.path;g.path=appendPatternNode(before,node);
      for(const added of g.path.slice(before.length))g.grid.querySelector(`[data-pattern-dot="${added}"]`)?.classList.add('active');
    }
    g.last={x:event.clientX,y:event.clientY};
  }
  async finishPatternGesture(){
    const g=this.patternGesture;this.patternGesture=null;if(!g)return;
    const path=g.path,s=this.state.settings;this.patternBusy=true;
    try{
      if(g.app==='settings'){
        if(s.patternMode==='verify-change'){
          const result=await this.patternService.verify(path);
          this.syncPatternStatus();
          if(!result.ok){this.flashStatus(result.reason,2400);return;}
          s.patternMode='create';this.flashStatus('DRAW NEW PATTERN');return;
        }
        if(s.patternMode==='create'){
          if(!validPattern(path)){this.flashStatus('USE AT LEAST 4 DOTS',2400);return;}
          s.pendingPattern=[...path];s.patternMode='confirm';this.flashStatus('DRAW AGAIN TO CONFIRM');return;
        }
        if(s.patternMode==='confirm'){
          if(!samePattern(path,s.pendingPattern)){s.pendingPattern=[];s.patternMode='create';this.flashStatus('NO MATCH · START AGAIN',2400);return;}
          const result=await this.patternService.enroll(path);
          s.pendingPattern=[];s.patternMode='';this.syncPatternStatus();
          if(result.ok){this.lockArea('transfer',false);this.lockArea('communications',false);if(!s.firstRunComplete)s.introStep=5;}
          this.flashStatus(result.reason,2400);this.scheduleSave();return;
        }
      } else if(g.app==='transfer'||g.app==='communications'){
        const result=await this.patternService.verify(path);
        this.syncPatternStatus();
        if(result.ok){const lock=this.state[g.app];lock.unlocked=true;if(g.app==='transfer')lock.browserPage='home';else lock.section='home';}
        this.flashStatus(result.ok?(g.app==='transfer'?'FILES UNLOCKED':'MESSAGING UNLOCKED'):result.reason,2400);
        this.scheduleSave();
      }
    }catch(error){console.error('pattern',error);this.flashStatus('PATTERN STORAGE ERROR',2400);}
    finally{this.patternBusy=false;}
  }
  lockArea(app,rerender=true){const s=this.state[app];if(!s)return;s.unlocked=false;s.gesture=[];if(app==='transfer'){s.browserPage='home';this.clearFilePreview();}if(app==='communications'){if(s.dictating)this.toggleDictation(false);this.journalAudio?.pause();s.section='home';}if(rerender)this.renderAndSave();}

  async refreshMediaFiles(){const media=await this.media.list().catch(()=>[]);
    this.state.transfer.files=[...virtualFiles(this.state,serializePersistentState),...media.map(m=>({id:m.id,name:`Media/${m.name}`,type:(m.kind||'MEDIA').toUpperCase(),kind:m.kind||'media',size:m.blob?.size?`${Math.round(m.blob.size/1024)} KB`:'LOCAL'}))];
    this.state.transfer.selected=clamp(this.state.transfer.selected,0,Math.max(0,this.state.transfer.files.length-1));}
  clearFilePreview(){this.fileAudio?.pause();this.fileAudio=null;this.fileImage=null;if(this.filePreviewUrl)URL.revokeObjectURL(this.filePreviewUrl);this.filePreviewUrl=null;this.filePreview=null;this.fileQr=null;this.fileDeleteConfirm=false;this.fileScroll=0;}
  closeFilePreview(){this.clearFilePreview();this.state.transfer.browserPage='browser';this.render();}
  async openSelectedFile(){const entry=this.state.transfer.files[this.state.transfer.selected];if(!entry)return;
    this.clearFilePreview();
    try{
      if(entry.kind==='virtual')this.filePreview={...entry,text:virtualFileText(entry.id,this.state,serializePersistentState)};
      else{
        const record=await this.media.get(entry.id);if(!record?.blob)throw new Error('FILE MISSING');
        this.filePreview={...entry,mime:record.mime||record.blob.type,duration:record.duration||0};
        if(['text','json','csv'].includes(entry.kind))this.filePreview.text=(await record.blob.text()).slice(0,32768);
        if(['audio','image'].includes(entry.kind)){this.filePreviewUrl=URL.createObjectURL(record.blob);this.filePreview.url=this.filePreviewUrl;
          if(entry.kind==='image'){this.fileImage=new Image();this.fileImage.onload=()=>this.nativeShell.draw();this.fileImage.src=this.filePreviewUrl;}
          else {this.fileAudio=new Audio(this.filePreviewUrl);this.fileAudio.onloadedmetadata=()=>this.nativeShell.draw();this.fileAudio.ontimeupdate=()=>this.nativeShell.draw();}}
      }
      this.state.transfer.browserPage='preview';this.render();
    }catch(error){this.flashStatus(error.message||'FILE OPEN FAILED');}}
  requestFileDelete(){const entry=this.state.transfer.files[this.state.transfer.selected];if(!entry)return;
    if(entry.kind==='virtual'){this.flashStatus('GENERATED FILE / CANNOT DELETE');return;}
    this.fileDeleteConfirm=true;this.render();}
  async deleteSelectedFile(){if(!this.fileDeleteConfirm)return;const entry=this.state.transfer.files[this.state.transfer.selected];
    if(!entry||entry.kind==='virtual')return;await this.media.remove(entry.id);this.clearFilePreview();
    await this.refreshMediaFiles();this.state.transfer.browserPage='browser';this.flashStatus('LOCAL FILE DELETED');this.scheduleSave();}
  async exportSelectedFile(){const entry=this.state.transfer.files[this.state.transfer.selected];if(!entry)return;
    let blob;
    if(entry.kind==='virtual')blob=new Blob([virtualFileText(entry.id,this.state,serializePersistentState)],{type:'application/json'});
    else blob=(await this.media.get(entry.id))?.blob;
    if(!blob){this.flashStatus('FILE MISSING');return;}this.downloadBlob(blob,entry.name.split('/').at(-1));this.flashStatus('DOWNLOAD REQUESTED');}
  async showSelectedFileQr(){if(!this.filePreview?.text)await this.openSelectedFile();
    const text=this.filePreview?.text;if(!text){this.flashStatus('TEXT FILE REQUIRED');return;}
    if(new TextEncoder().encode(text).length>1200){this.flashStatus('TOO LARGE FOR QR');return;}
    try{this.fileQr=encodeQrText(text);this.state.transfer.browserPage='qr';this.render();}
    catch(error){this.flashStatus(error.message||'QR FAILED');}}
  toggleFileAudio(){if(!this.fileAudio)return;if(this.fileAudio.paused)this.fileAudio.play().catch(()=>this.flashStatus('AUDIO PLAYBACK UNAVAILABLE'));else this.fileAudio.pause();this.nativeShell.draw();}
  seekFileAudio(fraction){if(!this.fileAudio||!Number.isFinite(this.fileAudio.duration))return;this.fileAudio.currentTime=clamp(fraction,0,1)*this.fileAudio.duration;this.nativeShell.draw();}
  toggleTransferWireless(){const t=this.state.transfer;if(t.wireless==='ON'){this.transport.disconnect();t.wireless='OFF';t.transferState='IDLE';}else{t.wireless='ON';t.transferState=this.state.lilmidi.bridgeUrl&&this.transport.connect(this.state.lilmidi.bridgeUrl)?'CONNECTING':'NO HOST URL';}this.renderAndSave();}
  exportState(){this.downloadBlob(new Blob([JSON.stringify(serializePersistentState(this.state),null,2)],{type:'application/json'}),'lilled-r1-state.json');this.flashStatus('STATE EXPORT REQUESTED');}
  downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

  addCommChar(){const c=this.state.communications;c.draft=appendMessageCharacter(c.draft,wheelCharacter(c.charMode,c.charIndex));this.renderAndSave();}
  applyQuickMessage(){this.state.communications.quickNode='root';this.state.communications.section='quick';this.renderAndSave();}
  chooseQuickDirection(direction){const c=this.state.communications,choice=chooseQuick(c.quickNode,direction);if(!choice)return;if(choice.leaf){c.draft=choice.message;c.section='review';}else c.quickNode=choice.node;this.renderAndSave();}
  backQuick(){const c=this.state.communications;c.quickNode=QUICK_PARENTS[c.quickNode]||'root';this.renderAndSave();}
  saveLocalMessage(){const c=this.state.communications;if(!c.draft.trim()){this.flashStatus('DRAFT IS EMPTY');return;}c.journal.push({id:`m-${Date.now()}`,from:'LOCAL',text:c.draft.trim(),time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),receipt:'LOCAL',voiceAssetId:c.voiceAssetId||''});c.draft='';c.voiceAssetId='';c.section='journal';c.receipt='LOCAL';this.renderAndSave();}
  sendRabbitJournal(){const c=this.state.communications,text=c.draft.trim();if(!text){this.flashStatus('DRAFT IS EMPTY');return;}if(c.voiceAssetId){this.flashStatus('VOICE IS LOCAL ONLY');return;}try{this.platform.sendMessage(text,{useLLM:false,wantsR1Response:false,wantsJournalEntry:true});c.journal.push({id:`m-${Date.now()}`,from:'RABBIT JOURNAL',text,time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),receipt:'REQUESTED / UNKNOWN'});c.draft='';c.receipt='REQUESTED / UNKNOWN';c.section='journal';this.renderAndSave();}catch(e){c.receipt='FAILED';this.flashStatus(`RABBIT UNAVAILABLE: ${e.message}`);}}
  deleteJournalMessage(){const c=this.state.communications;if(!c.deleteConfirm)return;c.journal.splice(c.selected,1);c.selected=clamp(c.selected,0,Math.max(0,c.journal.length-1));c.deleteConfirm=false;c.section='journal';this.renderAndSave();}
  async playJournalVoice(){const id=this.state.communications.journal[this.state.communications.selected]?.voiceAssetId;if(!id)return;if(this.journalAudio&&!this.journalAudio.paused){this.journalAudio.pause();return;}try{const item=await this.media.get(id);if(!item?.blob)throw new Error('VOICE FILE MISSING');this.journalAudio?.pause();if(this.journalAudioUrl)URL.revokeObjectURL(this.journalAudioUrl);this.journalAudioUrl=URL.createObjectURL(item.blob);this.journalAudio=new Audio(this.journalAudioUrl);this.journalAudio.volume=this.state.settings.volume/100;await this.journalAudio.play();}catch(e){this.flashStatus(e.message||'PLAYBACK UNAVAILABLE');}}
  toggleDictation(force){const c=this.state.communications,start=force===undefined?!c.dictating:force;try{const bridge=window.CreationVoiceHandler;if(!bridge?.postMessage)throw new Error('VOICE BRIDGE UNAVAILABLE');bridge.postMessage(start?'start':'stop');c.dictating=start;this.render();}catch(e){c.dictating=false;this.flashStatus(e.message);}}
  onPluginMessage(data){let payload=data?.data??data?.message??data;if(typeof payload==='string'){try{payload=JSON.parse(payload);}catch{payload={message:payload};}}const c=this.state.communications;if(payload?.sttEnded){c.dictating=false;if(typeof payload.transcript==='string')c.draft=(c.draft+payload.transcript).slice(0,200);this.scheduleSave();}else{c.bridge='RESPONSE';c.lastBridge=String(payload?.message??payload?.ack??'Response received').slice(0,80);c.receipt='UNKNOWN';}if(currentApp(this.state).id==='communications')this.render();}
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
    if(!this.state.settings.firstRunComplete||this.state.settings.patternMode)return;
    if(this.state.drawerOpen){this.nativeShell?.draw();return;}
    if(id==='rain')this.advanceRain(dt);
    if(id==='aem'&&this.state.aem.imuControl&&!this.sensorHub.latest(now)?.status.fresh){
      const a=this.state.aem;
      if(a.effectiveCurrentSetpoint!==a.currentSetpoint||a.effectiveWaterPacketsPerSecond!==a.waterPacketsPerSecond){
        a.effectiveCurrentSetpoint=a.currentSetpoint;a.effectiveWaterPacketsPerSecond=a.waterPacketsPerSecond;
        a.imuStatus='IMU STALE';this.recomputeAem();
      }
    }
    if(id==='udaq')this.advanceUdaq(now);
    if(id==='udaq'||(id==='settings'&&this.state.settings.page===2)){
      const latest=this.sensorHub.latest(now);
      this.state.motion.fresh=Boolean(latest?.status.fresh);
      if(id==='udaq'&&this.state.udaq.inputSource!=='DEMO')this.state.udaq.sourceFresh=Boolean(latest?.status.fresh);
      this.refreshLiveReadouts();
    }
    if(id==='whofi'&&this.state.whofi.running)this.advanceWhoFi();
    if(id==='particles')this.advanceParticles(dt);
    if(id==='power'&&Date.now()-this.lastPowerRead>10000){this.lastPowerRead=Date.now();this.readBattery(false);}
    if(id==='notebook'&&this.state.notebook.page!=='home')this.render();
    this.drawCurrent();
  }

  advanceRain(dt){
    this.syncRainControls();
    const now=performance.now(),m=this.state.motion,c=this.sensorHub.calibration;
    this.rainModel.update(dt,{available:m.available,hasSample:Number.isFinite(this.rainMotionTime),
      calibrationReady:c.valid,nowMs:now,sampledAtMs:this.rainMotionTime,
      horizontalG:Math.sin(m.roll*Math.PI/180),verticalG:Math.sin(m.pitch*Math.PI/180),magnitudeG:m.magnitude});
    this.syncRainSnapshot();
  }

  drawCurrent(){if(this.nativeShell.active){this.nativeShell.draw();return;}if(this.state.drawerOpen)return;const id=currentApp(this.state).id;if(id==='hsv')this.drawHsvCone();else if(id==='udaq')drawUdaqPlot(document.getElementById('daqCanvas'),this.state.udaq);else if(id==='whofi'&&id&&this.state.whofi.page==='view')this.drawWhoFi();else if(id==='particles')this.drawParticles();else if(id==='power')this.drawPower();}
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
