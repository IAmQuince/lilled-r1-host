export const DEFAULT_PATTERN = Object.freeze([0, 1, 2, 5, 8]);
export const samePattern = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export class PatternService {
  constructor(settingsState) { this.settings = settingsState; }
  pattern() { return Array.isArray(this.settings.pattern) && this.settings.pattern.length >= 4 ? this.settings.pattern : [...DEFAULT_PATTERN]; }
  enroll(candidate) {
    if (!Array.isArray(candidate) || candidate.length < 4) return { ok: false, reason: 'PATTERN TOO SHORT' };
    this.settings.pattern = [...candidate];
    this.settings.patternEnrolled = true;
    return { ok: true, reason: 'PATTERN SAVED' };
  }
  verify(candidate, areaState, now = Date.now()) {
    if (areaState.lockoutUntil > now) return { ok: false, reason: 'LOCKED OUT' };
    if (!this.settings.patternEnrolled) return { ok: false, reason: 'PATTERN NOT ENROLLED' };
    if (candidate.length < 4) return { ok: false, reason: 'PATTERN TOO SHORT' };
    if (samePattern(candidate, this.pattern())) {
      areaState.failures = 0;
      return { ok: true, reason: 'ACCEPTED' };
    }
    areaState.failures = (areaState.failures || 0) + 1;
    if (areaState.failures >= 3) {
      areaState.lockoutUntil = now + 5 * 60 * 1000;
      return { ok: false, reason: 'LOCKED OUT · 5 MIN' };
    }
    return { ok: false, reason: 'NO MATCH / RETRY' };
  }
}
