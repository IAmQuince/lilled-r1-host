import { midiToFrequency, patternOffset, triggeredMidi } from '../apps/synth/model.js';
import { percussionNextLoopStart, percussionPerformanceVelocity, percussionVariationAt } from '../apps/percussion/model.js';
const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.72;
    this.padVoice = null;
    this.sequenceTimer = null;
    this.sequenceState = null;
    this.nextStepTime = 0;
    this.stepIndex = 0;
    this.arpTimer = null;
    this.arpStep = 0;
    this.nextArpTime = 0;
  }

  async ensure() {
    if (!AudioContextCtor) throw new Error('Web Audio unavailable');
    if (!this.ctx) {
      this.ctx = new AudioContextCtor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  setVolume(value) {
    this.volume = clamp(value, 0, 1);
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  pentatonicFrequency(x, transpose = 0) {
    const degrees = [0, 3, 5, 7, 10];
    const index = clamp(Math.round(x * 19), 0, 19);
    const octave = Math.floor(index / 5);
    const semitone = 48 + octave * 12 + degrees[index % 5] + transpose;
    return 440 * (2 ** ((semitone - 69) / 12));
  }

  async startPadVoice(x, y, options = {}) {
    await this.ensure();
    this.stopPadVoice();
    const now = this.ctx.currentTime;
    const osc = String(options.waveform||'').toUpperCase()==='NOISE'?this.ctx.createBufferSource():this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    const delay = this.ctx.createDelay(0.6);
    const feedback = this.ctx.createGain();
    const waveform = String(options.waveform || 'sine').toLowerCase();
    if(waveform==='noise'){osc.buffer=this.noiseBuffer(1);osc.loop=true;}
    else{osc.type=['sine','square','triangle','sawtooth'].includes(waveform)?waveform:'sine';
      osc.frequency.value=options.frequency??this.pentatonicFrequency(x,Number(options.transpose)||0);}
    filter.type = 'lowpass';
    filter.frequency.value = clamp((options.cutoff ?? 3200) * (0.55 + y), 250, 7000);
    filter.Q.value = clamp((options.resonance ?? 0.18) * 12, 0.1, 11);
    gain.gain.setValueAtTime(0.0001, now);
    const voiceVolume = clamp((options.voiceVolume ?? 15) / 100, 0.0001, 0.35);
    gain.gain.exponentialRampToValueAtTime(voiceVolume, now + 0.012);
    delay.delayTime.value = clamp(options.delay ?? 0, 0, 0.55);
    feedback.gain.value = clamp(options.feedback ?? .28, 0, .85);
    osc.connect(filter); filter.connect(gain); gain.connect(this.master);
    gain.connect(delay); delay.connect(feedback); feedback.connect(delay); delay.connect(this.master);
    osc.start(now);
    this.padVoice = { osc, filter, gain, delay, feedback, transpose: Number(options.transpose) || 0 };
  }

  updatePadVoice(x, y, options = {}) {
    if (!this.padVoice || !this.ctx) return;
    const now = this.ctx.currentTime;
    if(this.padVoice.osc.frequency)this.padVoice.osc.frequency.setTargetAtTime(options.frequency??this.pentatonicFrequency(x,Number(options.transpose??this.padVoice.transpose)||0),now,.01);
    this.padVoice.filter.frequency.setTargetAtTime(clamp((options.cutoff ?? 3200) * (0.55 + y), 250, 7000), now, 0.02);
    this.padVoice.filter.Q.setTargetAtTime(clamp((options.resonance ?? 0.18) * 12, 0.1, 11), now, 0.02);
    this.padVoice.delay.delayTime.setTargetAtTime(clamp(options.delay ?? 0, 0, 0.55), now, 0.03);
    this.padVoice.feedback.gain.setTargetAtTime(clamp(options.feedback??.28,0,.85),now,.03);
  }

  stopPadVoice() {
    if (!this.padVoice || !this.ctx) return;
    const voice = this.padVoice;
    const now = this.ctx.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      voice.osc.stop(now + 0.09);
    } catch { /* already stopped */ }
    this.padVoice = null;
  }

  scheduleSynthNote(midi,when,options={}){
    if(!this.ctx)return;
    const source=String(options.waveform||'SINE').toUpperCase()==='NOISE'?this.ctx.createBufferSource():this.ctx.createOscillator();
    if(source.frequency){source.type=String(options.waveform||'SINE').toLowerCase().replace('saw','sawtooth');source.frequency.value=midiToFrequency(midi);}
    else source.buffer=this.noiseBuffer(.24);
    const filter=this.ctx.createBiquadFilter(),gain=this.ctx.createGain();
    filter.type='lowpass';filter.frequency.value=clamp(options.filterHz??5200,250,7000);
    const level=clamp((options.voiceVolume??15)/100,0,.35);
    gain.gain.setValueAtTime(.0001,when);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0001,level),when+.012);
    gain.gain.exponentialRampToValueAtTime(.0001,when+.2);
    source.connect(filter);filter.connect(gain);gain.connect(this.master);
    source.start(when);source.stop(when+.21);
  }
  async startArp(patchProvider){
    await this.ensure();this.stopArp();this.arpProvider=patchProvider;this.arpStep=0;this.nextArpTime=this.ctx.currentTime+.02;
    this.arpTimer=setInterval(()=>this.scheduleArpAhead(),25);this.scheduleArpAhead();
  }
  scheduleArpAhead(){
    if(!this.arpProvider||!this.ctx)return;
    while(this.nextArpTime<this.ctx.currentTime+.11){
      const {patch,resolved}=this.arpProvider(),span=Math.max(1,resolved.arpSpan)*5;
      const degree=patternOffset(patch.arpDirection==='ALT'?'UPDOWN':patch.arpDirection,this.arpStep,span);
      this.scheduleSynthNote(triggeredMidi(patch,resolved,degree),this.nextArpTime,{...resolved,waveform:patch.waveform,voiceVolume:patch.muted?0:patch.volume*resolved.outputLevel});
      this.nextArpTime+=60/clamp(patch.tempo,40,240)/clamp(resolved.arpRate,1,4);
      this.arpStep++;
    }
  }
  stopArp(){if(this.arpTimer)clearInterval(this.arpTimer);this.arpTimer=null;this.arpProvider=null;}

  noiseBuffer(duration = 0.2) {
    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  scheduleDrum(name, when, gainScale = 1, kit = 'CIRCUIT') {
    if (!this.ctx || !this.master) return;
    if(gainScale<=0)return;
    const level = clamp(gainScale, 0.05, 1.25);
    if (name === 'kick' || name === 'tom') {
      const osc = this.ctx.createOscillator(); const gain = this.ctx.createGain();
      osc.type = kit==='METAL'?'triangle':name==='kick'?'sine':'triangle';
      const tone=kit==='WARM'?.78:kit==='METAL'?1.45:1;
      const startHz=(name==='kick'?150:180)*tone; const endHz=(name==='kick'?45:82)*tone;
      osc.frequency.setValueAtTime(startHz, when); osc.frequency.exponentialRampToValueAtTime(endHz, when + (name === 'kick' ? 0.12 : 0.09));
      gain.gain.setValueAtTime((name === 'kick' ? 0.52 : 0.25) * level, when); gain.gain.exponentialRampToValueAtTime(0.001, when + (name === 'kick' ? 0.19 : 0.15));
      osc.connect(gain); gain.connect(this.master); osc.start(when); osc.stop(when + 0.2); return;
    }
    const source = this.ctx.createBufferSource(); const gain = this.ctx.createGain(); source.buffer = this.noiseBuffer(name === 'snare' ? 0.14 : 0.08);
    if (name === 'hat') {
      const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = kit==='WARM'?4000:kit==='METAL'?8500:6500; source.connect(hp); hp.connect(gain);
      gain.gain.setValueAtTime(0.14 * level, when); gain.gain.exponentialRampToValueAtTime(0.001, when + 0.055);
    } else {
      const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kit==='WARM'?1100:kit==='METAL'?3200:1800; bp.Q.value = kit==='METAL'?1.2:.7; source.connect(bp); bp.connect(gain);
      gain.gain.setValueAtTime(0.28 * level, when); gain.gain.exponentialRampToValueAtTime(0.001, when + 0.13);
    }
    gain.connect(this.master); source.start(when);
  }

  async triggerDrum(name, gainScale = 1, when = null) {
    await this.ensure(); this.scheduleDrum(name, when ?? this.ctx.currentTime, gainScale);
  }

  async startSequencer(pattern, bpm, onStep, gainScale = 1, options = {}) {
    await this.ensure(); this.stopSequencer();
    this.sequenceState = { pattern, bpm, onStep, gainScale,options,globalStep:0,variation:null,variationTarget:Infinity }; this.stepIndex = 0; this.nextStepTime = this.ctx.currentTime + 0.05;
    this.sequenceTimer = setInterval(() => this.scheduleAhead(), 25); this.scheduleAhead();
  }

  updateSequencer(pattern, bpm, gainScale = null, options = null) {
    if (!this.sequenceState) return;
    this.sequenceState.pattern = pattern; this.sequenceState.bpm = bpm;
    if (gainScale != null) this.sequenceState.gainScale = gainScale;
    if (options) this.sequenceState.options={...this.sequenceState.options,...options};
  }

  setPercussionVariation(variation){
    if(!this.sequenceState)return;
    this.sequenceState.variation=variation;
    this.sequenceState.variationTarget=percussionNextLoopStart(this.sequenceState.globalStep);
  }

  scheduleAhead() {
    if (!this.ctx || !this.sequenceState) return;
    while (this.nextStepTime < this.ctx.currentTime + 0.11) {
      const { pattern, bpm, onStep, gainScale,options,globalStep,variation,variationTarget } = this.sequenceState; const step = this.stepIndex;
      const age=globalStep-variationTarget,variationStep=percussionVariationAt(variation,age);
      for(const [index,name] of ['kick','snare','tom','hat'].entries()){
        const bit=1<<index;
        if((variationStep.suppressMask&bit)||!(pattern[name]?.[step]||(variationStep.addMask&bit)))continue;
        const velocity=percussionPerformanceVelocity(name,options.energy??2,options.groove??2,globalStep);
        this.scheduleDrum(name,this.nextStepTime,gainScale*velocity*((variationStep.accentMask&bit)?1.18:1),options.kit);
      }
      const delayMs = Math.max(0, (this.nextStepTime - this.ctx.currentTime) * 1000); setTimeout(() => onStep?.(step,globalStep), delayMs);
      this.nextStepTime += (60 / clamp(bpm, 40, 240)) / 4;
      const maxSteps = Math.max(1, ...Object.values(pattern).map(steps => steps?.length || 0));
      this.stepIndex = (this.stepIndex + 1) % maxSteps;
      this.sequenceState.globalStep++;
    }
  }

  stopSequencer() {
    if (this.sequenceTimer) clearInterval(this.sequenceTimer);
    this.sequenceTimer = null; this.sequenceState = null; this.stepIndex = 0;
  }

  shutdown() { this.stopPadVoice(); this.stopArp(); this.stopSequencer(); }
}
