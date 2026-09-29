export class InputFocus {
  constructor() { this.byApp = new Map(); }
  set(appId, descriptor) { this.byApp.set(appId, { ...descriptor }); return this.byApp.get(appId); }
  get(appId) { return this.byApp.get(appId) || null; }
  clear(appId) { this.byApp.delete(appId); }
  adjust(appId, direction) {
    const target = this.get(appId);
    if (!target?.adjust) return false;
    target.adjust(direction);
    return true;
  }
}
