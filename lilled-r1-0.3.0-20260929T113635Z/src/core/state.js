import { APP_DEFS, CORE_APP_COUNT, PERCUSSION_KITS, percussionPatternFor } from './reference-catalog.js';
import { DEFAULT_PATTERN } from '../services/pattern-service.js';

export { APP_DEFS, CORE_APP_COUNT } from './reference-catalog.js';
export const SCREEN_DEFS = APP_DEFS;
export const STATE_VERSION = 3;
export const LOCK_PATTERN = DEFAULT_PATTERN;

export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export const wrap = (value, length) => ((value % length) + length) % length;

export function createDefaultState() {
  return {
    version: STATE_VERSION,
    appIndex: 3,
    screenIndex: 3,
    drawerOpen: true,
    drawerIndex: 3,
    drawerScope: 'core',
    statusMessage: '',
    statusUntil: 0,
    interaction: { wheelLabel: '', pointerOwner: '', navigationBlocked: false },
    motion: {
      available: false, source: 'SIM', fresh: false, validGravity: false, ageMs: 0,
      rawX: 0, rawY: 0, rawZ: 1, x: 0, y: 0, z: 1, magnitude: 1,
      pitch: 0, roll: 0, jerk: 0, shake: false, sequence: 0,
      calibration: { valid: false, pitch: 0, roll: 0, generation: 0 }
    },
    settings: {
      page: 0, focus: 0, brightness: 155, volume: 72, textSize: 'LARGE', orientation: 'PORTRAIT',
      screenIdle: '1 MIN', reducedMotion: false, diagnostics: false, messageSound: true,
      touchDown: 0, touchUp: 0, touchDrop: 0, imuZero: 'NOT CENTERED',
      firstRunComplete: true, introSeen: true, patternEnrolled: true, pattern: [...DEFAULT_PATTERN]
    },
    rain: {
      running: true, predictor: 'LIVE SWEPT', windMode: 'IMU', manualWind: 0, effectiveWind: 0,
      spawnRate: 30, fallSpeed: 224, effectiveFallSpeed: 224, targetSpeed: 83, effectiveTargetSpeed: 83,
      targetWidth: 46, activeDrops: 32, hits: 0, misses: 0, predicted: 0, imuStatus: 'IMU WAIT',
      focus: 'WIND'
    },
    hsv: {
      page: 'cone', tilt: 28, spin: 40, offset: 0, manualTilt: 28, manualSpin: 40,
      preset: 'ELLIPSE', imuPlane: true, imuStatus: 'IMU WAIT', cameraYaw: 0, focus: 'OFFSET',
      selectedHue: 190, selectedSaturation: 76, selectedValue: 90, swatches: []
    },
    aem: {
      page: 'model', baselineLoad: 68, baselineWater: 68, effectiveWater: 68, load: 68, currentDensity: 0.98, voltage: 1.90, h2Rate: 3.69,
      efficiency: 77, water: 68, membrane: 68, driver: 'CURRENT', imuControl: true, imuStatus: 'IMU WAIT',
      degas: false, degasUntil: 0, focus: 'LOAD'
    },
    synth: {
      page: 'perform', padX: 0.5, padY: 0.5, active: false, waveform: 'SINE', tempo: 110, volume: 15,
      transpose: 0, muted: false, pitchFloor: 48, pitchCeiling: 84, cutoff: 3200, resonance: 0.18,
      delay: 0.0, reverb: 0.18, baseDelay: 0.0, baseReverb: 0.18, focus: 'CUTOFF', preset: 'INIT', grid: 'SCALE',
      mapX: 'DELAY', mapY: 'PITCH', imuMotion: true, imuStatus: 'IMU WAIT', arpDirection: 'UP', arpSpan: 1, arpRate: 2
    },
    percussion: {
      page: 'xy', kit: 'CIRCUIT', energy: 2, groove: 2, volume: 22, muted: false, playing: false,
      padX: 0.42, padY: 0.48, currentStep: -1, bpm: 110, variation: 'WHOLE KIT', variationArmed: '',
      contact: false, contactX: 0.42, contactY: 0.48, releasedAt: 0, graceDeadline: 0, stopAtBoundary: false,
      motionFx: true, delay: 0, reverb: 0.12, imuStatus: 'IMU WAIT', focus: 'ENERGY', pattern: percussionPatternFor(2, 2)
    },
    recorder: {
      state: 'idle', seconds: 0, duration: 0, position: 0, hasClip: false, clipBytes: 0,
      review: false, dirty: false, saved: false, savedId: '', sharePending: false, error: ''
    },
    udaq: {
      running: true, source: 'SIM', sourceAvailable: false, sourceFresh: false, sampleRate: 10,
      view: 'XYZ', viewIndex: 0, logging: false, x: 0, y: 0, z: 1, magnitude: 1, pitch: 0, roll: 0,
      jerk: 0, history: [], skipped: 0, spanSeconds: 5, lastSampleMs: 0, focus: 'VIEW'
    },
    transfer: {
      page: 'lock', unlocked: false, gesture: [], candidate: [], failures: 0, lockoutUntil: 0,
      browserPage: 'home', selected: 0, preview: false, wireless: 'OFF', transferState: 'IDLE', progress: 0,
      files: [
        { id:'preset-demo', name: 'Synth/user.preset', type: 'PRESET', size: '1.3 KB', preview:'SYNTH PRESET / INIT' },
        { id:'settings-json', name: 'System/settings.json', type: 'JSON', size: '0.8 KB', preview:'Creation settings snapshot' },
        { id:'recordings', name: 'Recordings/', type: 'FOLDER', size: 'LOCAL', preview:'Saved Recorder clips' },
        { id:'whofi-session', name: 'WhoFi/session.json', type: 'SIM', size: '2.1 KB', preview:'Simulated CSI session metadata' }
      ]
    },
    communications: {
      page: 'lock', unlocked: false, gesture: [], failures: 0, lockoutUntil: 0,
      section: 'home', draft: '', charIndex: 0, precision: 0, decisionIndex: 0,
      journal: [{ id:'welcome', from: 'LOCAL', text: 'lilLED R1 journal ready', time: '--:--', receipt:'LOCAL' }],
      selected: 0, nearby: 'PAUSED', bridge: 'UNKNOWN', lastBridge: 'No request sent',
      voiceAssetId: '', destination: 'LOCAL', receipt: 'NONE'
    },
    whofi: {
      page: 'home', plot: 'WATERFALL', running: false, connecting: false, frozen: false, rawStream: false,
      phase: 0, records: 0, rejects: 0, drops: 0, rssi: -62, csiRate: 0, channel: 6,
      configured: false, identity: 'UNKNOWN / NO MODEL', cues: true, cueLevel: 70, brightness: 155,
      fixedSpan: false, span: 80, captureName: 'WHOFI_CSI.JSON', detailPage: 0, provider: 'SIM', history: []
    },
    lilmidi: {
      page: 'perform', scene: 'INIT', mode: 'PERFORM', padX: 0.5, padY: 0.5, channel: 1,
      ccX: 74, ccY: 71, mapX: 'CC74', mapY: 'CC71', bridgeUrl: '', bridge: 'OFFLINE', valueX: 64, valueY: 64,
      draftDirty: false, revision: 1, ackRevision: 1, group: 'A', route: 'HOST', focus: 'CHANNEL', scenes: ['INIT','AIR','DUST','DRIVE']
    },
    particles: {
      page: 'world', count: 54, gravity: 0.12, attraction: 0.18, orbitRadius: 42, orbitalDrive: 0.35,
      rebound: 0.82, damping: 0.994, collisions: true, particleRadius: 2, trailLength: 10,
      grid: true, showTarget: true, paused: false, preset: 'ORBIT', padX: 0.5, padY: 0.5, focus: 'ATTRACTION'
    },
    notebook: {
      page: 'home', selected: 0, timerSeconds: 300, timerRemaining: 300, timerRunning: false,
      stopwatchMs: 0, stopwatchRunning: false, calc: '0', calendarOffset: 0, weather: 'PROVIDER OFFLINE',
      rulerMm: 40, accent: 'CYAN', idleDimming: true
    },
    power: { supported: false, level: null, charging: null, chargingTime: null, dischargingTime: null, history: [] },
    camera: { state: 'idle', error: '', facing: 'environment', shots: 0, dirty: false, savedId: '' }
  };
}

function safePattern(pattern, fallback) {
  const names = ['kick', 'snare', 'tom', 'hat'];
  return Object.fromEntries(names.map(name => [name, Array.from({ length: 16 }, (_, i) => pattern?.[name]?.[i] ? 1 : fallback[name][i]) ]));
}

export function normalizeState(raw) {
  const base = createDefaultState();
  if (!raw || typeof raw !== 'object') return base;
  const merged = structuredClone(base);
  for (const key of Object.keys(base)) {
    if (key in raw && typeof base[key] === 'object' && base[key] && !Array.isArray(base[key])) merged[key] = { ...base[key], ...(raw[key] || {}) };
    else if (key in raw) merged[key] = raw[key];
  }
  merged.version = STATE_VERSION;
  const legacyIndex = Number(raw.appIndex ?? raw.screenIndex ?? base.appIndex) || 0;
  merged.appIndex = wrap(legacyIndex, APP_DEFS.length);
  merged.screenIndex = merged.appIndex;
  merged.drawerIndex = wrap(Number(raw.drawerIndex ?? merged.appIndex) || 0, APP_DEFS.length);
  merged.drawerScope = raw.drawerScope === 'labs' ? 'labs' : 'core';
  merged.settings.brightness = clamp(Number(merged.settings.brightness) || 155, 64, 255);
  merged.settings.volume = clamp(Number(merged.settings.volume) || 72, 0, 100);
  merged.settings.pattern = Array.isArray(merged.settings.pattern) && merged.settings.pattern.length >= 4 ? merged.settings.pattern.map(Number) : [...DEFAULT_PATTERN];
  merged.motion.calibration = { ...base.motion.calibration, ...(raw.motion?.calibration || raw.settings?.motionCalibration || {}) };
  merged.rain.manualWind = clamp(Number(merged.rain.manualWind) || 0, -140, 140);
  merged.rain.spawnRate = clamp(Number(merged.rain.spawnRate) || 30, 0, 90);
  merged.rain.fallSpeed = clamp(Number(merged.rain.fallSpeed) || 224, 112, 336);
  merged.rain.targetSpeed = clamp(Number(merged.rain.targetSpeed) || 83, -166, 166);
  merged.rain.targetWidth = clamp(Number(merged.rain.targetWidth) || 46, 32, 100);
  merged.hsv.tilt = clamp(Number(merged.hsv.tilt) || 28, -75, 75);
  merged.hsv.manualTilt = clamp(Number(merged.hsv.manualTilt ?? merged.hsv.tilt) || 28, -75, 75);
  merged.hsv.spin = wrap(Number(merged.hsv.spin) || 40, 360);
  merged.hsv.manualSpin = wrap(Number(merged.hsv.manualSpin ?? merged.hsv.spin) || 40, 360);
  merged.hsv.offset = clamp(Number(merged.hsv.offset) || 0, -1, 1);
  merged.aem.baselineLoad = clamp(Number(merged.aem.baselineLoad ?? merged.aem.load) || 68, 0, 100);
  merged.aem.load = clamp(Number(merged.aem.load) || merged.aem.baselineLoad, 0, 100);
  merged.aem.water = clamp(Number(merged.aem.water) || 68, 0, 100);
  merged.aem.baselineWater = clamp(Number(merged.aem.baselineWater ?? merged.aem.water) || 68, 0, 100);
  merged.aem.effectiveWater = clamp(Number(merged.aem.effectiveWater ?? merged.aem.baselineWater) || merged.aem.baselineWater, 0, 100);
  merged.aem.efficiency = clamp(Number(merged.aem.efficiency ?? merged.aem.hhv) || 77, 40, 100);
  merged.synth.tempo = clamp(Number(merged.synth.tempo) || 110, 40, 240);
  merged.synth.volume = clamp(Number(merged.synth.volume) || 15, 0, 100);
  merged.synth.cutoff = clamp(Number(merged.synth.cutoff) || 3200, 250, 7000);
  merged.synth.resonance = clamp(Number(merged.synth.resonance) || 0.18, 0, 0.9);
  merged.synth.delay = clamp(Number(merged.synth.delay) || 0, 0, 0.55);
  merged.synth.reverb = clamp(Number(merged.synth.reverb) || 0.18, 0, 0.6);
  merged.percussion.energy = clamp(Number(merged.percussion.energy) || 2, 1, 4);
  merged.percussion.groove = clamp(Number(merged.percussion.groove) || 2, 1, 4);
  merged.percussion.volume = clamp(Number(merged.percussion.volume) || 22, 0, 100);
  merged.percussion.bpm = clamp(Number(merged.percussion.bpm) || 110, 40, 240);
  merged.percussion.kit = PERCUSSION_KITS.includes(merged.percussion.kit) ? merged.percussion.kit : 'CIRCUIT';
  merged.percussion.pattern = safePattern(raw.percussion?.pattern, percussionPatternFor(merged.percussion.energy, merged.percussion.groove));
  merged.udaq.sampleRate = [5,10,25].includes(Number(merged.udaq.sampleRate)) ? Number(merged.udaq.sampleRate) : 10;
  merged.udaq.history = [];
  merged.transfer.gesture = [];
  merged.communications.gesture = [];
  merged.whofi.history = [];
  return merged;
}

export function serializePersistentState(state) {
  const copy = structuredClone(state);
  copy.drawerOpen = false;
  copy.statusMessage = '';
  copy.statusUntil = 0;
  copy.interaction = { wheelLabel: '', pointerOwner: '', navigationBlocked: false };
  copy.motion = { ...copy.motion, available:false, source:'SIM', fresh:false, ageMs:0, sequence:0, calibration: state.motion.calibration };
  copy.synth.active = false;
  copy.percussion.playing = false;
  copy.percussion.currentStep = -1;
  copy.percussion.contact = false;
  copy.percussion.stopAtBoundary = false;
  copy.recorder = { ...copy.recorder, state: 'idle', seconds: 0, position: 0, hasClip: Boolean(copy.recorder.savedId), review: Boolean(copy.recorder.savedId), dirty: false, error: '' };
  copy.udaq.history = [];
  copy.udaq.source = 'SIM';
  copy.udaq.sourceAvailable = false;
  copy.udaq.sourceFresh = false;
  copy.whofi.history = [];
  copy.power.history = [];
  copy.camera = { ...copy.camera, state: 'idle', error: '', dirty: false };
  return copy;
}

export function currentApp(state) { return APP_DEFS[wrap(state.appIndex ?? state.screenIndex, APP_DEFS.length)]; }
export const currentScreen = currentApp;
export function nextApp(state, delta) {
  state.appIndex = wrap((state.appIndex ?? state.screenIndex) + delta, APP_DEFS.length);
  state.screenIndex = state.appIndex;
  state.drawerIndex = state.appIndex;
}
export const nextScreen = nextApp;
