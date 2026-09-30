function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeBase64Utf8(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class R1Platform {
  constructor() {
    this.handlers = new Map();
    this.messageHandlers = new Set();
    this.accelStop = null;
    this.keyboardDown = new Set();
    this.capabilities = this.detectCapabilities();
    this.installEvents();
  }

  detectCapabilities() {
    return {
      r1Bridge: Boolean(window.PluginMessageHandler || window.creationStorage || window.creationSensors),
      pluginMessages: Boolean(window.PluginMessageHandler?.postMessage),
      closeWebView: Boolean(window.closeWebView?.postMessage),
      creationStorage: Boolean(window.creationStorage?.plain),
      accelerometer: Boolean(window.creationSensors?.accelerometer),
      microphone: Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder),
      webAudio: Boolean(window.AudioContext || window.webkitAudioContext),
      camera: Boolean(navigator.mediaDevices?.getUserMedia),
      battery: Boolean(navigator.getBattery),
      webSocket: Boolean(window.WebSocket),
      emulatorFrame: window.parent !== window
    };
  }

  environmentLabel() {
    if (this.capabilities.r1Bridge && this.capabilities.emulatorFrame) return 'EMU';
    if (this.capabilities.r1Bridge) return 'R1';
    return 'WEB';
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }
  emit(type, payload) { for (const handler of this.handlers.get(type) || []) handler(payload); }

  installEvents() {
    window.addEventListener('scrollUp', () => this.emit('wheel', -1));
    window.addEventListener('scrollDown', () => this.emit('wheel', 1));
    window.addEventListener('sideClick', () => this.emit('sideClick'));
    window.addEventListener('longPressStart', () => this.emit('sideHoldStart'));
    window.addEventListener('longPressEnd', () => this.emit('sideHoldEnd'));

    window.addEventListener('keydown', (event) => {
      if (event.repeat && event.code === 'Space') return;
      if (['ArrowUp', 'ArrowDown', 'Space'].includes(event.code)) event.preventDefault();
      if (event.code === 'ArrowUp') this.emit('wheel', -1);
      if (event.code === 'ArrowDown') this.emit('wheel', 1);
      if (event.code === 'Space' && !this.keyboardDown.has('Space')) this.emit('sideHoldStart');
      if (event.code === 'KeyA') this.emit('apps');
      if (event.code === 'KeyN') this.emit('next');
      this.keyboardDown.add(event.code);
    });
    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space' && this.keyboardDown.has('Space')) this.emit('sideHoldEnd');
      this.keyboardDown.delete(event.code);
    });

    const previous = window.onPluginMessage;
    window.onPluginMessage = (data) => {
      try { if (typeof previous === 'function') previous(data); } catch { /* preserve app */ }
      for (const handler of this.messageHandlers) handler(data);
    };
  }

  async saveJson(key, value) {
    const text = JSON.stringify(value);
    if (window.creationStorage?.plain?.setItem) {
      await window.creationStorage.plain.setItem(key, encodeBase64Utf8(text));
      return 'r1';
    }
    localStorage.setItem(`lilled-r1:${key}`, text);
    return 'local';
  }

  async loadJson(key) {
    try {
      if (window.creationStorage?.plain?.getItem) {
        const raw = await window.creationStorage.plain.getItem(key);
        if (!raw) return null;
        return JSON.parse(decodeBase64Utf8(raw));
      }
      const raw = localStorage.getItem(`lilled-r1:${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      this.emit('diagnostic', { level: 'error', source: 'storage', message: error.message });
      return null;
    }
  }

  async deleteJson(key) {
    if(window.creationStorage?.plain?.removeItem)await window.creationStorage.plain.removeItem(key);
    else if(window.creationStorage?.plain?.setItem)await window.creationStorage.plain.setItem(key,'');
    localStorage.removeItem(`lilled-r1:${key}`);
  }

  credentialStore() {
    const secure=window.creationStorage?.secure,plain=window.creationStorage?.plain;
    if(secure?.getItem&&secure?.setItem)return secure;
    if(plain?.getItem&&plain?.setItem)return plain;
    return null;
  }
  async loadCredential() {
    const key='lilled_r1_pattern_v4',store=this.credentialStore();
    if(store?.getItem){
      const raw=await store.getItem(key);
      return raw?JSON.parse(decodeBase64Utf8(raw)):null;
    }
    const raw=localStorage.getItem(`lilled-r1:${key}`);
    return raw?JSON.parse(raw):null;
  }
  async saveCredential(value) {
    const key='lilled_r1_pattern_v4',store=this.credentialStore();
    if(store?.setItem){await store.setItem(key,encodeBase64Utf8(JSON.stringify(value)));return;}
    localStorage.setItem(`lilled-r1:${key}`,JSON.stringify(value));
  }
  async deleteCredential() {
    const key='lilled_r1_pattern_v4',store=this.credentialStore();
    if(store?.removeItem)await store.removeItem(key);
    else if(store?.setItem)await store.setItem(key,'');
    localStorage.removeItem(`lilled-r1:${key}`);
  }

  sendMessage(message, options = {}) {
    if (!window.PluginMessageHandler?.postMessage) throw new Error('Rabbit plugin message bridge is unavailable');
    const payload = { message, ...options };
    window.PluginMessageHandler.postMessage(JSON.stringify(payload));
  }

  onPluginMessage(handler) { this.messageHandlers.add(handler); return () => this.messageHandlers.delete(handler); }

  async startAccelerometer(callback, frequency = 30) {
    await this.stopAccelerometer();
    const sensor = window.creationSensors?.accelerometer;
    if (!sensor?.start) return false;
    if (sensor.isAvailable) {
      try {
        const available = await Promise.race([
          Promise.resolve(sensor.isAvailable()),
          new Promise((_, reject) => setTimeout(() => reject(new Error('availability timeout')), 1500))
        ]);
        if (available === false) return false;
      } catch { /* availability timeout/error does not prove start() cannot work */ }
    }
    sensor.start(callback, { frequency });
    this.accelStop = () => sensor.stop?.();
    return true;
  }

  async stopAccelerometer() {
    try { this.accelStop?.(); } catch { /* best effort */ }
    this.accelStop = null;
  }

  startDeviceMotion(callback) {
    if (!window.addEventListener || !('DeviceMotionEvent' in window)) return false;
    this.deviceMotionHandler = event => callback(event);
    window.addEventListener('devicemotion', this.deviceMotionHandler);
    return true;
  }
  stopDeviceMotion() {
    if (this.deviceMotionHandler) window.removeEventListener('devicemotion', this.deviceMotionHandler);
    this.deviceMotionHandler = null;
  }

  closeCreation() {
    if (window.closeWebView?.postMessage) window.closeWebView.postMessage('');
    else this.emit('diagnostic', { level: 'info', source: 'shell', message: 'closeWebView unavailable outside R1' });
  }
}
