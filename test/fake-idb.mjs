/* Мини-IndexedDB для тестов и tools/check-archive.mjs (в Node нет настоящего IDB).
   Поддерживает то, что использует MashaMemory: open/upgrade, createObjectStore,
   createIndex, transaction, add/put/get/getAll/count/clear, openCursor, IDBKeyRange. */

class KeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower === undefined ? null : lower;
    this.upper = upper === undefined ? null : upper;
    this.lowerOpen = !!lowerOpen;
    this.upperOpen = !!upperOpen;
  }
  includes(key) {
    if (this.lower !== null) {
      if (key < this.lower) return false;
      if (this.lowerOpen && key === this.lower) return false;
    }
    if (this.upper !== null) {
      if (key > this.upper) return false;
      if (this.upperOpen && key === this.upper) return false;
    }
    return true;
  }
  static lowerBound(value, open) { return new KeyRange(value, undefined, open, false); }
  static upperBound(value, open) { return new KeyRange(undefined, value, false, open); }
  static bound(lower, upper, lowerOpen, upperOpen) { return new KeyRange(lower, upper, lowerOpen, upperOpen); }
  static only(value) { return new KeyRange(value, value, false, false); }
}

function cmp(a, b) {
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
  _succeed(value) {
    this.result = value;
    queueMicrotask(() => { if (this.onsuccess) this.onsuccess({ target: this }); });
  }
  _fail(err) {
    this.error = err;
    queueMicrotask(() => { if (this.onerror) this.onerror({ target: this }); });
  }
}

class FakeIndex {
  constructor(store, name, keyPath) {
    this.store = store;
    this.name = name;
    this.keyPath = keyPath;
  }
  _values() {
    return this.store._all();
  }
  getAll(query) {
    const req = new FakeRequest();
    let out = this._values().filter(v => v && v[this.keyPath] !== undefined);
    if (Array.isArray(query)) {
      const set = new Set(query);
      out = out.filter(v => set.has(v[this.keyPath]));
    } else if (query instanceof KeyRange) {
      out = out.filter(v => query.includes(v[this.keyPath]));
    } else if (query !== undefined && query !== null) {
      out = out.filter(v => cmp(v[this.keyPath], query) === 0);
    }
    out.sort((a, b) => cmp(a[this.keyPath], b[this.keyPath]));
    req._succeed(out);
    return req;
  }
  openCursor(query, direction) {
    const req = new FakeRequest();
    let values = this._values().filter(v => v && v[this.keyPath] !== undefined);
    if (query instanceof KeyRange) values = values.filter(v => query.includes(v[this.keyPath]));
    values.sort((a, b) => cmp(a[this.keyPath], b[this.keyPath]));
    if (direction === 'prev') values.reverse();
    let i = 0;
    const step = () => {
      if (i >= values.length) { req.result = null; queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); }); return; }
      const value = values[i++];
      req.result = {
        value: value,
        key: value[this.keyPath],
        continue() { step(); }
      };
      queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
    };
    queueMicrotask(step);
    return req;
  }
}

class FakeObjectStore {
  constructor(db, name, options) {
    this.db = db;
    this.name = name;
    this.keyPath = (options && options.keyPath) || null;
    this.autoIncrement = !!(options && options.autoIncrement);
    this._data = new Map();
    this._auto = 0;
    this._indexes = new Map();
    db._stores.set(name, this);
  }
  createIndex(name, keyPath) {
    const idx = new FakeIndex(this, name, keyPath);
    this._indexes.set(name, idx);
    return idx;
  }
  index(name) {
    const idx = this._indexes.get(name);
    if (!idx) throw new Error('нет индекса ' + name);
    return idx;
  }
  _all() {
    return Array.from(this._data.values());
  }
  _keyOf(obj) {
    if (this.keyPath) return obj[this.keyPath];
    return undefined;
  }
  add(obj) {
    const req = new FakeRequest();
    let key = this._keyOf(obj);
    if (key === undefined && this.autoIncrement) {
      key = ++this._auto;
      if (this.keyPath) obj[this.keyPath] = key;
    }
    if (this.autoIncrement && typeof key === 'number' && key > this._auto) this._auto = key;
    if (this._data.has(key)) { req._fail(new Error('Key already exists: ' + key)); return req; }
    this._data.set(key, obj);
    req._succeed(key);
    return req;
  }
  put(obj) {
    const req = new FakeRequest();
    let key = this._keyOf(obj);
    if (key === undefined && this.autoIncrement) {
      key = ++this._auto;
      if (this.keyPath) obj[this.keyPath] = key;
    }
    if (this.autoIncrement && typeof key === 'number' && key > this._auto) this._auto = key;
    this._data.set(key, obj);
    req._succeed(key);
    return req;
  }
  get(key) {
    const req = new FakeRequest();
    req._succeed(this._data.get(key));
    return req;
  }
  getAll(query) {
    const req = new FakeRequest();
    let out = this._all();
    if (Array.isArray(query)) {
      const set = new Set(query);
      out = out.filter(v => set.has(this._keyOf(v)));
    } else if (query instanceof KeyRange) {
      out = out.filter(v => query.includes(this._keyOf(v)));
    }
    out.sort((a, b) => cmp(this._keyOf(a), this._keyOf(b)));
    req._succeed(out);
    return req;
  }
  count() {
    const req = new FakeRequest();
    req._succeed(this._data.size);
    return req;
  }
  clear() {
    const req = new FakeRequest();
    this._data.clear();
    req._succeed(undefined);
    return req;
  }
  openCursor(query, direction) {
    const req = new FakeRequest();
    let values = this._all();
    if (query instanceof KeyRange) values = values.filter(v => query.includes(this._keyOf(v)));
    values.sort((a, b) => cmp(this._keyOf(a), this._keyOf(b)));
    if (direction === 'prev') values.reverse();
    let i = 0;
    const step = () => {
      if (i >= values.length) { req.result = null; queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); }); return; }
      const value = values[i++];
      req.result = { value: value, key: this._keyOf(value), continue() { step(); } };
      queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
    };
    queueMicrotask(step);
    return req;
  }
}

class FakeTransaction {
  constructor(db, storeNames, mode) {
    this.db = db;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._names = Array.isArray(storeNames) ? storeNames : [storeNames];
    this._pending = 0;
    this._done = false;
    this._scheduleComplete();
  }
  objectStore(name) {
    const store = this.db._stores.get(name);
    if (!store) throw new Error('нет стора ' + name);
    return store;
  }
  _scheduleComplete() {
    // Транзакция завершается, когда микрозадачи «успокоились».
    let rounds = 0;
    const check = () => {
      rounds++;
      if (rounds > 5) {
        if (!this._done) { this._done = true; if (this.oncomplete) this.oncomplete(); }
        return;
      }
      queueMicrotask(check);
    };
    queueMicrotask(check);
  }
}

class FakeDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this._stores = new Map();
    this.objectStoreNames = {
      contains: (n) => this._stores.has(n)
    };
  }
  createObjectStore(name, options) {
    return new FakeObjectStore(this, name, options);
  }
  transaction(storeNames, mode) {
    return new FakeTransaction(this, storeNames, mode || 'readonly');
  }
  close() {}
}

class FakeIndexedDB {
  constructor() {
    this._dbs = new Map();
  }
  open(name, version) {
    const req = new FakeRequest();
    const existing = this._dbs.get(name);
    const isUpgrade = !existing || existing.version < version;
    const db = existing || new FakeDatabase(name, version);
    db.version = version;
    this._dbs.set(name, db);
    queueMicrotask(() => {
      req.result = db;
      if (isUpgrade && req.onupgradeneeded) req.onupgradeneeded({ target: req });
      queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
    });
    return req;
  }
  deleteDatabase(name) {
    const req = new FakeRequest();
    this._dbs.delete(name);
    queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
    return req;
  }
}

export { FakeIndexedDB, KeyRange, KeyRange as IDBKeyRange, FakeDatabase, FakeTransaction, FakeObjectStore };
export default FakeIndexedDB;
