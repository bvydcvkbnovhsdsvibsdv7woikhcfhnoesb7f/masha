/*! MashaMemory — архив переписки «Маши» на IndexedDB (265 000+ сообщений).
 *
 * UMD: в браузере — globalThis.MashaMemory, в Node — require('../js/memory-db.js').
 * Без npm-зависимостей: только Web API (IndexedDB) и, при наличии, MashaSearch.
 *
 * Схема БД (version 1):
 *   messages : keyPath 'id' (autoIncrement). Индексы: seq (unique), ts, role, src.
 *              Запись {id, seq, role, content, ts, iso, day, src, img}
 *   terms    : keyPath 'term'. Значение {term, ids:[seq,...]} — постинги хранят SEQ.
 *   hashes   : keyPath 'h'. Значение {h, seq} — дедупликация повторного импорта.
 *   meta     : keyPath 'k'. {k:'seq'|'sources'|'bytes'|'importedAt', v}
 *
 * Принципы производительности: пакетные транзакции, между батчами await,
 * индекс строится порциями (indexBatch), постинги сливаются только по затронутым
 * термам через getAll, постинг-лист обрезается maxPostings свежими seq.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MashaMemory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var G = (typeof globalThis !== 'undefined') ? globalThis
    : (typeof self !== 'undefined') ? self
      : (typeof window !== 'undefined') ? window : this;

  var DEFAULT_NAME = 'masha_memory';
  var DEFAULT_VERSION = 1;
  var INDEX_TERM_LIMIT = 12;      // терминов на сообщение при построении индекса
  var TERM_MERGE_CHUNK = 400;     // сколько термов сливать в одной паре транзакций
  var DEFAULT_MAX_POSTINGS = 1500;
  var MAX_IMG_CHARS = 262144;     // защита от хранения огромных base64-картинок

  /* ---------------- утилиты ---------------- */

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function isoFromTs(ts) {
    if (!(ts > 0)) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dayFromTs(ts) {
    if (!(ts > 0)) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* Двойной djb2 (64 бита, две независимые соли) от role|ts|content —
     ключ дедупликации повторного импорта.
     Одна 32-битная сумма давала ~6 ложных совпадений на 265 000 сообщений
     (реальные сообщения молча пропускались как «дубликаты»), две суммы
     уменьшают вероятность до ~2e-9. */
  function hashMsg(role, ts, content) {
    var s = String(role) + '|' + num(ts) + '|' + String(content);
    var h1 = 5381;
    var h2 = 52711;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (((h1 << 5) + h1) + c) >>> 0;          // djb2
      h2 = (((h2 << 5) + h2) ^ (c + i)) >>> 0;    // djb2-подобный с XOR и позицией
    }
    return 'd2' + h1.toString(36) + '.' + h2.toString(36);
  }

  function normalizeRole(role) {
    var r = String(role === null || role === undefined ? '' : role).trim().toLowerCase();
    if (r === 'user' || r === 'human' || r === 'me' || r === 'я' || r === 'вы' ||
      r === 'eduard' || r === 'эдуард') return 'user';
    if (r === 'assistant' || r === 'bot' || r === 'ai' || r === 'model' ||
      r === 'маша' || r === 'masha') return 'assistant';
    return '';
  }

  function clonePlain(o) {
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
  }

  function bySeqAsc(a, b) {
    return num(a && a.seq) - num(b && b.seq);
  }

  /* ---------------- MashaSearch (ленивое подключение) ---------------- */

  var SE_CACHE;   // undefined = ещё не искали, null = нет

  function getSearchEngine() {
    if (SE_CACHE !== undefined) return SE_CACHE;
    SE_CACHE = null;
    try {
      if (typeof require === 'function') {
        var mod = require('./search-engine.js');
        if (mod && typeof mod.extractKeywords === 'function') SE_CACHE = mod;
      }
    } catch (e) { /* нет модуля — не страшно */ }
    if (!SE_CACHE && G && G.MashaSearch && typeof G.MashaSearch.extractKeywords === 'function') {
      SE_CACHE = G.MashaSearch;
    }
    return SE_CACHE;
  }

  /* Резервная нормализация, если MashaSearch почему-то не подключён. */
  function fallbackKeywords(text, limit) {
    var s = String(text === null || text === undefined ? '' : text).toLowerCase().replace(/ё/g, 'е');
    var parts = s.split(/[^a-zа-я]+/);
    var out = [];
    var seen = new Set();
    for (var i = 0; i < parts.length && out.length < num(limit); i++) {
      var w = parts[i];
      if (w.length < 3 || seen.has(w)) continue;
      seen.add(w);
      out.push(w);
    }
    return out;
  }

  function keywordsOf(text, limit) {
    var se = getSearchEngine();
    if (se && typeof se.extractKeywords === 'function') {
      try {
        var kws = se.extractKeywords(text, limit);
        if (Array.isArray(kws)) return kws;
      } catch (e) { /* падать из-за поиска не должны */ }
    }
    return fallbackKeywords(text, limit);
  }

  /* Термы запроса: как есть + нормализованная форма (индекс хранит нормализованные). */
  function normalizeLookupTerms(terms) {
    var list = Array.isArray(terms) ? terms : (terms === null || terms === undefined ? [] : [terms]);
    var se = getSearchEngine();
    var out = [];
    var seen = new Set();
    function add(t) {
      if (!t || seen.has(t)) return;
      seen.add(t);
      out.push(t);
    }
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (raw === null || raw === undefined) continue;
      var t = String(raw).trim().toLowerCase().replace(/ё/g, 'е');
      add(t);
      if (se && typeof se.normalizeTerm === 'function') add(se.normalizeTerm(t));
    }
    return out;
  }

  /* ---------------- promisify ---------------- */

  function reqDone(req) {
    return new Promise(function (resolve, reject) {
      if (!req) { reject(new Error('IndexedDB: пустой запрос')); return; }
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB: ошибка запроса')); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB: ошибка транзакции')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB: транзакция прервана')); };
    });
  }

  function monotonicTs(list) {
    var prev = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var ts = (m && typeof m === 'object') ? num(m.ts) : -Infinity;
      if (ts < prev) return false;
      prev = ts;
    }
    return true;
  }

  /* Индексы записей, отсортированные по ts (устойчиво). Нужны только если
   * входной массив не отсортирован — обычно архив уже отсортирован. */
  function sortedOrder(list) {
    var order = [];
    for (var i = 0; i < list.length; i++) order.push(i);
    order.sort(function (a, b) {
      var ta = num(list[a] && list[a].ts);
      var tb = num(list[b] && list[b].ts);
      if (ta !== tb) return ta - tb;
      return a - b;
    });
    return order;
  }

  function prepareMessage(raw, source) {
    if (!raw || typeof raw !== 'object') return null;
    var role = normalizeRole(raw.role);
    if (!role) return null;
    var content = String(raw.content === null || raw.content === undefined ? '' : raw.content).trim();
    if (!content) return null;
    var ts = num(raw.ts);
    var iso = (typeof raw.iso === 'string' && raw.iso) ? raw.iso : isoFromTs(ts);
    var day = (typeof raw.day === 'string' && raw.day) ? raw.day : dayFromTs(ts);
    var img = (typeof raw.img === 'string' && raw.img && raw.img.length <= MAX_IMG_CHARS) ? raw.img : null;
    return {
      role: role,
      content: content,
      ts: ts,
      iso: iso,
      day: day,
      src: (typeof raw.src === 'string' && raw.src) ? raw.src : source,
      rawSeq: raw.seq,
      extId: (raw.extId === undefined || raw.extId === null || raw.extId === '') ? '' : String(raw.extId),
      img: img
    };
  }

  /* Ключ дедупликации. Если у сообщения есть id из исходного архива (Telegram,
   * Qwen и т.п.) — он входит в ключ. Тогда одинаковые реплики, отправленные
   * в одну и ту же секунду («Ну», «ага», стикеры), НЕ схлопываются, но
   * повторный импорт того же файла по-прежнему ничего не дублирует. */
  function messageHash(rec) {
    var tail = rec.extId ? ('\u0000#' + rec.extId) : '';
    return hashMsg(rec.role, rec.ts, rec.content + tail);
  }

  function mergeIds(oldIds, newIds, maxPostings) {
    var set = new Set();
    var i;
    if (oldIds && oldIds.length) for (i = 0; i < oldIds.length; i++) set.add(oldIds[i]);
    if (newIds && newIds.length) for (i = 0; i < newIds.length; i++) set.add(newIds[i]);
    var arr = Array.from(set);
    arr.sort(function (a, b) { return a - b; });
    if (arr.length > maxPostings) arr = arr.slice(arr.length - maxPostings);   // свежие = большие seq
    return arr;
  }

  /* ---------------- MemoryDb ---------------- */

  class MemoryDb {
    constructor(opts) {
      var o = opts || {};
      this.name = o.name || DEFAULT_NAME;
      this.version = num(o.version) || DEFAULT_VERSION;
      this.indexLiveAppends = o.indexLiveAppends !== false;
      this._opts = o;
      this._idb = o.indexedDB || null;
      this._keyRange = o.IDBKeyRange || null;
      this._db = null;
      this._opening = null;
      this._seq = null;
      this._sources = null;
      this._bytes = null;
    }

    /* --- служебное --- */

    _resolveIdb() {
      return this._idb || G.indexedDB || (G.window && G.window.indexedDB) || null;
    }

    _resolveKeyRange() {
      return this._keyRange || G.IDBKeyRange || null;
    }

    _createSchema(db) {
      if (!db.objectStoreNames.contains('messages')) {
        var m = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        m.createIndex('seq', 'seq', { unique: true });
        m.createIndex('ts', 'ts', { unique: false });
        m.createIndex('role', 'role', { unique: false });
        m.createIndex('src', 'src', { unique: false });
      }
      if (!db.objectStoreNames.contains('terms')) db.createObjectStore('terms', { keyPath: 'term' });
      if (!db.objectStoreNames.contains('hashes')) db.createObjectStore('hashes', { keyPath: 'h' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    }

    open() {
      var self = this;
      if (this._db) return Promise.resolve();
      if (this._opening) return this._opening;
      var idb = this._resolveIdb();
      if (!idb || typeof idb.open !== 'function') {
        return Promise.reject(new Error('IndexedDB недоступен в этом окружении'));
      }
      this._opening = new Promise(function (resolve, reject) {
        var req;
        try {
          req = idb.open(self.name, self.version);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = function () {
          try {
            self._createSchema(req.result);
          } catch (e) {
            reject(e);
          }
        };
        req.onsuccess = function () {
          self._db = req.result;
          self._opening = null;
          resolve();
        };
        req.onerror = function () {
          self._opening = null;
          reject(req.error || new Error('Не удалось открыть IndexedDB'));
        };
        req.onblocked = function () { /* другая вкладка держит старую версию */ };
      });
      return this._opening;
    }

    close() {
      var self = this;
      if (!this._db) return Promise.resolve();
      return Promise.resolve().then(function () {
        try { self._db.close(); } catch (e) { /* ignore */ }
        self._db = null;
        self._opening = null;
      });
    }

    async _ensureMeta() {
      if (this._seq !== null && this._sources !== null && this._bytes !== null) return;
      await this.open();
      var tx = this._db.transaction('meta', 'readonly');
      var done = txDone(tx);
      var get = reqDone(tx.objectStore('meta').getAll(['seq', 'sources', 'bytes', 'importedAt']));
      var res = await Promise.all([get, done]);
      var recs = res[0] || [];
      this._seq = 0;
      this._sources = {};
      this._bytes = 0;
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        if (!r) continue;
        if (r.k === 'seq') this._seq = num(r.v);
        else if (r.k === 'sources') this._sources = (r.v && typeof r.v === 'object') ? clonePlain(r.v) : {};
        else if (r.k === 'bytes') this._bytes = num(r.v);
      }
    }

    async _storeCount(name) {
      await this.open();
      var tx = this._db.transaction(name, 'readonly');
      var done = txDone(tx);
      var count = reqDone(tx.objectStore(name).count());
      var res = await Promise.all([count, done]);
      return num(res[0]);
    }

    async _readTerms(keys) {
      if (!keys || !keys.length) return [];
      await this.open();
      var tx = this._db.transaction('terms', 'readonly');
      var done = txDone(tx);
      var get = reqDone(tx.objectStore('terms').getAll(keys));
      var res = await Promise.all([get, done]);
      return res[0] || [];
    }

    async _writeTerms(recs) {
      if (!recs || !recs.length) return;
      await this.open();
      var tx = this._db.transaction('terms', 'readwrite');
      var done = txDone(tx);
      var store = tx.objectStore('terms');
      for (var i = 0; i < recs.length; i++) store.put(recs[i]);
      await done;
    }

    async _indexGetAll(storeName, indexName, query) {
      await this.open();
      var tx = this._db.transaction(storeName, 'readonly');
      var done = txDone(tx);
      var get = reqDone(tx.objectStore(storeName).index(indexName).getAll(query));
      var res = await Promise.all([get, done]);
      return res[0] || [];
    }

    async _messagesBySeq(seqs) {
      if (!seqs || !seqs.length) return [];
      var rows = await this._indexGetAll('messages', 'seq', seqs);
      rows.sort(bySeqAsc);
      return rows;
    }

    _cursorValues(storeName, indexName, range, direction, max, filter) {
      var self = this;
      return this.open().then(function () {
        return new Promise(function (resolve, reject) {
          var tx;
          try {
            tx = self._db.transaction(storeName, 'readonly');
          } catch (e) {
            reject(e);
            return;
          }
          var out = [];
          var settled = false;
          function finish(fn, arg) {
            if (settled) return;
            settled = true;
            fn(arg);
          }
          txDone(tx).then(
            function () { finish(resolve, out); },
            function (e) { finish(reject, e); }
          );
          var source = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
          var req = source.openCursor(range || null, direction || 'next');
          req.onsuccess = function () {
            var cursor = req.result;
            if (!cursor) { finish(resolve, out); return; }
            if (!filter || filter(cursor.value)) out.push(cursor.value);
            if (max && out.length >= max) { finish(resolve, out); return; }
            cursor.continue();
          };
          req.onerror = function () {
            finish(reject, req.error || new Error('IndexedDB: ошибка курсора'));
          };
        });
      });
    }

    async _knownHashes(hashes) {
      var out = new Set();
      if (!hashes || !hashes.length) return out;
      await this.open();
      var tx = this._db.transaction('hashes', 'readonly');
      var done = txDone(tx);
      var get = reqDone(tx.objectStore('hashes').getAll(hashes));
      var res = await Promise.all([get, done]);
      var recs = res[0] || [];
      for (var i = 0; i < recs.length; i++) {
        if (recs[i] && recs[i].h !== undefined && recs[i].h !== null) out.add(recs[i].h);
      }
      return out;
    }

    async _writeBatch(records) {
      var tx = this._db.transaction(['messages', 'hashes', 'meta'], 'readwrite');
      var done = txDone(tx);
      var msgStore = tx.objectStore('messages');
      var hashStore = tx.objectStore('hashes');
      var metaStore = tx.objectStore('meta');
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        var row = {
          seq: rec.seq,
          role: rec.role,
          content: rec.content,
          ts: rec.ts,
          iso: rec.iso,
          day: rec.day,
          src: rec.src
        };
        if (rec.img) row.img = rec.img;
        msgStore.add(row);
        hashStore.put({ h: rec.h, seq: rec.seq });      }
      metaStore.put({ k: 'seq', v: this._seq });
      metaStore.put({ k: 'sources', v: clonePlain(this._sources) });
      metaStore.put({ k: 'bytes', v: this._bytes });
      metaStore.put({ k: 'importedAt', v: Date.now() });
      await done;
    }

    /* Слияние накопленных постингов с тем, что уже лежит в terms.
     * Читаем только затронутые термы (getAll по массиву ключей), не всю БД. */
    async _flushIndex(pending, maxPostings) {
      var terms = Array.from(pending.keys());
      for (var i = 0; i < terms.length; i += TERM_MERGE_CHUNK) {
        var chunk = terms.slice(i, i + TERM_MERGE_CHUNK);
        var existing = await this._readTerms(chunk);
        var byTerm = new Map();
        for (var r = 0; r < existing.length; r++) byTerm.set(existing[r].term, existing[r]);
        var out = [];
        for (var c = 0; c < chunk.length; c++) {
          var term = chunk[c];
          var old = byTerm.get(term);
          out.push({ term: term, ids: mergeIds(old && old.ids, pending.get(term), maxPostings) });
        }
        await this._writeTerms(out);
        for (var d = 0; d < chunk.length; d++) pending.delete(chunk[d]);
      }
    }

    async _sumContentBytes() {
      var sum = 0;
      await this._cursorValues('messages', 'seq', null, 'next', 0, function (v) {
        if (v && typeof v.content === 'string') sum += v.content.length;
        return false;
      });
      return sum;
    }

    /* --- публичный API --- */

    async count() {
      return this._storeCount('messages');
    }

    async append(msg) {
      var m = msg || {};
      var role = normalizeRole(m.role);
      if (!role) throw new Error('MashaMemory.append: неизвестная роль "' + m.role + '"');
      var content = String(m.content === null || m.content === undefined ? '' : m.content).trim();
      if (!content) throw new Error('MashaMemory.append: пустой content');
      var ts = num(m.ts) > 0 ? num(m.ts) : Date.now();
      var src = (typeof m.src === 'string' && m.src) ? m.src : 'live';
      var img = (typeof m.img === 'string' && m.img && m.img.length <= MAX_IMG_CHARS) ? m.img : null;

      await this.open();
      await this._ensureMeta();

      var prevSeq = this._seq, prevBytes = this._bytes;
      var prevSrcCount = num(this._sources[src]);
      var seq = this._seq + 1;
      var h = hashMsg(role, ts, content);
      var row = { seq: seq, role: role, content: content, ts: ts, iso: isoFromTs(ts), day: dayFromTs(ts), src: src };
      if (img) row.img = img;

      var tx = this._db.transaction(['messages', 'hashes', 'meta'], 'readwrite');
      var done = txDone(tx);
      var added = reqDone(tx.objectStore('messages').add(row));
      tx.objectStore('hashes').put({ h: h, seq: seq });

      this._seq = seq;
      this._bytes = prevBytes + content.length;
      this._sources[src] = prevSrcCount + 1;
      var metaStore = tx.objectStore('meta');
      metaStore.put({ k: 'seq', v: this._seq });
      metaStore.put({ k: 'sources', v: clonePlain(this._sources) });
      metaStore.put({ k: 'bytes', v: this._bytes });
      metaStore.put({ k: 'importedAt', v: Date.now() });

      var id;
      try {
        var res = await Promise.all([added, done]);
        id = res[0];
      } catch (e) {
        this._seq = prevSeq;
        this._bytes = prevBytes;
        this._sources[src] = prevSrcCount;
        throw e;
      }

      if (this.indexLiveAppends) {
        var kws = keywordsOf(content, INDEX_TERM_LIMIT);
        if (kws.length) {
          var map = new Map();
          for (var i = 0; i < kws.length; i++) {
            var arr = map.get(kws[i]);
            if (!arr) { arr = []; map.set(kws[i], arr); }
            arr.push(seq);
          }
          try {
            await this._flushIndex(map, DEFAULT_MAX_POSTINGS);
          } catch (e) { /* индекс живого сообщения не критичен */ }
        }
      }
      return id;
    }

    async importMessages(messages, opts) {
      var o = opts || {};
      var source = o.source || 'archive';
      var batchSize = Math.max(1, Math.floor(num(o.batchSize) || 500));
      var indexBatch = Math.max(1, Math.floor(num(o.indexBatch) || 20000));
      var maxPostings = Math.max(1, Math.floor(num(o.maxPostings) || DEFAULT_MAX_POSTINGS));
      var onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
      var buildIndex = o.buildIndex !== false;
      var skipDuplicates = o.skipDuplicates !== false;
      var t0 = Date.now();
      var list = Array.isArray(messages) ? messages : [];
      var total = list.length;
      var stats = { inserted: 0, duplicates: 0, skipped: 0, durationMs: 0, terms: 0 };

      await this.open();
      await this._ensureMeta();

      if (!total) {
        stats.durationMs = Date.now() - t0;
        if (onProgress) { try { onProgress(0, 0); } catch (e) { /* ignore */ } }
        return stats;
      }

      var order = monotonicTs(list) ? null : sortedOrder(list);
      var pending = buildIndex ? new Map() : null;
      var pendingCount = 0;
      var touched = new Set();

      for (var start = 0; start < total; start += batchSize) {
        var end = Math.min(total, start + batchSize);
        var prepared = [];
        var seenInBatch = new Set();
        for (var i = start; i < end; i++) {
          var p = prepareMessage(order ? list[order[i]] : list[i], source);
          if (!p) { stats.skipped++; continue; }
          p.h = messageHash(p);
          if (seenInBatch.has(p.h)) { stats.duplicates++; continue; }
          seenInBatch.add(p.h);
          prepared.push(p);
        }

        var fresh = prepared;
        if (skipDuplicates && prepared.length) {
          var hashes = [];
          for (var q = 0; q < prepared.length; q++) hashes.push(prepared[q].h);
          var known = await this._knownHashes(hashes);
          fresh = [];
          for (var k = 0; k < prepared.length; k++) {
            if (known.has(prepared[k].h)) stats.duplicates++;
            else fresh.push(prepared[k]);
          }
        }

        if (fresh.length) {
          for (var f = 0; f < fresh.length; f++) {
            var pm = fresh[f];
            var want = Math.floor(num(pm.rawSeq));
            var seq = (want > this._seq) ? want : this._seq + 1;
            pm.seq = seq;
            this._seq = seq;
            this._bytes += pm.content.length;
          }
          this._sources[source] = num(this._sources[source]) + fresh.length;
          await this._writeBatch(fresh);
          stats.inserted += fresh.length;

          if (pending) {
            for (var a = 0; a < fresh.length; a++) {
              var terms = keywordsOf(fresh[a].content, INDEX_TERM_LIMIT);
              for (var t = 0; t < terms.length; t++) {
                var term = terms[t];
                var ids = pending.get(term);
                if (!ids) { ids = []; pending.set(term, ids); }
                ids.push(fresh[a].seq);
                touched.add(term);
              }
            }
            pendingCount += fresh.length;
            if (pendingCount >= indexBatch) {
              await this._flushIndex(pending, maxPostings);
              pending = new Map();
              pendingCount = 0;
            }
          }
        }

        if (onProgress) {
          try { onProgress(Math.min(end, total), total); } catch (e) { /* прогресс не должен ломать импорт */ }
        }
      }

      if (pending && pending.size) await this._flushIndex(pending, maxPostings);

      stats.terms = touched.size;
      stats.durationMs = Date.now() - t0;
      return stats;
    }

    async search(terms, opts) {
      var o = opts || {};
      var limit = (o.limit === undefined || o.limit === null) ? 40 : Math.max(0, Math.floor(num(o.limit)));
      var candidateLimit = Math.max(1, Math.floor(num(o.candidateLimit) || 500));
      if (limit === 0) return [];

      await this.open();
      var lookup = normalizeLookupTerms(terms);
      if (!lookup.length) return [];

      var recs = await this._readTerms(lookup);
      if (!recs.length) return [];

      /* Взвешивание по редкости терма (упрощённый IDF).
         Без него на 265к сообщений частые слова («дела», «блин», «любимый»)
         перебивали редкие и важные («колледж», «ссора», «сырники»):
         именно они и отличают нужный эпизод. */
      var hits = new Map();   // seq -> сумма весов совпавших термов
      for (var i = 0; i < recs.length; i++) {
        var ids = (recs[i] && recs[i].ids) || [];
        if (!ids.length) continue;
        // df = сколько сообщений содержит терм; постинг обрезан maxPostings,
        // поэтому «упёршийся в лимит» терм честно считается частым.
        var w = 1 / Math.log2(2 + ids.length);
        for (var j = 0; j < ids.length; j++) {
          var s = ids[j];
          hits.set(s, (hits.get(s) || 0) + w);
        }
      }
      if (!hits.size) return [];

      var seqs = Array.from(hits.keys());
      if (seqs.length > candidateLimit) {
        // отбираем ЛУЧШИЕ по весу, а не просто свежие
        seqs.sort(function (a, b) {
          var d = hits.get(b) - hits.get(a);
          return d ? d : b - a;
        });
        seqs = seqs.slice(0, candidateLimit);
      }

      var msgs = await this._messagesBySeq(seqs);
      var bySeq = new Map();
      var minTs = Infinity, maxTs = -Infinity;
      for (var m = 0; m < msgs.length; m++) {
        bySeq.set(msgs[m].seq, msgs[m]);
        var ts = num(msgs[m].ts);
        if (ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }

      var out = [];
      for (var x = 0; x < seqs.length; x++) {
        var msg = bySeq.get(seqs[x]);
        if (!msg) continue;
        // Свежесть — только тай-брейк (до 249), основной вклад даёт редкость термов.
        var fresh = (maxTs > minTs) ? Math.round(249 * (num(msg.ts) - minTs) / (maxTs - minTs)) : 0;
        out.push({ msg: msg, score: Math.round((hits.get(seqs[x]) || 0) * 1000) + fresh });
      }
      out.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return num(b.msg.seq) - num(a.msg.seq);
      });
      return out.slice(0, limit);
    }

    async recall(query, opts) {
      var t0 = Date.now();
      var o = opts || {};
      var episodeLimit = Math.max(1, Math.floor(num(o.episodeLimit) || 6));
      var radius = (o.radius === undefined || o.radius === null) ? 2 : Math.max(0, Math.floor(num(o.radius)));
      var candidateLimit = Math.max(1, Math.floor(num(o.candidateLimit) || 500));

      var terms = keywordsOf(String(query === null || query === undefined ? '' : query), 12);
      if (!terms.length) return { episodes: [], matched: 0, tookMs: Date.now() - t0 };

      var found = await this.search(terms, { limit: candidateLimit, candidateLimit: candidateLimit });
      if (!found.length) return { episodes: [], matched: 0, tookMs: Date.now() - t0 };

      /* Якоря идут в порядке релевантности (как их вернул search), а не по
         свежести: иначе в промпт попадали случайные недавние сообщения.
         Соседние якоря (в пределах окна) схлопываются — это один эпизод. */
      var anchors = [];
      for (var i = 0; i < found.length && anchors.length < episodeLimit; i++) {
        var s = found[i].msg.seq;
        var tooClose = false;
        for (var c = 0; c < anchors.length; c++) {
          if (Math.abs(anchors[c] - s) <= radius * 2) { tooClose = true; break; }
        }
        if (!tooClose) anchors.push(s);
      }
      if (!anchors.length) return { episodes: [], matched: found.length, tookMs: Date.now() - t0 };

      var anchorSet = new Set(anchors);
      var need = [];
      var needSet = new Set();
      for (var a = 0; a < anchors.length; a++) {
        for (var k = anchors[a] - radius; k <= anchors[a] + radius; k++) {
          if (k > 0 && !anchorSet.has(k) && !needSet.has(k)) { needSet.add(k); need.push(k); }
        }
      }
      var neighbors = await this._messagesBySeq(need);
      var bySeq = new Map();
      for (var n = 0; n < neighbors.length; n++) bySeq.set(neighbors[n].seq, neighbors[n]);
      for (var f = 0; f < found.length; f++) bySeq.set(found[f].msg.seq, found[f].msg);

      var episodes = [];
      for (var an = 0; an < anchors.length; an++) {
        var anchor = anchors[an];
        var items = [];
        for (var sq = anchor - radius; sq <= anchor + radius; sq++) {
          var it = bySeq.get(sq);
          if (it) items.push(it);
        }
        if (!items.length) continue;
        var head = bySeq.get(anchor) || items[0];
        episodes.push({ seq: anchor, ts: num(head.ts), items: items });
      }

      var se = getSearchEngine();
      var unique = (se && typeof se.dedupeEpisodes === 'function') ? se.dedupeEpisodes(episodes) : episodes;
      return { episodes: unique, matched: found.length, tookMs: Date.now() - t0 };
    }

    async getRecent(limit) {
      var n = (limit === undefined || limit === null) ? 20 : Math.max(0, Math.floor(num(limit)));
      if (!n) return [];
      var rows = await this._cursorValues('messages', 'seq', null, 'prev', n);
      rows.reverse();     // в хронологическом порядке
      return rows;
    }

    async getNeighbors(seq, radius) {
      var s = Math.floor(num(seq));
      var r = Math.max(0, Math.floor(num(radius)));
      if (!(s > 0)) return [];
      await this.open();
      var lo = Math.max(0, s - r);
      var hi = s + r;
      var KR = this._resolveKeyRange();
      var rows;
      if (KR && typeof KR.bound === 'function') {
        rows = await this._indexGetAll('messages', 'seq', KR.bound(lo, hi));
      } else {
        rows = await this._cursorValues('messages', 'seq', null, 'next', 0, function (v) {
          return v && v.seq >= lo && v.seq <= hi;
        });
      }
      rows.sort(bySeqAsc);
      return rows;
    }

    async getStats() {
      await this.open();
      await this._ensureMeta();
      var messages = await this.count();
      var terms = await this._storeCount('terms');

      var oldest = 0, newest = 0;
      if (messages > 0) {
        var first = await this._cursorValues('messages', 'seq', null, 'next', 1);
        var last = await this._cursorValues('messages', 'seq', null, 'prev', 1);
        if (first[0]) oldest = num(first[0].ts);
        if (last[0]) newest = num(last[0].ts);
      }

      var sources = Object.keys(this._sources || {});
      var estBytes = num(this._bytes);
      if (!estBytes && G.navigator && G.navigator.storage && typeof G.navigator.storage.estimate === 'function') {
        try {
          var est = await G.navigator.storage.estimate();
          if (est && num(est.usage) > 0) estBytes = num(est.usage);
        } catch (e) { estBytes = 0; }
      }
      if (!estBytes) estBytes = await this._sumContentBytes();

      return {
        messages: messages,
        terms: terms,
        oldest: oldest,
        newest: newest,
        sources: sources,
        estBytes: estBytes
      };
    }

    /* Полная пересборка индекса ключевых слов из стора messages.
       Нужна, если архив импортировали с buildIndex:false или индекс повреждён.
       Читает сообщения страницами по chunkMessages (свежая readonly-транзакция
       на страницу — иначе IndexedDB закрывает транзакцию на await), поэтому
       все 265к в память не поднимаются. Сообщения и hashes не трогает. */
    async rebuildIndex(onProgress, opts) {
      var o = opts || {};
      var chunkMessages = Math.max(200, Math.floor(num(o.chunkMessages) || 5000));
      var maxPostings = Math.max(1, Math.floor(num(o.maxPostings) || DEFAULT_MAX_POSTINGS));
      var t0 = Date.now();

      await this.open();
      await this._ensureMeta();

      var total = await this._storeCount('messages');
      if (onProgress) { try { onProgress(0, total); } catch (e) { /* ignore */ } }

      // 1) чистим только индекс
      var tx = this._db.transaction('terms', 'readwrite');
      var done = txDone(tx);
      tx.objectStore('terms').clear();
      await done;

      // 2) чистим только индекс
      var tx = this._db.transaction('terms', 'readwrite');
      var done = txDone(tx);
      tx.objectStore('terms').clear();
      await done;

      var KR = this._resolveKeyRange();
      var canBound = !!(KR && typeof KR.lowerBound === 'function');
      var processed = 0;
      var termsTotal = 0;

      var collect = function (messages, from, to, pending) {
        for (var i = from; i < to; i++) {
          var msg = messages[i];
          if (!msg || typeof msg.content !== 'string' || !msg.content) continue;
          var terms = keywordsOf(msg.content, INDEX_TERM_LIMIT);
          for (var t = 0; t < terms.length; t++) {
            var arr = pending.get(terms[t]);
            if (!arr) { arr = []; pending.set(terms[t], arr); }
            arr.push(num(msg.seq));
          }
        }
      };

      if (!canBound) {
        // Экзотика (нет IDBKeyRange): читаем всё и режем на порции в памяти.
        var all = await this._cursorValues('messages', 'seq', null, 'next', 0);
        for (var s = 0; s < all.length; s += chunkMessages) {
          var pAll = new Map();
          var e = Math.min(all.length, s + chunkMessages);
          collect(all, s, e, pAll);
          processed = e;
          if (pAll.size) {
            var nAll = pAll.size;              // _flushIndex очищает map — считаем заранее
            await this._flushIndex(pAll, maxPostings);
            termsTotal += nAll;
          }
          if (onProgress) { try { onProgress(processed, total); } catch (err) { /* ignore */ } }
        }
        return { messages: processed, terms: termsTotal, cleared: true, durationMs: Date.now() - t0 };
      }

      // Основной путь: страница = свежая readonly-транзакция с диапазоном seq.
      var lastSeq = 0;
      while (true) {
        var page = await this._cursorValues('messages', 'seq', KR.lowerBound(lastSeq, true), 'next', chunkMessages);
        if (!page || !page.length) break;

        var pending = new Map();
        var lastInPage = lastSeq;
        for (var i = 0; i < page.length; i++) {
          if (num(page[i] && page[i].seq) > lastInPage) lastInPage = num(page[i].seq);
        }
        collect(page, 0, page.length, pending);
        processed += page.length;
        lastSeq = lastInPage;

        if (pending.size) {
          var nTerms = pending.size;           // _flushIndex очищает map — считаем заранее
          await this._flushIndex(pending, maxPostings);
          termsTotal += nTerms;
        }
        if (onProgress) { try { onProgress(processed, total); } catch (err2) { /* ignore */ } }
        if (page.length < chunkMessages) break;
      }

      return {
        messages: processed,
        terms: termsTotal,
        cleared: true,
        durationMs: Date.now() - t0
      };
    }

    /* Загрузить ГОТОВЫЙ индекс (файл masha-index.json.gz из tools/build-archive).
       Позволяет не строить индекс на телефоне: 265к сообщений индексируются
       за секунды вместо десятков секунд. Формат: {v, maxPostings, terms:{term:[seq,...]}}. */
    async loadIndex(index, opts) {
      var o = opts || {};
      var onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
      var t0 = Date.now();
      var terms = index && index.terms ? index.terms : null;
      if (!terms || typeof terms !== 'object') {
        throw new Error('loadIndex: нужен объект {terms:{терм:[seq,...]}}');
      }
      var maxPostings = Math.max(1, Math.floor(num(o.maxPostings) || num(index.maxPostings) || DEFAULT_MAX_POSTINGS));

      await this.open();
      await this._ensureMeta();

      var clearTx = this._db.transaction('terms', 'readwrite');
      var clearDone = txDone(clearTx);
      clearTx.objectStore('terms').clear();
      await clearDone;

      var keys = Object.keys(terms);
      var written = 0;
      var postings = 0;
      for (var i = 0; i < keys.length; i += TERM_MERGE_CHUNK) {
        var chunk = keys.slice(i, i + TERM_MERGE_CHUNK);
        var recs = [];
        for (var c = 0; c < chunk.length; c++) {
          var raw = terms[chunk[c]];
          var ids = Array.isArray(raw) ? raw.filter(function (s) { return num(s) > 0; }) : [];
          ids.sort(function (a, b) { return a - b; });
          if (ids.length > maxPostings) ids = ids.slice(ids.length - maxPostings);
          if (!ids.length) continue;
          recs.push({ term: chunk[c], ids: ids });
          postings += ids.length;
        }
        await this._writeTerms(recs);
        written += recs.length;
        if (onProgress) { try { onProgress(written, keys.length); } catch (e) { /* ignore */ } }
      }

      return { terms: written, postings: postings, durationMs: Date.now() - t0 };
    }

    async clear() {
      await this.open();
      var tx = this._db.transaction(['messages', 'terms', 'hashes', 'meta'], 'readwrite');
      var done = txDone(tx);
      tx.objectStore('messages').clear();
      tx.objectStore('terms').clear();
      tx.objectStore('hashes').clear();
      tx.objectStore('meta').clear();
      await done;
      this._seq = 0;
      this._sources = {};
      this._bytes = 0;
    }
  }

  /* ---------------- экспорт ---------------- */

  var api = {
    create: function (opts) { return new MemoryDb(opts); },
    db: null,
    open: function (opts) {
      var o = opts || {};
      if (!api.db) {
        api.db = new MemoryDb(o);
      } else if (o.indexedDB && !api.db._idb) {
        api.db._idb = o.indexedDB;
      }
      return api.db.open().then(function () { return api.db; });
    },
    MemoryDb: MemoryDb,
    /* Внутренние помощники — только для тестов/диагностики. */
    _internals: {
      hashMsg: hashMsg,
      normalizeRole: normalizeRole,
      isoFromTs: isoFromTs,
      dayFromTs: dayFromTs,
      mergeIds: mergeIds,
      keywordsOf: keywordsOf
    }
  };

  return api;
});
