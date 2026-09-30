const RAD_TO_DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normalizeVector(payload) {
  let raw = payload;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'data' in raw) return normalizeVector(raw.data);
  // The physical R1 probe reports tiltX/Y/Z in g and rawX/Y/Z in m/s².
  // Prefer tilt: it directly tracks the gravity vector for the app models.
  if (raw && typeof raw === 'object' && ['tiltX','tiltY','tiltZ'].every(key => key in raw))
    return normalizeVector([raw.tiltX,raw.tiltY,raw.tiltZ]);
  if (raw && typeof raw === 'object' && ['rawX','rawY','rawZ'].every(key => key in raw)) {
    const metres=normalizeVector([raw.rawX,raw.rawY,raw.rawZ]);
    return metres && {x:metres.x/9.80665,y:metres.y/9.80665,z:metres.z/9.80665};
  }
  const values = Array.isArray(raw) ? raw.slice(0, 3) : [raw?.x, raw?.y, raw?.z];
  if (values.length !== 3 || values.some(v => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)))) return null;
  return { x: Number(values[0]), y: Number(values[1]), z: Number(values[2]) };
}

export function normalizeDeviceMotion(event) {
  const gravity = normalizeVector(event?.accelerationIncludingGravity);
  if (gravity) return { vector: { x: gravity.x / 9.80665, y: gravity.y / 9.80665, z: gravity.z / 9.80665 }, source: 'ACCEL' };
  const linear = normalizeVector(event?.acceleration);
  if (linear) return { vector: { x: linear.x / 9.80665, y: linear.y / 9.80665, z: linear.z / 9.80665 }, source: 'LINEAR' };
  return null;
}

export function deriveMotion(raw, previous = null, calibration = null, now = performance.now()) {
  const vector = normalizeVector(raw);
  if (!vector) throw new TypeError('invalid motion vector');
  const { x, y, z } = vector;
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
    this.source = 'WAIT';
    this.status = 'WAITING FOR FRESH IMU';
    this.rawPayloads = [];
    this.invalidPayloads = 0;
    this.zeroSamples = 0;
    this.firstSampleTimer = null;
  }

  async ensureStarted() {
    if (this.started) return this.available;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.platform.startAccelerometer(data => this.ingest(data, performance.now(), 'R1 TILT'), this.frequency)
      .then(ok => {
        this.started = Boolean(ok);
        if (ok) {
          this.status = 'ACQUIRING FIRST SAMPLE';
          this.firstSampleTimer = setTimeout(() => {
            if (!this.sample) { this.status = 'NO DATA'; this.startFallback(); }
          }, 1000);
        } else this.startFallback();
        return Boolean(ok);
      })
      .catch(() => { this.startFallback(); return false; })
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  startFallback() {
    if (this.source === 'ACCEL' || this.source === 'LINEAR') return;
    this.platform.stopAccelerometer?.();
    const listening = this.platform.startDeviceMotion?.(event => {
      const data = normalizeDeviceMotion(event);
      if (data) this.ingest(data.vector, performance.now(), data.source);
    });
    this.started = Boolean(listening);
    this.status = listening ? 'WAITING FOR DEVICE MOTION' : 'SENSOR NOT AVAILABLE';
  }

  subscribe(owner, handler) {
    this.subscribers.set(owner, handler);
    this.ensureStarted();
    if (this.sample) handler(this.latest());
    return () => this.subscribers.delete(owner);
  }

  ingest(raw, now = performance.now(), source = 'ORIENT') {
    if (this.rawPayloads.length < 5) this.rawPayloads.push({ type: typeof raw, value: raw });
    const vector = normalizeVector(raw);
    if (!vector) { this.invalidPayloads++; this.status = 'INVALID PAYLOAD'; return false; }
    this.zeroSamples = vector.x === 0 && vector.y === 0 && vector.z === 0 ? this.zeroSamples + 1 : 0;
    if (this.zeroSamples >= 20) { this.status = 'ZERO STREAM'; return false; }
    this.sample = deriveMotion(vector, this.sample, this.calibration, now);
    this.sample.source = source;
    this.source = source;
    this.available = true;
    this.status = 'LIVE';
    if (this.firstSampleTimer) { clearTimeout(this.firstSampleTimer); this.firstSampleTimer = null; }
    const latest = this.latest(now);
    for (const handler of this.subscribers.values()) {
      try { handler(latest); } catch (error) { console.error('sensor subscriber', error); }
    }
    return true;
  }

  latest(now = performance.now()) {
    if (!this.sample) return null;
    const copy = structuredClone(this.sample);
    copy.status.ageMs = Math.max(0, now - copy.timestamp);
    copy.status.fresh = copy.status.ageMs <= 200;
    copy.status.calibrated = this.calibration.valid;
    copy.status.source = this.source;
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
    if (this.firstSampleTimer) clearTimeout(this.firstSampleTimer);
    this.firstSampleTimer = null;
    await this.platform.stopAccelerometer();
    this.platform.stopDeviceMotion?.();
    this.started = false;
    this.available = false;
    this.sample = null;
    this.source = 'WAIT';
    this.status = 'WAITING FOR FRESH IMU';
  }
}
