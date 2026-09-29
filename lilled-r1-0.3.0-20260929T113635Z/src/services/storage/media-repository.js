export class MediaRepository {
  constructor(name = 'lilled-r1-media-v1') { this.name = name; this.memory = new Map(); }
  async db() {
    if (!globalThis.indexedDB) return null;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async put(record) {
    const item = { ...record, id: record.id || crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, updatedAt: Date.now() };
    const db = await this.db().catch(() => null);
    if (!db) { this.memory.set(item.id, item); return item; }
    await new Promise((resolve, reject) => { const tx = db.transaction('media', 'readwrite'); tx.objectStore('media').put(item); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close(); return item;
  }
  async get(id) {
    const db = await this.db().catch(() => null);
    if (!db) return this.memory.get(id) || null;
    const item = await new Promise((resolve, reject) => { const tx = db.transaction('media'); const req = tx.objectStore('media').get(id); req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error); });
    db.close(); return item;
  }
  async list() {
    const db = await this.db().catch(() => null);
    if (!db) return [...this.memory.values()].sort((a,b) => b.updatedAt-a.updatedAt);
    const items = await new Promise((resolve, reject) => { const tx = db.transaction('media'); const req = tx.objectStore('media').getAll(); req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error); });
    db.close(); return items.sort((a,b) => b.updatedAt-a.updatedAt);
  }
  async remove(id) {
    const db = await this.db().catch(() => null);
    if (!db) return this.memory.delete(id);
    await new Promise((resolve, reject) => { const tx = db.transaction('media', 'readwrite'); tx.objectStore('media').delete(id); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close(); return true;
  }
}
