/*! test/fake-idb.mjs — минимальный, но достаточно полный in-memory шим IndexedDB.
 *
 * Поддерживает то, что реально использует js/memory-db.js:
 *   indexedDB.open, onupgradeneeded, db.createObjectStore, store.createIndex,
 *   db.transaction, transaction.oncomplete/onerror/onabort, request.onsuccess/onerror,
 *   store.add/put/get/getAll/count/delete/clear/openCursor,
 *   index.get/getAll/count/openCursor,
 *   IDBKeyRange.only/lowerBound/upperBound/bound.
 *
 * Все события — асинхронно, через queueMicrotask (как в настоящем IndexedDB).
 * Значения кладутся через structuredClone (изоляция от вызывающего кода).
 *
 * Упрощения (сознательные, для тестов):
 *   - getAll/getAllKeys с массивом ключей возвращает записи в порядке ключей запроса,
 *     а не в порядке хранилища (для memory-db порядок не важен — она строит Map);
 *   - нет версий/блокировок между «вкладками», нет multiEntry-индексов,
 *     нет курсоров с update/delete.
 *
 * Модуль также выставляет globalThis.IDBKeyRange, если его ещё нет (как в браузере),
 * чтобы memory-db могла брать диапазоны ключей из глобального окружения.
 */

const cloneValue = (typeof structuredClone === 'function')
  ? (v) => structuredClone(v)
  : (v) => JSON.parse(JSON.stringify(v));

function toClone(v) {
  try {
    return cloneValue(v);
  } catch (e) {
    return JSON.parse(JSON.stringify(v));
  }
}

function domError(name, message) {
  if (typeof DOMException === 'function') {
    try { return new DOMException(message, name); } catch (e) { /* ignore */ }
  }
  const err = new Error(message);
  err.name = name;
  return err;
}

function serKey(k) {
  if (typeof k === 'number') return 'n:' + k;
  if (typeof k === 'string') return 's:' + k;
  if (k instanceof Date) return 'd:' + k.getTime();
  if (Array.isArray(k)) return 'a:[' + k.map(serKey).join(',') + ']';
  return 'o:' + String(k);
}

function keyRank(k) {
  if (typeof k === 'number') return 1;
  if (k instanceof Date) return 2;
  if (typeof k === 'string') return 3;
  if (Array.isArray(k)) return 4;
  return 5;
}

function cmpKeys(a, b) {
  const ra = keyRank(a), rb = keyRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) return a - b;
  if (ra === 2) return a.getTime() - b.getTime();
  if (ra === 3) return a < b ? -1 : (a > b ? 1 : 0);
  if (ra === 4) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = cmpKeys(a[i], b[i]);
      if (d) return d;
    }
    return a.length - b.length;
  }
  return 0;
}

function limitCount(arr, count) {
  if (count === undefined || count === null) return arr;
  const n = Number(count);
  if (!isFinite(n) || n < 0) return arr;
  return arr.slice(0, n);
}

/* ---------------- IDBKeyRange ---------------- */

class KeyRange {
  constructor(lower, upper, hasLower, hasUpper, lowerOpen, upperOpen) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = !!lowerOpen;
    this.upperOpen = !!upperOpen;
    this._hasLower = !!hasLower;
    this._hasUpper = !!hasUpper;
    this.__isKeyRange = true;
  }
  includes(key) {
    if (this._hasLower) {
      const d = cmpKeys(key, this.lower);
      if (d < 0 || (d === 0 && this.lowerOpen)) return false;
    }
    if (this._hasUpper) {
      const d = cmpKeys(key, this.upper);
      if (d > 0 || (d === 0 && this.upperOpen)) return false;
    }
    return true;
  }
  static only(value) {
    return new KeyRange(value, value, true, true, false, false);
  }
  static lowerBound(lower, open) {
    return new KeyRange(lower, undefined, true, false, !!open, true);
  }
  static upperBound(upper, open) {
    return new KeyRange(undefined, upper, false, true, true, !!open);
  }
  static bound(lower, upper, lowerOpen, upperOpen) {
    return new KeyRange(lower, upper, true, true, !!lowerOpen, !!upperOpen);
  }
}

const isRange = (q) => !!q && (q instanceof KeyRange || q.__isKeyRange === true);

/* ---------------- запросы и события ---------------- */

class FakeRequest {
  constructor(source) {
    this.source = source || null;
    this.result = undefined;
    this.error = null;
    this.readyState = 'pending';
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.onblocked = null;
    this._listeners = Object.create(null);
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  _fire(type, extra) {
    const ev = Object.assign({ type, target: this, currentTarget: this }, extra || {});
    const handler = this['on' + type];
    if (typeof handler === 'function') {
      try { handler.call(this, ev); } catch (e) { /* как в браузере: ошибка в обработчике не рушит процесс */ }
    }
    const list = this._listeners[type];
    if (list) {
      for (const fn of list.slice()) {
        try { fn.call(this, ev); } catch (e) { /* ignore */ }
      }
    }
  }
}

class FakeCursor {
  constructor(entry, advance) {
    this.key = entry.key;
    this.primaryKey = entry.primaryKey;
    this.value = entry.value;
    this._advance = advance;
    this._done = false;
  }
  continue() {
    if (this._done) return;
    this._done = true;
    this._advance();
  }
  advance(n) {
    this.continue(n);
  }
  update() {
    throw domError('InvalidStateError', 'cursor.update не поддержан шимом');
  }
  delete() {
    throw domError('InvalidStateError', 'cursor.delete не поддержан шимом');
  }
}

/* ---------------- хранилище ---------------- */

class FakeIndex {
  constructor(store, name, keyPath, options) {
    const o = options || {};
    this.store = store;
    this.name = name;
    this.keyPath = keyPath;
    this.unique = !!o.unique;
    this.multiEntry = !!o.multiEntry;
    this.__isIndex = true;
  }
  _keyOf(value) {
    if (value === null || typeof value !== 'object') return undefined;
    return value[this.keyPath];
  }
  _bucket() {
    return this.store._indexData.get(this.name);
  }
  _entries(range, dir) {
    const bucket = this._bucket();
    const out = [];
    if (!bucket) return out;
    const items = Array.from(bucket.values()).sort((a, b) => cmpKeys(a.key, b.key));
    for (const item of items) {
      if (range && !range.includes(item.key)) continue;
      const pks = Array.from(item.pks).sort(cmpKeys);
      for (const pk of pks) {
        out.push({ key: item.key, primaryKey: pk, value: this.store._data.get(pk) });
      }
    }
    if (dir === 'prev' || dir === 'prevunique') out.reverse();
    if (dir === 'nextunique' || dir === 'prevunique') {
      const seen = new Set();
      const uniq = [];
      for (const e of out) {
        const s = serKey(e.key);
        if (seen.has(s)) continue;
        seen.add(s);
        uniq.push(e);
      }
      return uniq;
    }
    return out;
  }
  _collect(query) {
    const out = [];
    const bucket = this._bucket();
    if (!bucket || bucket.size === 0) return out;
    if (query === undefined || query === null) {
      for (const e of this._entries(null, 'next')) out.push(e.value);
      return out;
    }
    if (Array.isArray(query)) {
      for (const k of query) {
        const item = bucket.get(serKey(k));
        if (!item) continue;
        for (const pk of Array.from(item.pks).sort(cmpKeys)) out.push(this.store._data.get(pk));
      }
      return out;
    }
    if (isRange(query)) {
      for (const e of this._entries(query, 'next')) out.push(e.value);
      return out;
    }
    const item = bucket.get(serKey(query));
    if (item) {
      for (const pk of Array.from(item.pks).sort(cmpKeys)) out.push(this.store._data.get(pk));
    }
    return out;
  }
  _get(key) {
    const v = this._collect(key);
    return v.length ? v[0] : undefined;
  }
  _getAll(query, count) {
    return limitCount(this._collect(query), count);
  }
  _count(query) {
    if (query === undefined || query === null) {
      let n = 0;
      const bucket = this._bucket();
      if (!bucket) return 0;
      for (const item of bucket.values()) n += item.pks.size;
      return n;
    }
    return this._collect(query).length;
  }
  _getKey(query) {
    if (!isRange(query)) {
      const bucket = this._bucket();
      const item = bucket ? bucket.get(serKey(query)) : null;
      if (!item) return undefined;
      const pks = Array.from(item.pks).sort(cmpKeys);
      return pks.length ? pks[0] : undefined;
    }
    const entries = this._entries(query, 'next');
    return entries.length ? entries[0].primaryKey : undefined;
  }
  _getAllKeys(query, count) {
    const bucket = this._bucket();
    if (!bucket || bucket.size === 0) return [];
    if (query === undefined || query === null) {
      return limitCount(this._entries(null, 'next').map((e) => e.key), count);
    }
    if (Array.isArray(query)) {
      const out = [];
      for (const k of query) {
        const item = bucket.get(serKey(k));
        if (!item) continue;
        for (const pk of Array.from(item.pks).sort(cmpKeys)) out.push({ k, pk });
      }
      return limitCount(out.map((x) => x.k), count);
    }
    if (isRange(query)) return limitCount(this._entries(query, 'next').map((e) => e.key), count);
    const item = bucket.get(serKey(query));
    if (!item) return [];
    return Array.from({ length: item.pks.size }, () => query);
  }
  _cursorEntries(range, dir) {
    return this._entries(range, dir);
  }
}

class FakeObjectStore {
  constructor(name, options) {
    const o = options || {};
    this.name = name;
    this.keyPath = (o.keyPath === undefined || o.keyPath === null) ? null : o.keyPath;
    this.autoIncrement = !!o.autoIncrement;
    this._data = new Map();
    this._indexes = new Map();
    this._indexData = new Map();
    this._gen = 0;
    const self = this;
    this.indexNames = {
      contains(n) { return self._indexes.has(n); },
      get length() { return self._indexes.size; },
      item(i) { return Array.from(self._indexes.keys())[i] || null; }
    };
  }
  createIndex(name, keyPath, options) {
    const idx = new FakeIndex(this, name, keyPath, options);
    this._indexes.set(name, idx);
    this._indexData.set(name, new Map());
    return idx;
  }
  index(name) {
    const idx = this._indexes.get(name);
    if (!idx) throw domError('NotFoundError', 'index "' + name + '" not found');
    return idx;
  }
  _keyOf(value) {
    if (value === null || typeof value !== 'object') return undefined;
    if (!this.keyPath) return undefined;
    return value[this.keyPath];
  }
  _assignKey(value) {
    let k = this._keyOf(value);
    if (k === undefined || k === null) {
      if (!this.autoIncrement) throw domError('DataError', 'ключ обязателен (нет keyPath/autoIncrement)');
      k = this._gen + 1;
      this._gen = k;
      if (this.keyPath) value[this.keyPath] = k;
    } else if (typeof k === 'number' && this.autoIncrement && k > this._gen) {
      this._gen = k;
    }
    return k;
  }
  _indexRecord(value, pk) {
    for (const idx of this._indexes.values()) {
      const ik = idx._keyOf(value);
      if (ik === undefined || ik === null) continue;
      const bucket = this._indexData.get(idx.name);
      const s = serKey(ik);
      let item = bucket.get(s);
      if (!item) {
        item = { key: ik, pks: new Set() };
        bucket.set(s, item);
      }
      item.pks.add(pk);
    }
  }
  _unindexRecord(value, pk) {
    for (const idx of this._indexes.values()) {
      const ik = idx._keyOf(value);
      if (ik === undefined || ik === null) continue;
      const bucket = this._indexData.get(idx.name);
      const item = bucket.get(serKey(ik));
      if (!item) continue;
      item.pks.delete(pk);
      if (!item.pks.size) bucket.delete(serKey(ik));
    }
  }
  _writeRecord(value, pk, isAdd) {
    const existing = this._data.get(pk);
    if (isAdd && existing !== undefined) {
      throw domError('ConstraintError', 'запись с ключом ' + String(pk) + ' уже есть');
    }
    if (existing !== undefined) this._unindexRecord(existing, pk);
    for (const idx of this._indexes.values()) {
      if (!idx.unique) continue;
      const ik = idx._keyOf(value);
      if (ik === undefined || ik === null) continue;
      const bucket = this._indexData.get(idx.name);
      const item = bucket.get(serKey(ik));
      if (item && item.pks.size) {
        for (const other of item.pks) {
          if (other !== pk) {
            throw domError('ConstraintError', 'нарушен уникальный индекс "' + idx.name + '"');
          }
        }
      }
    }
    this._data.set(pk, value);
    this._indexRecord(value, pk);
  }
  _add(value, key) {
    if (value === null || typeof value !== 'object') throw domError('DataError', 'value должен быть объектом');
    const clone = toClone(value);
    const pk = (key === undefined || key === null) ? this._assignKey(clone) : key;
    this._writeRecord(clone, pk, true);
    return pk;
  }
  _put(value, key) {
    if (value === null || typeof value !== 'object') throw domError('DataError', 'value должен быть объектом');
    const clone = toClone(value);
    const pk = (key === undefined || key === null) ? this._assignKey(clone) : key;
    this._writeRecord(clone, pk, false);
    return pk;
  }
  _get(key) {
    return this._data.has(key) ? this._data.get(key) : undefined;
  }
  _entries(range, dir) {
    const keys = Array.from(this._data.keys()).sort(cmpKeys);
    if (dir === 'prev' || dir === 'prevunique') keys.reverse();
    const out = [];
    for (const k of keys) {
      if (range && !range.includes(k)) continue;
      out.push({ key: k, primaryKey: k, value: this._data.get(k) });
    }
    return out;
  }
  _collect(query) {
    const out = [];
    if (query === undefined || query === null) {
      for (const e of this._entries(null, 'next')) out.push(e.value);
      return out;
    }
    if (Array.isArray(query)) {
      for (const k of query) if (this._data.has(k)) out.push(this._data.get(k));
      return out;
    }
    if (isRange(query)) {
      for (const e of this._entries(query, 'next')) out.push(e.value);
      return out;
    }
    if (this._data.has(query)) out.push(this._data.get(query));
    return out;
  }
  _getAll(query, count) {
    return limitCount(this._collect(query), count);
  }
  _count(query) {
    if (query === undefined || query === null) return this._data.size;
    return this._collect(query).length;
  }
  _getKey(query) {
    const keys = Array.from(this._data.keys()).sort(cmpKeys);
    if (query === undefined || query === null) return keys.length ? keys[0] : undefined;
    if (isRange(query)) {
      for (const k of keys) if (query.includes(k)) return k;
      return undefined;
    }
    return this._data.has(query) ? query : undefined;
  }
  _getAllKeys(query, count) {
    if (query === undefined || query === null) {
      return limitCount(Array.from(this._data.keys()).sort(cmpKeys), count);
    }
    if (Array.isArray(query)) return limitCount(query.filter((k) => this._data.has(k)), count);
    if (isRange(query)) return limitCount(this._entries(query, 'next').map((e) => e.key), count);
    return this._data.has(query) ? [query] : [];
  }
  _deleteKey(key) {
    const existing = this._data.get(key);
    if (existing === undefined && !this._data.has(key)) return;
    if (existing !== undefined) this._unindexRecord(existing, key);
    this._data.delete(key);
  }
  _delete(query) {
    if (query === undefined || query === null) {
      this._clear();
      return;
    }
    if (Array.isArray(query)) {
      for (const k of query) this._deleteKey(k);
      return;
    }
    if (isRange(query)) {
      for (const k of Array.from(this._data.keys())) if (query.includes(k)) this._deleteKey(k);
      return;
    }
    this._deleteKey(query);
  }
  _clear() {
    this._data.clear();
    for (const bucket of this._indexData.values()) bucket.clear();
  }
  _cursorEntries(range, dir) {
    return this._entries(range, dir);
  }
}

/* ---------------- фасады, привязанные к транзакции ---------------- */

class BoundIndex {
  constructor(tx, store, idx) {
    this.tx = tx;
    this.store = store;
    this.idx = idx;
    this.name = idx.name;
    this.keyPath = idx.keyPath;
    this.unique = idx.unique;
    this.multiEntry = idx.multiEntry;
  }
  get(key) { return this.tx._enqueue(() => this.idx._get(key)); }
  getKey(key) { return this.tx._enqueue(() => this.idx._getKey(key)); }
  getAll(query, count) { return this.tx._enqueue(() => this.idx._getAll(query, count)); }
  getAllKeys(query, count) { return this.tx._enqueue(() => this.idx._getAllKeys(query, count)); }
  count(query) { return this.tx._enqueue(() => this.idx._count(query)); }
  openCursor(range, direction) { return this.tx._cursor(this.idx, range, direction); }
  openKeyCursor(range, direction) { return this.tx._cursor(this.idx, range, direction); }
}

class BoundStore {
  constructor(tx, store) {
    this.tx = tx;
    this.store = store;
    this.name = store.name;
    this.keyPath = store.keyPath;
    this.autoIncrement = store.autoIncrement;
    this.indexNames = store.indexNames;
  }
  add(value, key) { return this.tx._enqueue(() => this.store._add(value, key)); }
  put(value, key) { return this.tx._enqueue(() => this.store._put(value, key)); }
  get(key) { return this.tx._enqueue(() => this.store._get(key)); }
  getKey(key) { return this.tx._enqueue(() => this.store._getKey(key)); }
  getAll(query, count) { return this.tx._enqueue(() => this.store._getAll(query, count)); }
  getAllKeys(query, count) { return this.tx._enqueue(() => this.store._getAllKeys(query, count)); }
  count(query) { return this.tx._enqueue(() => this.store._count(query)); }
  delete(query) { return this.tx._enqueue(() => { this.store._delete(query); return undefined; }); }
  clear() { return this.tx._enqueue(() => { this.store._clear(); return undefined; }); }
  index(name) { return new BoundIndex(this.tx, this.store, this.store.index(name)); }
  openCursor(range, direction) { return this.tx._cursor(this.store, range, direction); }
  openKeyCursor(range, direction) { return this.tx._cursor(this.store, range, direction); }
}

/* ---------------- транзакция ---------------- */

class FakeTransaction {
  constructor(db, storeNames, mode) {
    this.db = db;
    this.mode = mode || 'readonly';
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._pending = 0;
    this._finished = false;
    this._completeQueued = false;
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    this._names = names;
    for (const n of names) {
      if (!db._stores.has(n)) throw domError('NotFoundError', 'object store "' + n + '" не найден');
    }
    this._scheduleComplete();   // транзакция без запросов тоже должна завершиться
  }
  objectStore(name) {
    if (!this._names.includes(name)) {
      throw domError('NotFoundError', 'object store "' + name + '" не входит в транзакцию');
    }
    return new BoundStore(this, this.db._stores.get(name));
  }
  abort() {
    this._abort(domError('AbortError', 'транзакция прервана'));
  }
  _enqueue(work) {
    const req = new FakeRequest(this);
    this._pending++;
    queueMicrotask(() => {
      if (this._finished) return;
      let result;
      try {
        result = work();
      } catch (e) {
        this._requestError(req, e);
        return;
      }
      req.result = result;
      req.readyState = 'done';
      req._fire('success');
      this._done();
    });
    return req;
  }
  _cursor(source, range, direction) {
    const req = new FakeRequest(source);
    this._pending++;
    const dir = direction || 'next';
    const entries = source._cursorEntries(range || null, dir);
    let i = 0;
    const self = this;
    const step = () => {
      if (self._finished) return;
      if (i >= entries.length) {
        req.result = null;
        req.readyState = 'done';
        req._fire('success');
        self._done();
        return;
      }
      let advanced = false;
      req.result = new FakeCursor(entries[i], () => { advanced = true; });
      req.readyState = 'done';
      req._fire('success');
      if (advanced) {
        i++;
        queueMicrotask(step);
      } else {
        self._done();
      }
    };
    queueMicrotask(step);
    return req;
  }
  _done() {
    if (this._pending > 0) this._pending--;
    if (this._pending <= 0) this._scheduleComplete();
  }
  _scheduleComplete() {
    if (this._completeQueued || this._finished) return;
    this._completeQueued = true;
    queueMicrotask(() => {
      this._completeQueued = false;
      if (this._finished) return;
      if (this._pending > 0) return;
      this._finished = true;
      this.db._active.delete(this);
      if (typeof this.oncomplete === 'function') this.oncomplete({ type: 'complete', target: this });
    });
  }
  _requestError(req, err) {
    req.error = err;
    req.readyState = 'done';
    req._fire('error');
    this._abort(err);
  }
  _abort(err) {
    if (this._finished) return;
    this._finished = true;
    this.error = err || this.error;
    this.db._active.delete(this);
    if (typeof this.onerror === 'function') this.onerror({ type: 'error', target: this });
    if (typeof this.onabort === 'function') this.onabort({ type: 'abort', target: this });
  }
}

/* ---------------- база ---------------- */

class FakeDatabase {
  constructor(name, version, factory) {
    this.name = name;
    this.version = version;
    this._stores = new Map();
    this._factory = factory;
    this._active = new Set();
    this._closed = false;
    const self = this;
    this.objectStoreNames = {
      contains(n) { return self._stores.has(n); },
      get length() { return self._stores.size; },
      item(i) { return Array.from(self._stores.keys())[i] || null; }
    };
  }
  createObjectStore(name, options) {
    if (this._stores.has(name)) throw domError('ConstraintError', 'store "' + name + '" уже есть');
    const store = new FakeObjectStore(name, options);
    this._stores.set(name, store);
    return store;
  }
  deleteObjectStore(name) {
    this._stores.delete(name);
  }
  transaction(storeNames, mode) {
    return new FakeTransaction(this, storeNames, mode);
  }
  close() {
    this._closed = true;
  }
}

class FakeIndexedDB {
  constructor() {
    this._dbs = new Map();
  }
  open(name, version) {
    const req = new FakeRequest(null);
    const self = this;
    queueMicrotask(() => {
      let db = self._dbs.get(name);
      const oldVersion = db ? db.version : 0;
      const newVersion = (version === undefined || version === null) ? (db ? db.version : 1) : Number(version);
      if (newVersion < oldVersion) {
        req.error = domError('VersionError', 'версия ' + newVersion + ' меньше текущей ' + oldVersion);
        req._fire('error');
        return;
      }
      if (!db) {
        db = new FakeDatabase(name, newVersion, self);
        self._dbs.set(name, db);
      }
      req.result = db;
      if (newVersion > oldVersion) {
        db.version = newVersion;
        if (typeof req.onupgradeneeded === 'function') {
          req.onupgradeneeded({ type: 'upgradeneeded', target: req, oldVersion, newVersion });
        }
      }
      req.readyState = 'done';
      req._fire('success');
    });
    return req;
  }
  deleteDatabase(name) {
    const req = new FakeRequest(null);
    const self = this;
    queueMicrotask(() => {
      self._dbs.delete(name);
      req.result = undefined;
      req.readyState = 'done';
      req._fire('success');
    });
    return req;
  }
  databases() {
    return Promise.resolve(Array.from(this._dbs.keys()).map((name) => ({ name, version: this._dbs.get(name).version })));
  }
}

/* В браузере IDBKeyRange — глобальный; в Node его нет. Выставляем, если свободно. */
if (typeof globalThis !== 'undefined' && !globalThis.IDBKeyRange) {
  globalThis.IDBKeyRange = KeyRange;
}

export { FakeIndexedDB, KeyRange as IDBKeyRange, KeyRange, FakeObjectStore, FakeTransaction, FakeDatabase };
export default FakeIndexedDB;
