const RAD_TO_DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function deriveMotion(raw, previous = null, calibration = null, now = performance.now()) {
  const x = Number(raw?.x) || 0;
  const y = Number(raw?.y) || 0;
  const z = Number(raw?.z) || 0;
  const alpha = 0.22;
  const fx = previous ? previous.filtered.x + alpha * (x - previous.filtered.x) : x;
  const fy = previous ? previous.filtered.y + alpha * (y - previous.filtered.y) : y;
  const fz = previous ? previous.filtered.z + alpha * (z - previous.filtered.z) : z;
  const magnitudeG = Math.hypot(fx, fy, fz);
  const pitchAbs = Math.atan2(fy, Math.sqrt(fx * fx + fz * fz)) * RAD_TO_DEG;
  const rollAbs = Math.atan2(fx, Math.sqrt(fy * fy + fz * fz)) * RAD_TO_DEG;
  const centerPitch = calibration?.pitch || 0;
  const centerRoll = calibration?.roll || 0;
  const dt = previous ? Math.max(0.001, (now - previous.timestamp) / 1000) : 0.033;
  const jerk = previous ? Math.hypot(fx - previous.filtered.x, fy - previous.filtered.y, fz - previous.filtered.z) / dt : 0;
  const validGravity = magnitudeG >= 0.75 && magnitudeG <= 1.25;
  return {
    timestamp: now,
    sequence: (previous?.sequence || 0) + 1,
    raw: { x, y, z },
    filtered: { x: fx, y: fy, z: fz },
    magnitudeG,
    attitude: {
      pitch: pitchAbs - centerPitch,
      roll: rollAbs - centerRoll,
      absolutePitch: pitchAbs,
      absoluteRoll: rollAbs
    },
    motion: {
      jerk,
      moving: jerk > 0.45,
      shake: jerk > 2.8
    },
    status: {
      validGravity,
      fresh: true,
      calibrated: Boolean(calibration?.valid),
      ageMs: 0
    }
  };
}

export class SensorHub {
  constructor(platform, { frequency = 30 } = {}) {
    this.platform = platform;
    this.frequency = frequency;
    this.subscribers = new Map();
    this.sample = null;
    this.calibration = { valid: false, pitch: 0, roll: 0, generation: 0 };
    this.started = false;
    this.available = false;
    this.startPromise = null;
  }

  async ensureStarted() {
    if (this.started) return this.available;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.platform.startAccelerometer(data => this.ingest(data), this.frequency)
      .then(ok => {
        this.available = Boolean(ok);
        this.started = Boolean(ok);
        return this.available;
      })
      .catch(() => false)
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  subscribe(owner, handler) {
    this.subscribers.set(owner, handler);
    this.ensureStarted();
    if (this.sample) handler(this.latest());
    return () => this.subscribers.delete(owner);
  }

  ingest(raw, now = performance.now()) {
    this.sample = deriveMotion(raw, this.sample, this.calibration, now);
    const latest = this.latest(now);
    for (const handler of this.subscribers.values()) {
      try { handler(latest); } catch (error) { console.error('sensor subscriber', error); }
    }
  }

  latest(now = performance.now()) {
    if (!this.sample) return null;
    const copy = structuredClone(this.sample);
    copy.status.ageMs = Math.max(0, now - copy.timestamp);
    copy.status.fresh = copy.status.ageMs <= 200;
    copy.status.calibrated = this.calibration.valid;
    return copy;
  }

  center() {
    if (!this.sample) return false;
    this.calibration = {
      valid: true,
      pitch: this.sample.attitude.absolutePitch,
      roll: this.sample.attitude.absoluteRoll,
      generation: this.calibration.generation + 1
    };
    // Recalculate immediately so users see zeroed coordinates without waiting.
    this.sample = deriveMotion(this.sample.raw, null, this.calibration, performance.now());
    return true;
  }

  setCalibration(calibration = {}) {
    this.calibration = {
      valid: Boolean(calibration.valid),
      pitch: clamp(Number(calibration.pitch) || 0, -180, 180),
      roll: clamp(Number(calibration.roll) || 0, -180, 180),
      generation: Math.max(0, Number(calibration.generation) || 0)
    };
  }

  exportCalibration() { return { ...this.calibration }; }

  async stop() {
    this.subscribers.clear();
    await this.platform.stopAccelerometer();
    this.started = false;
    this.available = false;
  }
}
