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
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    const delay = this.ctx.createDelay(0.6);
    const feedback = this.ctx.createGain();
    const waveform = String(options.waveform || 'sine').toLowerCase();
    osc.type = ['sine','square','triangle','sawtooth'].includes(waveform) ? waveform : 'sine';
    osc.frequency.value = this.pentatonicFrequency(x, Number(options.transpose) || 0);
    filter.type = 'lowpass';
    filter.frequency.value = clamp((options.cutoff ?? 3200) * (0.55 + y), 250, 7000);
    filter.Q.value = clamp((options.resonance ?? 0.18) * 12, 0.1, 11);
    gain.gain.setValueAtTime(0.0001, now);
    const voiceVolume = clamp((options.voiceVolume ?? 15) / 100, 0.01, 0.35);
    gain.gain.exponentialRampToValueAtTime(voiceVolume, now + 0.012);
    delay.delayTime.value = clamp(options.delay ?? 0, 0, 0.55);
    feedback.gain.value = clamp(0.16 + (options.reverb ?? 0.18) * 0.45, 0.05, 0.42);
    osc.connect(filter); filter.connect(gain); gain.connect(this.master);
    gain.connect(delay); delay.connect(feedback); feedback.connect(delay); delay.connect(this.master);
    osc.start(now);
    this.padVoice = { osc, filter, gain, delay, feedback, transpose: Number(options.transpose) || 0 };
  }

  updatePadVoice(x, y, options = {}) {
    if (!this.padVoice || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.padVoice.osc.frequency.setTargetAtTime(this.pentatonicFrequency(x, Number(options.transpose ?? this.padVoice.transpose) || 0), now, 0.01);
    this.padVoice.filter.frequency.setTargetAtTime(clamp((options.cutoff ?? 3200) * (0.55 + y), 250, 7000), now, 0.02);
    this.padVoice.filter.Q.setTargetAtTime(clamp((options.resonance ?? 0.18) * 12, 0.1, 11), now, 0.02);
    this.padVoice.delay.delayTime.setTargetAtTime(clamp(options.delay ?? 0, 0, 0.55), now, 0.03);
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

  noiseBuffer(duration = 0.2) {
    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  scheduleDrum(name, when, gainScale = 1) {
    if (!this.ctx || !this.master) return;
    const level = clamp(gainScale, 0.05, 1.25);
    if (name === 'kick' || name === 'tom') {
      const osc = this.ctx.createOscillator(); const gain = this.ctx.createGain();
      osc.type = name === 'kick' ? 'sine' : 'triangle';
      const startHz = name === 'kick' ? 150 : 180; const endHz = name === 'kick' ? 45 : 82;
      osc.frequency.setValueAtTime(startHz, when); osc.frequency.exponentialRampToValueAtTime(endHz, when + (name === 'kick' ? 0.12 : 0.09));
      gain.gain.setValueAtTime((name === 'kick' ? 0.52 : 0.25) * level, when); gain.gain.exponentialRampToValueAtTime(0.001, when + (name === 'kick' ? 0.19 : 0.15));
      osc.connect(gain); gain.connect(this.master); osc.start(when); osc.stop(when + 0.2); return;
    }
    const source = this.ctx.createBufferSource(); const gain = this.ctx.createGain(); source.buffer = this.noiseBuffer(name === 'snare' ? 0.14 : 0.08);
    if (name === 'hat') {
      const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500; source.connect(hp); hp.connect(gain);
      gain.gain.setValueAtTime(0.14 * level, when); gain.gain.exponentialRampToValueAtTime(0.001, when + 0.055);
    } else {
      const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7; source.connect(bp); bp.connect(gain);
      gain.gain.setValueAtTime(0.28 * level, when); gain.gain.exponentialRampToValueAtTime(0.001, when + 0.13);
    }
    gain.connect(this.master); source.start(when);
  }

  async triggerDrum(name, gainScale = 1, when = null) {
    await this.ensure(); this.scheduleDrum(name, when ?? this.ctx.currentTime, gainScale);
  }

  async startSequencer(pattern, bpm, onStep, gainScale = 1) {
    await this.ensure(); this.stopSequencer();
    this.sequenceState = { pattern, bpm, onStep, gainScale }; this.stepIndex = 0; this.nextStepTime = this.ctx.currentTime + 0.05;
    this.sequenceTimer = setInterval(() => this.scheduleAhead(), 25); this.scheduleAhead();
  }

  updateSequencer(pattern, bpm, gainScale = null) {
    if (!this.sequenceState) return;
    this.sequenceState.pattern = pattern; this.sequenceState.bpm = bpm;
    if (gainScale != null) this.sequenceState.gainScale = gainScale;
  }

  scheduleAhead() {
    if (!this.ctx || !this.sequenceState) return;
    while (this.nextStepTime < this.ctx.currentTime + 0.11) {
      const { pattern, bpm, onStep, gainScale } = this.sequenceState; const step = this.stepIndex;
      for (const [name, steps] of Object.entries(pattern)) if (steps?.[step]) this.scheduleDrum(name, this.nextStepTime, gainScale);
      const delayMs = Math.max(0, (this.nextStepTime - this.ctx.currentTime) * 1000); setTimeout(() => onStep?.(step), delayMs);
      this.nextStepTime += (60 / clamp(bpm, 40, 240)) / 4;
      const maxSteps = Math.max(1, ...Object.values(pattern).map(steps => steps?.length || 0));
      this.stepIndex = (this.stepIndex + 1) % maxSteps;
    }
  }

  stopSequencer() {
    if (this.sequenceTimer) clearInterval(this.sequenceTimer);
    this.sequenceTimer = null; this.sequenceState = null; this.stepIndex = 0;
  }

  shutdown() { this.stopPadVoice(); this.stopSequencer(); }
}
