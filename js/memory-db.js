/* MashaMemory — память «Маши» в IndexedDB: 265к сообщений, поиск по ключевым словам.
   UMD: window.MashaMemory / module.exports. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MashaMemory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (G) {
  'use strict';

  var DEFAULT_NAME = 'masha_memory';
  var DEFAULT_VERSION = 1;
  var DEFAULT_MAX_POSTINGS = 1500;
  var TERM_CHUNK = 300;
  var INDEX_TERMS_PER_MSG = 10;

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

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

  function normalizeRole(role) {
    var r = String(role === null || role === undefined ? '' : role).trim().toLowerCase();
    if (r === 'user' || r === 'human' || r === 'me' || r === 'я' || r === 'вы' ||
      r === 'eduard' || r === 'эдуард') return 'user';
    if (r === 'assistant' || r === 'bot' || r === 'ai' || r === 'model' ||
      r === 'маша' || r === 'masha') return 'assistant';
    return '';
  }

  function getSearchEngine() {
    if (G && G.MashaSearch && typeof G.MashaSearch.extractKeywords === 'function') return G.MashaSearch;
    if (typeof require === 'function') {
      try { return require('./search-engine.js'); } catch (e) { /* ignore */ }
    }
    return null;
  }

  function keywordsOf(text, limit) {
    var se = getSearchEngine();
    if (se) {
      try {
        var res = se.extractKeywords(text, limit || INDEX_TERMS_PER_MSG);
        return Array.isArray(res) ? res : [];
      } catch (e) { /* упрощённый разбор ниже */ }
    }
    return String(text || '').toLowerCase().replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9\s]+/g, ' ').split(/\s+/)
      .filter(function (w) { return w.length > 3; }).slice(0, limit || INDEX_TERMS_PER_MSG);
  }

  /* Двойной djb2 — ключ дедупликации повторного импорта. */
  function hashMsg(role, ts, content) {
    var s = String(role) + '|' + num(ts) + '|' + String(content);
    var h1 = 5381, h2 = 52711;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (((h1 << 5) + h1) + c) >>> 0;
      h2 = (((h2 << 5) + h2) ^ (c + i)) >>> 0;
    }
    return 'd2' + h1.toString(36) + '.' + h2.toString(36);
  }

  function requestDone(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB: ошибка запроса')); };
    });
  }

  /* Ошибка записи в IndexedDB. Чаще всего это нехватка места на диске
     (QuotaExceededError) — тогда человеку нужно освободить место, а не чинить код. */
  function dbError(err, fallback) {
    var e = err || {};
    var name = e.name || '';
    var message = e.message || fallback || 'ошибка транзакции';
    var out = new Error('IndexedDB: ' + message + (name ? ' (' + name + ')' : ''));
    out.name = name || 'IndexedDBError';
    out.cause = message;
    if (/quota|space|disk|storage/i.test(name + ' ' + message)) {
      out.name = 'QuotaExceededError';
      out.message = 'IndexedDB: на диске (или в хранилище браузера) не хватает места — освободи 1–2 ГБ и повтори импорт';
    }
    return out;
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(dbError(tx.error, 'ошибка транзакции')); };
      tx.onabort = function () { reject(dbError(tx.error, 'транзакция прервана — скорее всего мало места на диске')); };
    });
  }

  function mergeIds(oldIds, newIds, maxPostings) {
    var set = new Set();
    var i;
    if (oldIds && oldIds.length) for (i = 0; i < oldIds.length; i++) set.add(oldIds[i]);
    if (newIds && newIds.length) for (i = 0; i < newIds.length; i++) set.add(newIds[i]);
    var arr = Array.from(set).sort(function (a, b) { return a - b; });
    return arr.length > maxPostings ? arr.slice(arr.length - maxPostings) : arr;
  }

  function MemoryDb(opts) {
    var o = opts || {};
    this.name = o.name || DEFAULT_NAME;
    this.version = num(o.version) || DEFAULT_VERSION;
    this._idb = o.indexedDB || null;
    this._kr = o.IDBKeyRange || null;
    this._db = null;
    this._opening = null;
    this._seq = null;
    this._sources = null;
    this._bytes = null;
  }

  MemoryDb.prototype._idbApi = function () {
    return this._idb || (G && G.indexedDB) || (G && G.window && G.window.indexedDB) || null;
  };

  MemoryDb.prototype._keyRange = function () {
    return this._kr || (G && G.IDBKeyRange) || null;
  };

  MemoryDb.prototype.open = function () {
    var self = this;
    if (this._db) return Promise.resolve();
    if (this._opening) return this._opening;
    var idb = this._idbApi();
    if (!idb || typeof idb.open !== 'function') {
      return Promise.reject(new Error('IndexedDB недоступен в этом окружении'));
    }
    this._opening = new Promise(function (resolve, reject) {
      var req;
      try { req = idb.open(self.name, self.version); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('messages')) {
          var store = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
          store.createIndex('seq', 'seq', { unique: true });
          store.createIndex('ts', 'ts', { unique: false });
          store.createIndex('role', 'role', { unique: false });
          store.createIndex('src', 'src', { unique: false });
        }
        if (!db.objectStoreNames.contains('terms')) db.createObjectStore('terms', { keyPath: 'term' });
        if (!db.objectStoreNames.contains('hashes')) db.createObjectStore('hashes', { keyPath: 'h' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = function () { self._db = req.result; self._opening = null; resolve(); };
      req.onerror = function () { self._opening = null; reject(req.error || new Error('Не удалось открыть IndexedDB')); };
      req.onblocked = function () { /* другая вкладка держит старую версию */ };
    });
    return this._opening;
  };

  MemoryDb.prototype._ensureMeta = async function () {
    if (this._seq !== null && this._sources !== null && this._bytes !== null) return;
    await this.open();
    var tx = this._db.transaction('meta', 'readonly');
    var done = txDone(tx);
    var all = await requestDone(tx.objectStore('meta').getAll());
    await done;
    this._seq = 0; this._sources = {}; this._bytes = 0;
    for (var i = 0; i < (all || []).length; i++) {
      var r = all[i];
      if (!r) continue;
      if (r.k === 'seq') this._seq = num(r.v);
      else if (r.k === 'sources') this._sources = r.v && typeof r.v === 'object' ? r.v : {};
      else if (r.k === 'bytes') this._bytes = num(r.v);
    }
  };

  MemoryDb.prototype.count = async function () {
    await this.open();
    var tx = this._db.transaction('messages', 'readonly');
    var done = txDone(tx);
    var n = await requestDone(tx.objectStore('messages').count());
    await done;
    return num(n);
  };

  function prepare(raw, source) {
    if (!raw || typeof raw !== 'object') return null;
    var role = normalizeRole(raw.role);
    if (!role) return null;
    var content = String(raw.content === null || raw.content === undefined ? '' : raw.content).trim();
    if (!content) return null;
    var ts = num(raw.ts);
    return {
      role: role,
      content: content,
      ts: ts,
      iso: typeof raw.iso === 'string' && raw.iso ? raw.iso : isoFromTs(ts),
      day: typeof raw.day === 'string' && raw.day ? raw.day : dayFromTs(ts),
      src: typeof raw.src === 'string' && raw.src ? raw.src : source,
      extId: raw.extId === undefined || raw.extId === null || raw.extId === '' ? '' : String(raw.extId),
      rawSeq: num(raw.seq)
    };
  }

  /* id из исходного архива входит в ключ: одинаковые реплики в одну секунду
     не схлопываются, а повторный импорт остаётся идемпотентным. */
  function messageHash(rec) {
    return hashMsg(rec.role, rec.ts, rec.content + (rec.extId ? '\u0000#' + rec.extId : ''));
  }

  MemoryDb.prototype.append = async function (msg) {
    await this.open();
    await this._ensureMeta();
    var rec = prepare(msg, 'live');
    if (!rec) throw new Error('MashaMemory.append: пустое сообщение или неизвестная роль');
    rec.seq = this._seq + 1;
    rec.h = messageHash(rec);
    var tx = this._db.transaction(['messages', 'hashes', 'meta'], 'readwrite');
    var done = txDone(tx);
    var store = tx.objectStore('messages');
    store.add({ seq: rec.seq, role: rec.role, content: rec.content, ts: rec.ts, iso: rec.iso, day: rec.day, src: rec.src });
    tx.objectStore('hashes').put({ h: rec.h, seq: rec.seq });
    this._seq = rec.seq;
    this._bytes += rec.content.length;
    this._sources[rec.src] = num(this._sources[rec.src]) + 1;
    var meta = tx.objectStore('meta');
    meta.put({ k: 'seq', v: this._seq });
    meta.put({ k: 'sources', v: JSON.parse(JSON.stringify(this._sources)) });
    meta.put({ k: 'bytes', v: this._bytes });
    await done;
    try {
      var kws = keywordsOf(rec.content, INDEX_TERMS_PER_MSG);
      if (kws.length) {
        var map = new Map();
        kws.forEach(function (t) { map.set(t, [rec.seq]); });
        await this._flushIndex(map, DEFAULT_MAX_POSTINGS);
      }
    } catch (e) { /* индекс живого сообщения не критичен */ }
    return rec.seq;
  };

  /* Пишет батч, а если транзакция падает — делит его пополам и пробует снова.
     Так одно «плохое» сообщение (или разовая нехватка места) не роняет весь импорт:
     испорченная запись пропускается и попадает в статистику. */
  MemoryDb.prototype._writeResilient = async function (records, stats, depth) {
    depth = depth || 0;
    try {
      await this._writeBatch(records);
      stats.inserted += records.length;
      return;
    } catch (err) {
      var quota = /quota|space|мест/i.test(String((err && err.name) || '') + ' ' + String((err && err.message) || ''));
      if (quota && depth === 0) throw err;           // места нет — дробить бессмысленно
      if (records.length <= 1) {
        stats.skipped = num(stats.skipped) + 1;
        stats.failed = num(stats.failed) + 1;
        stats.lastError = ((err && err.name) || 'ошибка') + ': ' + ((err && err.message) || '');
        if (!stats.problems) stats.problems = [];
        if (stats.problems.length < 10) stats.problems.push((records[0].day || '') + ' ' + String(records[0].content || '').slice(0, 60));
        return;
      }
      var half = Math.floor(records.length / 2);
      await this._writeResilient(records.slice(0, half), stats, depth + 1);
      await this._writeResilient(records.slice(half), stats, depth + 1);
    }
  };

  MemoryDb.prototype._writeBatch = async function (records) {
    var tx = this._db.transaction(['messages', 'hashes', 'meta'], 'readwrite');
    var done = txDone(tx);
    var msgs = tx.objectStore('messages');
    var hashes = tx.objectStore('hashes');
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      msgs.add({ seq: r.seq, role: r.role, content: r.content, ts: r.ts, iso: r.iso, day: r.day, src: r.src });
      hashes.put({ h: r.h, seq: r.seq });
    }
    var meta = tx.objectStore('meta');
    meta.put({ k: 'seq', v: this._seq });
    meta.put({ k: 'sources', v: JSON.parse(JSON.stringify(this._sources)) });
    meta.put({ k: 'bytes', v: this._bytes });
    meta.put({ k: 'importedAt', v: Date.now() });
    await done;
  };

  MemoryDb.prototype._readTerms = async function (keys) {
    if (!keys || !keys.length) return [];
    await this.open();
    var tx = this._db.transaction('terms', 'readonly');
    var done = txDone(tx);
    var recs = await requestDone(tx.objectStore('terms').getAll(keys));
    await done;
    return recs || [];
  };

  MemoryDb.prototype._writeTerms = async function (recs) {
    if (!recs || !recs.length) return;
    await this.open();
    var tx = this._db.transaction('terms', 'readwrite');
    var done = txDone(tx);
    var store = tx.objectStore('terms');
    for (var i = 0; i < recs.length; i++) store.put(recs[i]);
    await done;
  };

  /* Слияние постингов: читаем только затронутые термы, не всю базу. */
  MemoryDb.prototype._flushIndex = async function (pending, maxPostings) {
    var terms = Array.from(pending.keys());
    for (var i = 0; i < terms.length; i += TERM_CHUNK) {
      var chunk = terms.slice(i, i + TERM_CHUNK);
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
  };

  MemoryDb.prototype.importMessages = async function (messages, opts) {
    var o = opts || {};
    var source = o.source || 'archive';
    var batchSize = Math.max(1, Math.floor(num(o.batchSize) || 500));
    var indexBatch = Math.max(1, Math.floor(num(o.indexBatch) || 20000));
    var maxPostings = Math.max(1, Math.floor(num(o.maxPostings) || DEFAULT_MAX_POSTINGS));
    var buildIndex = o.buildIndex !== false;
    var skipDuplicates = o.skipDuplicates !== false;
    var onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
    var list = Array.isArray(messages) ? messages : [];
    var total = list.length;
    var stats = { inserted: 0, duplicates: 0, skipped: 0, failed: 0, terms: 0, durationMs: 0, lastError: '', problems: [] };
    var t0 = Date.now();

    await this.open();
    await this._ensureMeta();
    if (!total) {
      stats.durationMs = Date.now() - t0;
      if (onProgress) onProgress(0, 0);
      return stats;
    }

    var pending = buildIndex ? new Map() : null;
    var pendingCount = 0;
    var touched = new Set();

    for (var start = 0; start < total; start += batchSize) {
      var end = Math.min(total, start + batchSize);
      var prepared = [];
      var seen = new Set();
      for (var i = start; i < end; i++) {
        var p = prepare(list[i], source);
        if (!p) { stats.skipped++; continue; }
        p.h = messageHash(p);
        if (seen.has(p.h)) { stats.duplicates++; continue; }
        seen.add(p.h);
        prepared.push(p);
      }

      var fresh = prepared;
      if (skipDuplicates && prepared.length) {
        var txc = this._db.transaction('hashes', 'readonly');
        var donec = txDone(txc);
        var known = await requestDone(txc.objectStore('hashes').getAll(prepared.map(function (x) { return x.h; })));
        await donec;
        var knownSet = new Set((known || []).map(function (r) { return r.h; }));
        fresh = prepared.filter(function (x) {
          if (knownSet.has(x.h)) { stats.duplicates++; return false; }
          return true;
        });
      }

      if (fresh.length) {
        for (var f = 0; f < fresh.length; f++) {
          var want = Math.floor(fresh[f].rawSeq);
          var seq = want > this._seq ? want : this._seq + 1;
          fresh[f].seq = seq;
          this._seq = seq;
          this._bytes += fresh[f].content.length;
        }
        this._sources[source] = num(this._sources[source]) + fresh.length;
        await this._writeResilient(fresh, stats);

        if (pending) {
          for (var a = 0; a < fresh.length; a++) {
            var terms = keywordsOf(fresh[a].content, INDEX_TERMS_PER_MSG);
            for (var t = 0; t < terms.length; t++) {
              var arr = pending.get(terms[t]);
              if (!arr) { arr = []; pending.set(terms[t], arr); }
              arr.push(fresh[a].seq);
              touched.add(terms[t]);
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

      if (onProgress) { try { onProgress(Math.min(end, total), total); } catch (e) { /* ignore */ } }
    }

    if (pending && pending.size) await this._flushIndex(pending, maxPostings);
    stats.terms = touched.size;
    stats.durationMs = Date.now() - t0;
    return stats;
  };

  MemoryDb.prototype._messagesBySeq = async function (seqs) {
    if (!seqs || !seqs.length) return [];
    await this.open();
    var tx = this._db.transaction('messages', 'readonly');
    var done = txDone(tx);
    var rows = await requestDone(tx.objectStore('messages').index('seq').getAll(seqs));
    await done;
    rows = rows || [];
    rows.sort(function (a, b) { return a.seq - b.seq; });
    return rows;
  };

  /* Взвешивание по редкости терма (упрощённый IDF): редкие слова важнее частых. */
  MemoryDb.prototype.search = async function (terms, opts) {
    var o = opts || {};
    var limit = o.limit === undefined || o.limit === null ? 40 : Math.max(0, Math.floor(num(o.limit)));
    if (!limit) return [];
    await this.open();

    var lookup = [];
    var seenTerm = Object.create(null);
    for (var i = 0; i < (terms || []).length; i++) {
      var t = String(terms[i] || '').toLowerCase();
      if (!t || seenTerm[t]) continue;
      seenTerm[t] = true;
      lookup.push(t);
      // Устойчивость к разным версиям стемминга: индекс мог быть построен другой
      // версией алгоритма («поссорили» против «поссор»). Ищем по всем вариантам,
      // иначе половина естественных вопросов не находит воспоминаний.
      var se = getSearchEngine();
      var variants = (se && typeof se.termVariants === 'function') ? se.termVariants(t) : [];
      for (var v = 0; v < variants.length; v++) {
        var alt = String(variants[v] || '').toLowerCase();
        if (alt && !seenTerm[alt]) { seenTerm[alt] = true; lookup.push(alt); }
      }
    }
    if (!lookup.length) return [];

    var recs = await this._readTerms(lookup);
    if (!recs.length) return [];

    var hits = new Map();
    for (var r = 0; r < recs.length; r++) {
      var ids = (recs[r] && recs[r].ids) || [];
      if (!ids.length) continue;
      var w = 1 / Math.log2(2 + ids.length);
      for (var j = 0; j < ids.length; j++) hits.set(ids[j], (hits.get(ids[j]) || 0) + w);
    }
    if (!hits.size) return [];

    var seqs = Array.from(hits.keys());
    if (seqs.length > limit) {
      seqs.sort(function (a, b) { return (hits.get(b) - hits.get(a)) || (b - a); });
      seqs = seqs.slice(0, limit);
    }
    var msgs = await this._messagesBySeq(seqs);
    var out = msgs.map(function (m) { return { msg: m, score: Math.round((hits.get(m.seq) || 0) * 1000) }; });
    out.sort(function (a, b) { return b.score - a.score || b.msg.seq - a.msg.seq; });
    return out;
  };

  MemoryDb.prototype.recall = async function (query, opts) {
    var t0 = Date.now();
    var o = opts || {};
    var episodeLimit = Math.max(1, Math.floor(num(o.episodeLimit) || 6));
    var radius = o.radius === undefined || o.radius === null ? 2 : Math.max(0, Math.floor(num(o.radius)));

    var terms = keywordsOf(String(query || ''), 12);
    if (!terms.length) return { episodes: [], matched: 0, tookMs: 0 };

    var found = await this.search(terms, { limit: Math.max(episodeLimit * 60, 300) });
    if (!found.length) return { episodes: [], matched: 0, tookMs: Date.now() - t0 };

    var anchors = [];
    for (var i = 0; i < found.length && anchors.length < episodeLimit; i++) {
      var s = found[i].msg.seq;
      var tooClose = false;
      for (var a = 0; a < anchors.length; a++) {
        if (Math.abs(anchors[a] - s) <= radius * 2) { tooClose = true; break; }
      }
      if (!tooClose) anchors.push(s);
    }
    if (!anchors.length) return { episodes: [], matched: 0, tookMs: Date.now() - t0 };

    var anchorSet = new Set(anchors);
    var need = [];
    var needSet = new Set();
    for (var an = 0; an < anchors.length; an++) {
      for (var k = anchors[an] - radius; k <= anchors[an] + radius; k++) {
        if (k > 0 && !anchorSet.has(k) && !needSet.has(k)) { needSet.add(k); need.push(k); }
      }
    }
    var neighbors = await this._messagesBySeq(need);
    var bySeq = new Map();
    neighbors.forEach(function (m) { bySeq.set(m.seq, m); });
    found.forEach(function (f) { bySeq.set(f.msg.seq, f.msg); });

    var episodes = [];
    for (var x = 0; x < anchors.length; x++) {
      var items = [];
      for (var sq = anchors[x] - radius; sq <= anchors[x] + radius; sq++) {
        var it = bySeq.get(sq);
        if (it) items.push(it);
      }
      if (!items.length) continue;
      episodes.push({ seq: anchors[x], ts: num(items[0].ts), items: items });
    }

    var se = getSearchEngine();
    var unique = se && se.dedupeEpisodes ? se.dedupeEpisodes(episodes) : episodes;
    return { episodes: unique, matched: found.length, tookMs: Date.now() - t0 };
  };

  /* Случайные «живые» воспоминания из архива — на случай вопроса вроде
     «что ты помнишь?», где ключевых слов нет и поиск ничего не даёт.
     Берём сообщения из разных мест архива, пропуская короткий мусор («ну», «ага»). */
  MemoryDb.prototype.sample = async function (count) {
    var need = Math.max(1, Math.min(30, Math.floor(num(count)) || 5));
    await this.open();
    var total = await this.count();
    if (!total) return [];
    var store = this._db.transaction('messages', 'readonly').objectStore('messages');
    var out = [];
    var seen = {};
    var tries = 0;
    while (out.length < need && tries < need * 8) {
      tries++;
      var id = 1 + Math.floor(Math.random() * total);
      var rec;
      try { rec = await requestDone(store.get(id)); } catch (e) { continue; }
      if (!rec || seen[rec.seq]) continue;
      var text = String(rec.content || '').replace(/\s+/g, ' ').trim();
      if (text.length < 12 || /^\[/.test(text)) continue;   // «ну», «ага», «[фото]»
      seen[rec.seq] = true;
      out.push({ seq: rec.seq, role: rec.role, content: rec.content, ts: rec.ts });
    }
    out.sort(function (a, b) { return a.ts - b.ts; });
    return out;
  };

  MemoryDb.prototype.getRecent = async function (limit) {
    var n = limit === undefined || limit === null ? 20 : Math.max(0, Math.floor(num(limit)));
    if (!n) return [];
    await this.open();
    var out = [];
    var tx = this._db.transaction('messages', 'readonly');
    var req = tx.objectStore('messages').index('seq').openCursor(null, 'prev');
    await new Promise(function (resolve, reject) {
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur || out.length >= n) { resolve(); return; }
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = function () { reject(req.error); };
    });
    out.reverse();
    return out;
  };

  MemoryDb.prototype.getStats = async function () {
    await this.open();
    await this._ensureMeta();
    var messages = await this.count();
    var tx = this._db.transaction('terms', 'readonly');
    var done = txDone(tx);
    var terms = await requestDone(tx.objectStore('terms').count());
    await done;

    var oldest = 0, newest = 0;
    if (messages) {
      var first = await this._messagesBySeq([1]);
      var last = await this._messagesBySeq([this._seq]);
      if (first.length) oldest = num(first[0].ts);
      if (last.length) newest = num(last[0].ts);
    }
    return {
      messages: messages,
      terms: num(terms),
      oldest: oldest,
      newest: newest,
      sources: Object.keys(this._sources || {}),
      estBytes: this._bytes || 0
    };
  };

  MemoryDb.prototype.rebuildIndex = async function (onProgress, opts) {
    var o = opts || {};
    var chunkMessages = Math.max(200, Math.floor(num(o.chunkMessages) || 5000));
    var maxPostings = Math.max(1, Math.floor(num(o.maxPostings) || DEFAULT_MAX_POSTINGS));
    var t0 = Date.now();

    await this.open();
    await this._ensureMeta();
    var total = await this.count();
    if (onProgress) onProgress(0, total);

    var tx = this._db.transaction('terms', 'readwrite');
    var done = txDone(tx);
    tx.objectStore('terms').clear();
    await done;

    var self = this;
    var KR = this._keyRange();
    var processed = 0, termsTotal = 0, lastSeq = 0;
    while (true) {
      var range = KR && KR.lowerBound ? KR.lowerBound(lastSeq, true) : null;
      var page = await new Promise(function (resolve, reject) {
        var rtx = self._db.transaction('messages', 'readonly');
        var out = [];
        var req = rtx.objectStore('messages').index('seq').openCursor(range, 'next');
        req.onsuccess = function () {
          var cur = req.result;
          if (!cur || out.length >= chunkMessages) { resolve(out); return; }
          out.push(cur.value);
          cur.continue();
        };
        req.onerror = function () { reject(req.error); };
      });
      if (!page.length) break;

      var pending = new Map();
      for (var i = 0; i < page.length; i++) {
        var m = page[i];
        lastSeq = Math.max(lastSeq, num(m.seq));
        var kws = keywordsOf(m.content, INDEX_TERMS_PER_MSG);
        for (var k = 0; k < kws.length; k++) {
          var arr = pending.get(kws[k]);
          if (!arr) { arr = []; pending.set(kws[k], arr); }
          arr.push(num(m.seq));
        }
      }
      processed += page.length;
      if (pending.size) {
        var n = pending.size;
        await this._flushIndex(pending, maxPostings);
        termsTotal += n;
      }
      if (onProgress) onProgress(processed, total);
      if (page.length < chunkMessages) break;
    }
    return { messages: processed, terms: termsTotal, durationMs: Date.now() - t0 };
  };

  MemoryDb.prototype.loadIndex = async function (index, onProgress) {
    var terms = index && index.terms ? index.terms : null;
    if (!terms || typeof terms !== 'object') throw new Error('loadIndex: нужен объект {terms:{...}}');
    var maxPostings = Math.max(1, Math.floor(num(index.maxPostings) || DEFAULT_MAX_POSTINGS));
    var t0 = Date.now();

    await this.open();
    var tx = this._db.transaction('terms', 'readwrite');
    var done = txDone(tx);
    tx.objectStore('terms').clear();
    await done;

    var keys = Object.keys(terms);
    var written = 0, postings = 0;
    for (var i = 0; i < keys.length; i += TERM_CHUNK) {
      var chunk = keys.slice(i, i + TERM_CHUNK);
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
      if (onProgress) onProgress(written, keys.length);
    }
    return { terms: written, postings: postings, durationMs: Date.now() - t0 };
  };

  MemoryDb.prototype.clear = async function () {
    await this.open();
    var tx = this._db.transaction(['messages', 'terms', 'hashes', 'meta'], 'readwrite');
    var done = txDone(tx);
    tx.objectStore('messages').clear();
    tx.objectStore('terms').clear();
    tx.objectStore('hashes').clear();
    tx.objectStore('meta').clear();
    await done;
    this._seq = 0; this._sources = {}; this._bytes = 0;
  };

  var api = {
    create: function (opts) { return new MemoryDb(opts); },
    db: null,
    open: function (opts) {
      var o = opts || {};
      if (!api.db) api.db = new MemoryDb(o);
      else if (o.indexedDB && !api.db._idb) api.db._idb = o.indexedDB;
      return api.db.open().then(function () { return api.db; });
    },
    MemoryDb: MemoryDb,
    _internals: { hashMsg: hashMsg, normalizeRole: normalizeRole, keywordsOf: keywordsOf }
  };
  return api;
});
