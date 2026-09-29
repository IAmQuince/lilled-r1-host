export const TRACE_VIEWS = Object.freeze({
  XYZ: ['x','y','z'], ALL: ['m','x','y','z'],
  'XY|A|': ['m','x','y'], 'XZ|A|': ['m','x','z'], 'YZ|A|': ['m','y','z'],
  AX: ['x'], AY: ['y'], AZ: ['z'], '|A|': ['m']
});

export function plotRange(samples, channels) {
  let low = 0, high = 0;
  for (const sample of samples) for (const key of channels) {
    const value = sample[key];
    if (!Number.isFinite(value)) continue;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const spread = high - low;
  const pad = Math.max(0.08, spread * 0.08);
  return { min: low - pad, max: high + pad };
}

export function visibleSamples(history, count = 300) {
  return history.slice(-count).filter(s => Number.isFinite(s.t));
}
