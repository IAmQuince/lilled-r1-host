export const CORE_APP_DEFS = Object.freeze([
  { id: 'rain', title: 'Rain', referenceTitle: 'Rain Lab', short: 'RAIN', accent: 'water', fidelity: 'ADAPTED', source: 'apps/rain/legacy/presentations/touch-portrait-368x448/rain_simulator.cpp' },
  { id: 'hsv', title: 'HSV', referenceTitle: 'HSV Lab', short: 'HSV', accent: 'violet', fidelity: 'ADAPTED', source: 'apps/hsv/presentations/touch-portrait-368x448/hsv_simulator.cpp' },
  { id: 'aem', title: 'AEM', referenceTitle: 'AEM Lab', short: 'AEM', accent: 'hydrogen', fidelity: 'ADAPTED', source: 'apps/aem/presentations/touch-portrait-368x448/aem_simulator.cpp' },
  { id: 'synth', title: 'Synth', referenceTitle: 'Synthesizer', short: 'SYNTH', accent: 'cyan', fidelity: 'ADAPTED', source: 'apps/synth/presentations/touch-portrait-368x448/synthesizer.cpp' },
  { id: 'percussion', title: 'Percussion', referenceTitle: 'Percussion', short: 'PERC', accent: 'cyan', fidelity: 'ADAPTED', source: 'apps/percussion/presentations/touch-portrait-368x448/percussion.cpp' },
  { id: 'recorder', title: 'Recorder', referenceTitle: 'Recorder', short: 'RECORD', accent: 'red', fidelity: 'ADAPTED', source: 'apps/recorder/presentations/touch-portrait-368x448/recorder_screen.cpp' },
  { id: 'udaq', title: 'uDAQ', referenceTitle: 'uDAQ', short: 'uDAQ', accent: 'green', fidelity: 'REAL', source: 'apps/udaq/presentations/touch-portrait-368x448/udaq.cpp' },
  { id: 'settings', title: 'Settings', referenceTitle: 'Settings', short: 'SETTINGS', accent: 'gold', fidelity: 'ADAPTED', source: 'apps/settings/presentations/touch-portrait-368x448/settings_presentation.cpp' },
  { id: 'transfer', title: 'Transfer', referenceTitle: 'Transfer', short: 'FILES', accent: 'cyan', fidelity: 'ADAPTED', source: 'apps/transfer/presentations/touch-portrait-368x448/transfer_screen.cpp' },
  { id: 'communications', title: 'Communications', referenceTitle: 'Communications', short: 'MESSAGING', accent: 'green', fidelity: 'ADAPTED', source: 'apps/communications/presentations/touch-portrait-368x448/communications_screen.cpp' },
  { id: 'whofi', title: 'WhoFi', referenceTitle: 'WhoFi CSI', short: 'WHOFI', accent: 'amber', fidelity: 'SIMULATED', source: 'apps/whofi/presentations/touch-portrait-368x448/whofi_screen.cpp' }
]);

// These exist in the supplied repository but are not members of the 11-screen
// 29957 lilLED composition. They are exposed under LABS so the workbench does
// not silently omit useful reference workstreams or misrepresent provenance.
export const LAB_APP_DEFS = Object.freeze([
  { id: 'lilmidi', title: 'lilMIDI', referenceTitle: 'lilMIDI 29957', short: 'MIDI', accent: 'violet', fidelity: 'ADAPTED', source: 'apps/lilmidi/' },
  { id: 'particles', title: 'Particles', referenceTitle: 'Particles', short: 'PARTICLES', accent: 'cyan', fidelity: 'REAL', source: 'apps/particles/' },
  { id: 'notebook', title: 'Notebook', referenceTitle: 'Notebook', short: 'NOTEBOOK', accent: 'gold', fidelity: 'ADAPTED', source: 'apps/notebook/' },
  { id: 'power', title: 'Power', referenceTitle: 'Power', short: 'POWER', accent: 'green', fidelity: 'REAL', source: 'apps/power/' },
  { id: 'camera', title: 'Camera', referenceTitle: 'Camera', short: 'CAMERA', accent: 'violet', fidelity: 'ADAPTED', source: 'apps/camera/' }
]);

export const APP_DEFS = Object.freeze([...CORE_APP_DEFS, ...LAB_APP_DEFS]);
export const CORE_APP_COUNT = CORE_APP_DEFS.length;

export const FIDELITY_LABELS = Object.freeze({
  REAL: 'Uses a real browser/R1 capability when available; no fabricated success state.',
  ADAPTED: 'Preserves the reference workflow/state model but substitutes a RabbitOS Creation-safe implementation.',
  SIMULATED: 'Reference presentation/state is modeled, but the underlying 29957 hardware capability is unavailable to a normal Creation.'
});

export const PERCUSSION_VOICES = Object.freeze(['kick', 'snare', 'tom', 'hat']);
export const PERCUSSION_KITS = Object.freeze(['CIRCUIT', 'WARM', 'METAL']);
export const PERCUSSION_PATTERN_MASKS = Object.freeze({
  kick: Object.freeze([0x0101, 0x1111, 0x5115, 0x5555]),
  snare: Object.freeze([0x1010, 0x1010, 0x1210, 0x5250]),
  tom: Object.freeze([0x0400, 0x4408, 0x4C88, 0xCC99]),
  hat: Object.freeze([0x4444, 0x5555, 0xDDDD, 0xFFFF])
});

export function maskToSteps(mask) {
  return Array.from({ length: 16 }, (_, index) => (mask & (1 << index)) ? 1 : 0);
}

export function percussionVoiceDensity(voice, energy, groove) {
  const bound = value => Math.max(1, Math.min(4, value));
  const e = bound(energy); const g = bound(groove);
  if (voice === 'kick') return bound(e + (g === 1 ? 1 : g === 4 ? -1 : 0));
  if (voice === 'snare') {
    let density = e + (g === 1 ? -1 : 0);
    if (g !== 3 && density > 3) density = 3;
    return bound(density);
  }
  if (voice === 'tom') return bound(e + ((g === 2 || g === 4) ? -1 : 0));
  if (voice === 'hat') return bound(e + (g === 4 ? 1 : g === 1 ? -2 : 0));
  return e;
}

export function rotate16(mask, steps) {
  const shift = steps & 0x0F;
  if (!shift) return mask & 0xFFFF;
  return ((mask << shift) | (mask >>> (16 - shift))) & 0xFFFF;
}

export function percussionPerformanceMask(voice, energy, groove) {
  const density = percussionVoiceDensity(voice, energy, groove);
  let mask = PERCUSSION_PATTERN_MASKS[voice][density - 1];
  if (voice === 'tom' && groove >= 3) mask = rotate16(mask, groove === 3 ? 2 : 1);
  if (voice === 'hat' && groove === 3) mask = rotate16(mask, 1);
  return mask;
}

export function percussionPatternFor(energy, groove) {
  return Object.fromEntries(PERCUSSION_VOICES.map(voice => [voice, maskToSteps(percussionPerformanceMask(voice, energy, groove))]));
}
