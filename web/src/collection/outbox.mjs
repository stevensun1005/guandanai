export function indexedStore(indexedDB) {
  let opening;
  const database = () =>
    (opening ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('guandan-human-games', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('pending', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  const run = async (mode, method, value) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending', mode),
        r = tx.objectStore('pending')[method](value);
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = tx.onabort = () => reject(tx.error || Error('outbox_unavailable'));
    });
  };
  return {
    list: () => run('readonly', 'getAll'),
    put: (entry) => run('readwrite', 'put', entry),
    remove: (id) => run('readwrite', 'delete', id),
  };
}

export class UploadQueue {
  constructor({
    store,
    endpoint,
    fetcher = (...args) => globalThis.fetch(...args),
    onStatus = () => {},
  }) {
    Object.assign(this, { store, endpoint, fetcher, onStatus });
    this.memory = new Map();
    this.busy = false;
    this.storageFailed = false;
    this.saved = 0;
  }
  async enqueue(payload) {
    const entry = { id: payload.id, payload, attempts: 0, nextAttempt: 0 };
    this.memory.set(entry.id, entry);
    try {
      await this.store.put(entry);
    } catch {
      this.storageFailed = true;
    }
    this.onStatus({ pending: this.memory.size, storageFailed: this.storageFailed });
    await this.flush();
  }
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      try {
        for (const entry of await this.store.list())
          if (!this.memory.has(entry.id)) this.memory.set(entry.id, entry);
      } catch {
        this.storageFailed = true;
      }
      if (!this.endpoint) return;
      for (const entry of this.memory.values()) {
        if (entry.nextAttempt > Date.now()) continue;
        try {
          const response = await this.fetcher(this.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry.payload),
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw Error('upload_failed');
          const receipt = await response.json();
          if (receipt.id !== entry.id || receipt.stored !== true) throw Error('invalid_receipt');
          // Remove only after the server confirms durable storage (duplicates have the same receipt).
          try {
            await this.store.remove(entry.id);
          } catch {
            this.storageFailed = true;
          }
          this.memory.delete(entry.id);
          this.saved++;
        } catch {
          entry.attempts++;
          entry.nextAttempt =
            Date.now() + Math.min(3600000, 5000 * 2 ** Math.min(10, entry.attempts));
          try {
            await this.store.put(entry);
          } catch {
            this.storageFailed = true;
          }
        }
      }
    } finally {
      this.busy = false;
      this.onStatus({
        pending: this.memory.size,
        storageFailed: this.storageFailed,
        saved: this.saved,
      });
    }
  }
}
