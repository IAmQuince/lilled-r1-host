export class NavigationGuard {
  constructor() { this.reasons = new Map(); }
  set(key, active, reason = '') {
    if (active) this.reasons.set(key, reason || key);
    else this.reasons.delete(key);
  }
  blocked() { return this.reasons.size > 0; }
  reason() { return this.reasons.values().next().value || ''; }
  snapshot() { return [...this.reasons.entries()].map(([key, reason]) => ({ key, reason })); }
}
