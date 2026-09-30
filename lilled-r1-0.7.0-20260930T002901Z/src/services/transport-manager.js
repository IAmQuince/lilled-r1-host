export class TransportManager {
  constructor() { this.socket = null; this.status = 'OFFLINE'; this.url = ''; this.listeners = new Set(); }
  notify(payload) { for (const listener of this.listeners) listener(payload); }
  onMessage(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  connect(url) {
    this.disconnect(); this.url = url || '';
    if (!url || !globalThis.WebSocket) { this.status = 'OFFLINE'; return false; }
    try {
      this.status = 'CONNECTING';
      this.socket = new WebSocket(url);
      this.socket.addEventListener('open', () => { this.status = 'ONLINE'; this.notify({ type:'status', status:this.status }); });
      this.socket.addEventListener('message', event => this.notify({ type:'message', data:event.data }));
      this.socket.addEventListener('close', () => { this.status = 'OFFLINE'; this.notify({ type:'status', status:this.status }); });
      this.socket.addEventListener('error', () => { this.status = 'ERROR'; this.notify({ type:'status', status:this.status }); });
      return true;
    } catch { this.status = 'ERROR'; return false; }
  }
  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message)); return true;
  }
  disconnect() { try { this.socket?.close(); } catch {} this.socket = null; this.status = 'OFFLINE'; }
}
