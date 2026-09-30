export class InteractionRouter {
  constructor() { this.active = null; }
  claim(event, owner, element, { blockNavigation = true } = {}) {
    if (this.active && this.active.pointerId !== event.pointerId) return false;
    element?.setPointerCapture?.(event.pointerId);
    this.active = { pointerId: event.pointerId, owner, element, blockNavigation };
    return true;
  }
  owns(event, owner = null) {
    return Boolean(this.active && this.active.pointerId === event.pointerId && (!owner || this.active.owner === owner));
  }
  release(event) {
    if (!this.active || this.active.pointerId !== event.pointerId) return null;
    const active = this.active;
    this.active = null;
    return active;
  }
  cancel(event) { return this.release(event); }
  blocksNavigation() { return Boolean(this.active?.blockNavigation); }
  owner() { return this.active?.owner || null; }
}
