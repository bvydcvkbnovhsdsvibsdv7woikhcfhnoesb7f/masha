/* MashaImport — чтение архивов переписки и сборка памяти.
   Форматы: Telegram (personal_chat), Qwen-экспорт, {messages:[...]}, массивы, наш архив.
   UMD: window.MashaImport / module.exports. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MashaImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (G) {
  'use strict';

  var VERSION = '2.0.0';
  var MAX_WARNINGS = 20;
  var MAX_POSTINGS_DEFAULT = 1500;
  var ROLE_KEYS = ['role', 'from', 'sender', 'author', 'senderName', 'sender_name', 'name', 'user', 'who', 'speaker'];
  var CONTENT_KEYS = ['content', 'text', 'message', 'body', 'value', 'msg'];
  var TS_KEYS = ['timestamp', 'ts', 'date', 'time', 'created_at', 'datetime', 'sentAt', 'date_unixtime'];

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function searchEngine() {
    if (G && G.MashaSearch && typeof G.MashaSearch.extractKeywords === 'function') return G.MashaSearch;
    if (typeof require === 'function') {
      try { return require('./search-engine.js'); } catch (e) { /* ignore */ }
    }
    return null;
  }

  function keywordsFor(text, limit) {
    var se = searchEngine();
    if (se) {
      try {
        var res = se.extractKeywords(text, limit || 10);
        if (Array.isArray(res)) return res;
      } catch (e) { /* fallback ниже */ }
    }
    return String(text || '').toLowerCase().replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9\s]+/g, ' ').split(/\s+/)
      .filter(function (w) { return w.length > 3; }).slice(0, limit || 10);
  }

  /* ------------------------------------------------------------- время */

  function parseTimestamp(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') {
      if (value > 1e12) return Math.floor(value);
      if (value > 1e9) return Math.floor(value * 1000);
      return 0;
    }
    var s = String(value).trim();
    if (!s) return 0;
    if (/^\d{10}$/.test(s)) return parseInt(s, 10) * 1000;
    if (/^\d{13}$/.test(s)) return parseInt(s, 10);
    var m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      var year = parseInt(m[3], 10);
      if (year < 100) year += 2000;
      return new Date(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10),
        parseInt(m[4] || '0', 10), parseInt(m[5] || '0', 10), parseInt(m[6] || '0', 10)).getTime();
    }
    var t = Date.parse(s);
    return isNaN(t) ? 0 : t;
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

  /* ------------------------------------------------------------- текст */

  function textFromValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) {
        var p = value[i];
        if (typeof p === 'string') parts.push(p);
        else if (p && typeof p === 'object') parts.push(textFromValue(p.text !== undefined ? p.text : p.content));
      }
      return parts.join('');
    }
    if (typeof value === 'object' && value.text !== undefined) return textFromValue(value.text);
    return '';
  }

  function cleanContent(text) {
    var s = String(text === null || text === undefined ? '' : text).replace(/\u0000/g, '').trim();
    if (!s) return '';
    if (/^data:image\/[a-z]+;base64,/i.test(s)) return '[фото]';
    if (s.length > 2000) s = s.slice(0, 2000) + '…';
    return s;
  }

  function placeholderFrom(raw) {
    if (!raw || typeof raw !== 'object') return '';
    var mt = raw.media_type !== undefined && raw.media_type !== null ? String(raw.media_type).toLowerCase() : '';
    if (mt === 'sticker') return raw.sticker_emoji ? '[стикер ' + raw.sticker_emoji + ']' : '[стикер]';
    if (mt === 'voice_message' || mt === 'audio_file') return '[голосовое]';
    if (mt === 'video_message') return '[кружок]';
    if (mt === 'animation') return '[гифка]';
    if (mt === 'video_file') return '[видео]';
    if (mt === 'photo') return '[фото]';
    if (mt === 'file' || mt === 'document') return /^image\//i.test(String(raw.mime_type || '')) ? '[фото]' : '[файл]';
    if (raw.poll) return '[опрос]';
    if (raw.gift_id !== undefined || raw.stars !== undefined) return '[подарок]';
    if (Array.isArray(raw.files) && raw.files.length) {
      var img = raw.files.some(function (f) { return f && /image\//i.test(String(f.type || f.mime_type || '')); });
      return img ? '[фото]' : '[файл]';
    }
    if (raw.photo || raw.image || raw.photo_url) return '[фото]';
    if (raw.sticker) return '[стикер]';
    if (raw.document || raw.voice || raw.audio || raw.video || raw.file) {
      return /^image\//i.test(String(raw.mime_type || '')) ? '[фото]' : '[файл]';
    }
    if (raw.error) return '[ответ не получен]';
    if (Array.isArray(raw.content_list)) return '[ответ не получен]';
    return '';
  }

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  /* ------------------------------------------------------------- роли */

  function normalizeRole(role) {
    var r = String(role === null || role === undefined ? '' : role).trim().toLowerCase();
    if (r === 'user' || r === 'human' || r === 'me' || r === 'я' || r === 'вы' || r === 'eduard' || r === 'эдуард') return 'user';
    if (r === 'assistant' || r === 'bot' || r === 'ai' || r === 'model' || r === 'маша' || r === 'masha') return 'assistant';
    return '';
  }

  function sameUser(a, b) {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a).trim() === String(b).trim();
  }

  function telegramPeerKeys(container) {
    var keys = [];
    if (!container || typeof container !== 'object' || Array.isArray(container)) return keys;
    var id = container.id;
    if (id !== undefined && id !== null && String(id).trim() !== '') {
      keys.push('user' + String(id).trim());
      keys.push(String(id).trim());
      keys.push('channel' + String(id).trim());
    }
    if (typeof container.name === 'string' && container.name.trim()) keys.push(container.name.trim());
    return keys;
  }

  function isPersonalChat(container) {
    if (!container || typeof container !== 'object') return false;
    var t = String(container.type || '');
    if (t === 'personal_chat' || t === 'private_chat' || t === 'saved_messages') return true;
    if (/^(public|private)_(group|supergroup|channel)$/i.test(t)) return false;
    return t === '';
  }

  /* «Она» — тот, чей id совпадает с id чата; ник может меняться, id остаётся. */
  function roleFromTelegram(raw, ctx) {
    if (!raw || typeof raw !== 'object') return '';
    var from = raw.from;
    var fid = raw.from_id !== undefined ? raw.from_id : raw.fromId;
    if (ctx.herName && (sameUser(from, ctx.herName) || sameUser(fid, ctx.herName))) return 'assistant';
    if (ctx.myName && (sameUser(from, ctx.myName) || sameUser(fid, ctx.myName))) return 'user';
    var keys = ctx.peerKeys || [];
    for (var i = 0; i < keys.length; i++) {
      if (sameUser(fid, keys[i]) || sameUser(from, keys[i])) return 'assistant';
    }
    return ctx.assumeOthersAreUser ? 'user' : '';
  }

  function detectParticipants(json) {
    var container = Array.isArray(json) ? (json[0] || {}) : (json || {});
    var msgs = container.messages;
    if (!Array.isArray(msgs) && Array.isArray(json)) msgs = json;
    if (!Array.isArray(msgs)) return [];
    var peerKeys = telegramPeerKeys(container);
    var byKey = {};
    var order = [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || typeof m !== 'object' || m.type === 'service') continue;
      var name = m.from !== undefined && m.from !== null ? String(m.from) : '';
      var id = m.from_id !== undefined ? m.from_id : m.fromId;
      var key = id !== undefined && id !== null ? String(id) : name;
      if (!key) continue;
      if (!byKey[key]) {
        var isPeer = false;
        for (var k = 0; k < peerKeys.length; k++) {
          if (sameUser(id, peerKeys[k]) || sameUser(name, peerKeys[k])) { isPeer = true; break; }
        }
        byKey[key] = { key: key, name: name, id: id === undefined ? null : id, count: 0, isPeer: isPeer };
        order.push(key);
      }
      byKey[key].count++;
    }
    return order.map(function (k) { return byKey[k]; }).sort(function (a, b) { return b.count - a.count; });
  }

  /* ------------------------------------------------------------ форматы */

  function looksLikeTelegram(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    if (m.from_id !== undefined || m.fromId !== undefined) return true;
    if (m.type === 'message' && (m.text !== undefined || m.date !== undefined)) return true;
    if (m.role === undefined && m.from !== undefined && (m.text !== undefined || m.date !== undefined)) return true;
    return false;
  }

  function isQwenChat(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (obj.chat && typeof obj.chat === 'object') {
      if (Array.isArray(obj.chat.messages)) return true;
      if (obj.chat.history && obj.chat.history.messages) return true;
    }
    if (obj.history && obj.history.messages && obj.role === undefined) return true;
    return false;
  }

  function values(obj) {
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === 'object') return Object.keys(obj).map(function (k) { return obj[k]; });
    return [];
  }

  function detectFormat(json) {
    if (json === null || json === undefined) return 'unknown';
    if (typeof json === 'string') {
      try { json = JSON.parse(json); } catch (e) { return 'unknown'; }
    }
    if (typeof json !== 'object') return 'unknown';
    if (Array.isArray(json)) {
      if (!json.length) return 'array';
      var first = json[0];
      if (Array.isArray(first)) return 'export';
      if (first && typeof first === 'object') {
        if (isQwenChat(first)) return 'qwen';
        if (looksLikeTelegram(first)) return 'telegram';
      }
      return 'array';
    }
    if (isQwenChat(json)) return 'qwen';
    var msgs = json.messages;
    if (Array.isArray(msgs)) {
      if (!msgs.length) return json.v !== undefined ? 'export' : 'messages';
      if (msgs.every(function (x) { return Array.isArray(x); })) return 'export';
      if (looksLikeTelegram(msgs[0])) return 'telegram';
      if (msgs.some(function (x) { return x && typeof x === 'object' && (x.from !== undefined || x.from_id !== undefined); })) return 'telegram';
      if (typeof json.v === 'number') return 'export';
      return 'messages';
    }
    if (msgs && typeof msgs === 'object') return 'messages';
    return 'unknown';
  }

  function normalizeMessage(raw, ctx) {
    ctx = ctx || {};
    var source = ctx.source || 'archive';
    var format = ctx.format || '';
    var report = typeof ctx.report === 'function' ? ctx.report : function () { };

    if (raw === null || raw === undefined) { report('empty'); return null; }
    if (typeof raw === 'string') raw = { content: raw };
    if (Array.isArray(raw)) raw = { role: raw[0], timestamp: raw[1], content: raw[2], id: raw[3] };
    if (typeof raw !== 'object') { report('empty'); return null; }

    if (raw.type !== undefined && raw.type !== null) {
      var tl = String(raw.type).toLowerCase();
      if (tl === 'service' || tl === 'system') { report('service'); return null; }
      if ((format === 'telegram' || format === 'messages') && tl !== 'message') { report('service'); return null; }
    }

    var role = '';
    if (typeof ctx.roleFor === 'function') role = ctx.roleFor(raw, ctx) || '';
    if (!role) {
      var rawRole = pick(raw, ROLE_KEYS);
      role = normalizeRole(rawRole);
      if (!role) {
        if (rawRole === undefined || rawRole === null || String(rawRole).trim() === '') {
          if (ctx.defaultRole) role = ctx.defaultRole;
          else { report('no-role'); return null; }
        } else { report('bad-role', String(rawRole)); return null; }
      }
    }

    var content = textFromValue(pick(raw, CONTENT_KEYS));
    if (!content && Array.isArray(raw.content_list) && raw.content_list.length) {
      var answers = [];
      for (var i = 0; i < raw.content_list.length; i++) {
        var item = raw.content_list[i];
        if (!item) continue;
        if (item.phase === 'answer' || item.phase === undefined) {
          var part = textFromValue(item.content !== undefined ? item.content : item.text);
          if (part) answers.push(part);
        }
      }
      content = answers.join('\n\n');
    }
    content = cleanContent(content);
    if (!content) {
      content = placeholderFrom(raw);
      if (!content) { report('empty'); return null; }
    }

    var ts = parseTimestamp(pick(raw, TS_KEYS));
    var extId = pick(raw, ['extId', 'id', 'message_id', 'msg_id']);
    return {
      role: role, content: content, ts: ts,
      iso: isoFromTs(ts), day: dayFromTs(ts),
      src: String(source),
      extId: extId === undefined || extId === null ? '' : String(extId)
    };
  }

  function normalizeArchive(json, opts) {
    opts = opts || {};
    var warnings = [];
    var messages = [];
    var total = 0, skipped = 0, serviceSkipped = 0;
    var src = opts.source || 'archive';

    function warn(text) {
      if (!text || warnings.length >= MAX_WARNINGS || warnings.indexOf(text) !== -1) return;
      warnings.push(text);
    }
    function report(kind, detail) {
      if (kind === 'service') serviceSkipped++;
      else if (kind === 'bad-role') warn('Неизвестная роль «' + detail + '» — сообщение пропущено');
      else if (kind === 'no-role') warn('У сообщения нет роли — пропущено');
      else if (kind === 'empty') warn('Пустое сообщение — пропущено');
    }

    var data = json;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { warn('Строка не является JSON: ' + e.message); data = null; }
    }
    var empty = { format: 'unknown', messages: [], total: 0, skipped: 0, warnings: warnings, participants: [], peerResolved: false, ambiguous: false };
    if (data === null || data === undefined) { warn('Входной JSON пустой или не распознан'); return empty; }

    var format = opts.format || detectFormat(data);
    if (format === 'unknown') { warn('Формат архива не распознан (ожидались telegram / qwen / messages / array / export)'); return empty; }

    var participants = detectParticipants(data);
    var peerKeys = telegramPeerKeys(data);
    var personal = isPersonalChat(data);
    var assumeOthers = false, peerResolved = false;
    if (format === 'telegram' && personal && participants.length) {
      for (var pi = 0; pi < participants.length; pi++) if (participants[pi].isPeer) { peerResolved = true; break; }
      if (!peerResolved && opts.herName) {
        for (var pj = 0; pj < participants.length; pj++) {
          if (sameUser(participants[pj].name, opts.herName) || sameUser(participants[pj].id, opts.herName)) { peerResolved = true; break; }
        }
      }
      if (peerResolved) assumeOthers = true;
    }

    function ctxFor(fmt) {
      var ctx = { source: src, format: fmt, report: report, defaultRole: opts.defaultRole, herName: opts.herName, myName: opts.myName };
      if (fmt === 'telegram') {
        ctx.peerKeys = peerKeys;
        ctx.assumeOthersAreUser = assumeOthers;
        ctx.roleFor = function (raw, c) { return roleFromTelegram(raw, c); };
      }
      return ctx;
    }
    function push(raw, fmt) {
      total++;
      var msg = normalizeMessage(raw, ctxFor(fmt));
      if (msg) messages.push(msg); else skipped++;
    }

    if (format === 'qwen') {
      var chats = Array.isArray(data) ? data : [data];
      for (var ci = 0; ci < chats.length; ci++) {
        var chat = chats[ci];
        var list = null;
        if (chat && chat.chat && Array.isArray(chat.chat.messages)) list = chat.chat.messages;
        else if (chat && Array.isArray(chat.messages)) list = chat.messages;
        else if (chat && chat.chat && chat.chat.history && chat.chat.history.messages) list = values(chat.chat.history.messages);
        if (!list) { warn('В qwen-чате не найдены сообщения'); continue; }
        for (var qi = 0; qi < list.length; qi++) push(list[qi], 'qwen');
      }
    } else if (format === 'export') {
      var rows = Array.isArray(data) ? data : (Array.isArray(data.messages) ? data.messages : []);
      if (!rows.length) warn('В export-архиве нет сообщений');
      for (var ei = 0; ei < rows.length; ei++) push(rows[ei], 'export');
    } else if (format === 'telegram' || format === 'messages') {
      var container = Array.isArray(data) ? data : data.messages;
      var arr = Array.isArray(container) ? container : values(container);
      if (!arr || !arr.length) warn('В файле нет массива messages');
      for (var mi = 0; mi < (arr || []).length; mi++) push(arr[mi], format);
    } else if (format === 'array') {
      if (!data.length) warn('Архив пустой — сообщений нет');
      for (var ai = 0; ai < data.length; ai++) push(data[ai], 'array');
    }

    if (!messages.length && total) warn('Ни одно сообщение не удалось распознать — проверьте формат архива');

    var ambiguous = false;
    if (!messages.length && format === 'telegram' && personal && participants.length >= 2) {
      ambiguous = true;
      warn('Не понятно, кто из участников — она: ' +
        participants.map(function (p) { return p.name || p.id; }).join(', ') +
        '. Укажите, кто из них Маша, и сообщения импортируются.');
    }

    return {
      format: format, messages: messages, total: total, skipped: skipped,
      serviceSkipped: serviceSkipped, warnings: warnings,
      participants: participants, peerResolved: peerResolved, ambiguous: ambiguous
    };
  }

  /* ------------------------------------------------------- чтение файлов */

  function toBytes(buf) {
    if (!buf) return new Uint8Array(0);
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return new Uint8Array(0);
  }

  function streamToText(stream) {
    var reader = stream.getReader();
    var decoder = new TextDecoder('utf-8');
    var out = '';
    return (function read() {
      return reader.read().then(function (r) {
        if (r.done) return out + decoder.decode();
        out += decoder.decode(r.value, { stream: true });
        return read();
      });
    })();
  }

  async function gunzipText(arrayBuffer) {
    var DS = G && G.DecompressionStream;
    var bytes = toBytes(arrayBuffer);
    if (!bytes.length) throw new Error('Пустой gzip-файл');
    if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      var plain = new TextDecoder('utf-8').decode(bytes);
      var t = plain.trim();
      if (t.charAt(0) === '{' || t.charAt(0) === '[') return plain;   // хостинг уже распаковал .gz
      throw new Error('Файл не похож на gzip (нет сигнатуры 1f 8b)');
    }
    if (typeof DS !== 'function') throw new Error('Браузер не поддерживает DecompressionStream — распакуйте .gz в .json');
    var stream = new Blob([bytes]).stream().pipeThrough(new DS('gzip'));
    if (typeof G.Response === 'function') return await new G.Response(stream).text();
    return await streamToText(stream);
  }

  async function readFileText(file) {
    if (typeof file === 'string') return file;
    if (!file) throw new Error('Пустой файл');
    if (typeof file.text === 'function') return await file.text();
    if (typeof file.arrayBuffer === 'function') {
      var buf = await file.arrayBuffer();
      var bytes = toBytes(buf);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) return await gunzipText(buf);
      return new TextDecoder('utf-8').decode(bytes);
    }
    throw new Error('У файла нет метода text() — не могу прочитать');
  }

  function toFileArray(files) {
    if (!files) return [];
    if (Array.isArray(files)) return files;
    if (typeof files.length === 'number') return Array.prototype.slice.call(files);
    return [files];
  }

  async function importFiles(files, opts) {
    opts = opts || {};
    var memory = opts.memory;
    if (!memory || typeof memory.importMessages !== 'function') throw new Error('Не передана база памяти (memory.importMessages)');
    var list = toFileArray(files);
    var source = opts.source || 'archive';
    var herName = opts.herName || '';
    var chooseHer = typeof opts.chooseHer === 'function' ? opts.chooseHer : null;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var stats = { files: 0, inserted: 0, duplicates: 0, skipped: 0, terms: 0, durationMs: 0, total: 0, format: null, formats: {}, warnings: [], errors: [] };
    var started = Date.now();
    var filesTotal = list.length;

    function emit(done, detail) {
      if (onProgress) { try { onProgress(done, filesTotal, detail || {}); } catch (e) { /* ignore */ } }
    }
    emit(0, { phase: 'start', filesTotal: filesTotal });

    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      var name = file && file.name ? file.name : 'файл-' + (i + 1);
      emit(i, { phase: 'read', file: name, index: i });
      try {
        var text = await readFileText(file);
        if (!text || !text.trim()) throw new Error('файл пустой');
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) { throw new Error('не удалось разобрать JSON (' + e.message + ')'); }

        var result = normalizeArchive(parsed, { source: source, herName: herName });
        if (result.ambiguous && chooseHer) {
          var chosen = await chooseHer(result.participants || [], name);
          if (chosen) {
            herName = chosen;
            result = normalizeArchive(parsed, { source: source, herName: chosen });
          }
        }
        stats.total += result.total;
        stats.skipped += result.skipped;
        stats.formats[result.format] = (stats.formats[result.format] || 0) + 1;
        if (!stats.format || stats.format === 'unknown') stats.format = result.format;
        for (var w = 0; w < result.warnings.length; w++) {
          if (stats.warnings.indexOf(result.warnings[w]) === -1 && stats.warnings.length < 40) stats.warnings.push(result.warnings[w]);
        }
        if (result.format === 'unknown') throw new Error('формат архива не распознан');
        if (!result.messages.length) throw new Error('в файле не найдено ни одного сообщения');

        var fileStats = await memory.importMessages(result.messages, {
          source: source,
          buildIndex: opts.buildIndex !== false,
          batchSize: opts.batchSize,
          onProgress: function (done, total) {
            emit(i, { phase: 'import', file: name, index: i, messagesDone: done, messagesTotal: total });
          }
        }) || {};

        stats.files++;
        stats.inserted += fileStats.inserted || 0;
        stats.duplicates += fileStats.duplicates || 0;
        stats.terms += fileStats.terms || 0;
        if (fileStats.skipped) stats.skipped += fileStats.skipped;
        emit(i + 1, { phase: 'file-done', file: name, index: i });
      } catch (err) {
        stats.errors.push(name + ': ' + (err && err.message ? err.message : String(err)));
        emit(i + 1, { phase: 'file-error', file: name, index: i, error: stats.errors[stats.errors.length - 1] });
      }
    }

    stats.durationMs = Date.now() - started;
    emit(filesTotal, { phase: 'done', stats: stats });
    return stats;
  }

  async function importGzipBuffer(arrayBuffer, opts) {
    opts = opts || {};
    var memory = opts.memory;
    if (!memory || typeof memory.importMessages !== 'function') throw new Error('Не передана база памяти');
    var text = await gunzipText(arrayBuffer);
    var parsed = JSON.parse(text);
    var result = normalizeArchive(parsed, { source: opts.source || 'archive', herName: opts.herName || '' });
    if (!result.messages.length) {
      return { files: 0, inserted: 0, duplicates: 0, skipped: result.skipped, terms: 0, durationMs: 0, total: result.total, format: result.format, warnings: result.warnings, errors: ['в архиве нет сообщений'] };
    }
    var memStats = await memory.importMessages(result.messages, {
      source: opts.source || 'archive',
      buildIndex: opts.buildIndex !== false,
      onProgress: opts.onProgress
    }) || {};
    return {
      files: 1, inserted: memStats.inserted || 0, duplicates: memStats.duplicates || 0,
      skipped: result.skipped + (memStats.skipped || 0), terms: memStats.terms || 0,
      durationMs: memStats.durationMs || 0, total: result.total, format: result.format,
      warnings: result.warnings, errors: []
    };
  }

  /* ------------------------------------------------- сборка архива и индекса */

  function buildArchive(messages, opts) {
    opts = opts || {};
    var list = (messages || []).filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length;
    }).slice().sort(function (a, b) {
      var ta = a.ts > 0 ? a.ts : Number.MAX_SAFE_INTEGER;
      var tb = b.ts > 0 ? b.ts : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });
    var rows = list.map(function (m) {
      var row = [m.role, m.ts > 0 ? m.ts : 0, m.content];
      var ext = m.extId !== undefined && m.extId !== null && m.extId !== '' ? String(m.extId) : '';
      if (ext) row.push(ext);
      return row;
    });
    var sources = opts.sources;
    if (!sources) {
      var set = [];
      list.forEach(function (m) { if (m.src && set.indexOf(m.src) === -1) set.push(m.src); });
      sources = set;
    }
    return { v: 1, builtAt: opts.builtAt || Date.now(), count: rows.length, sources: sources, messages: rows };
  }

  function buildIndex(rows, opts) {
    opts = opts || {};
    var maxPostings = opts.maxPostings > 0 ? opts.maxPostings : MAX_POSTINGS_DEFAULT;
    var terms = Object.create(null);
    for (var i = 0; i < (rows || []).length; i++) {
      var row = rows[i];
      if (!row) continue;
      var seq = i + 1;
      var content = Array.isArray(row) ? row[2] : row.content;
      var kws = keywordsFor(content, 10);
      for (var k = 0; k < kws.length; k++) {
        var arr = terms[kws[k]];
        if (!arr) { arr = []; terms[kws[k]] = arr; }
        arr.push(seq);
      }
    }
    var keys = Object.keys(terms);
    for (var j = 0; j < keys.length; j++) {
      var ids = terms[keys[j]];
      if (ids.length > maxPostings) terms[keys[j]] = ids.slice(ids.length - maxPostings);
    }
    return { v: 1, maxPostings: maxPostings, builtAt: Date.now(), terms: terms };
  }

  /* ------------------------------------------------------------- бэкап */

  async function exportBackup(opts) {
    opts = opts || {};
    var out = { v: 1, app: 'masha', kind: 'backup', exportedAt: Date.now(), settings: opts.settings || null, facts: opts.facts || [], messages: [] };
    var memory = opts.memory;
    if (memory) {
      try { if (typeof memory.getStats === 'function') out.archive = await memory.getStats(); } catch (e) { /* ignore */ }
      try {
        if (typeof memory.getRecent === 'function') {
          var recent = (await memory.getRecent(opts.recentLimit > 0 ? opts.recentLimit : 500)) || [];
          out.messages = recent.map(function (m) { return [m.role, m.ts > 0 ? m.ts : 0, m.content]; });
        }
      } catch (e) { /* ignore */ }
    }
    var text = JSON.stringify(out);
    if (typeof G.Blob === 'function') return new G.Blob([text], { type: 'application/json; charset=utf-8' });
    return { text: text, type: 'application/json; charset=utf-8', size: text.length };
  }

  async function importBackup(file) {
    var text = await readFileText(file);
    if (!text || !text.trim()) throw new Error('Файл бэкапа пустой');
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Не удалось разобрать бэкап: ' + e.message); }
    if (!data || typeof data !== 'object') throw new Error('Бэкап повреждён');
    return data;
  }

  return {
    version: VERSION,
    parseTimestamp: parseTimestamp,
    normalizeRole: normalizeRole,
    normalizeMessage: normalizeMessage,
    normalizeArchive: normalizeArchive,
    detectFormat: detectFormat,
    detectParticipants: detectParticipants,
    telegramPeerKeys: telegramPeerKeys,
    isPersonalChat: isPersonalChat,
    importFiles: importFiles,
    importGzipBuffer: importGzipBuffer,
    readFileText: readFileText,
    gunzipText: gunzipText,
    buildArchive: buildArchive,
    buildIndex: buildIndex,
    exportBackup: exportBackup,
    importBackup: importBackup,
    MAX_WARNINGS: MAX_WARNINGS,
    MAX_POSTINGS: MAX_POSTINGS_DEFAULT
  };
});
