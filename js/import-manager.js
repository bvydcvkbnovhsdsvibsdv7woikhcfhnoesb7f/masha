/*
 * MashaImport — импорт архивов переписки «Маша».
 *
 * Что делает:
 *  - автоопределяет 4 формата архивов: array / messages(Telegram result.json) / qwen / export;
 *  - приводит любые сообщения к единому виду {role, content, ts, iso, day, src};
 *  - читает файлы через File.text()/arrayBuffer() (никакого fetch — работает с file://);
 *  - распаковывает .json.gz / .bin через DecompressionStream('gzip');
 *  - кормит нормализованные сообщения в memory.importMessages(...) по одному файлу за раз;
 *  - умеет gzip/plain-сборку переносимого архива + индекс термов (для CLI и build-archive.html).
 *
 * UMD: в браузере -> window.MashaImport, в Node -> module.exports.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MashaImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_WARNINGS = 20;
  var MAX_POSTINGS_DEFAULT = 1500;

  /* ------------------------------------------------------------------ роли */

  var USER_ROLES = words('user human me self я вы эдуард eduard пользователь юзер owner клиент');
  var ASSISTANT_ROLES = words('assistant bot ai model маша masha gpt chatgpt ассистент бот помощник');

  function words(str) {
    var out = Object.create(null);
    var parts = str.split(' ');
    for (var i = 0; i < parts.length; i++) if (parts[i]) out[parts[i]] = true;
    return out;
  }

  /**
   * Нормализует роль: user/human/me/я/вы/Эдуард -> 'user',
   * assistant/bot/ai/model/Маша/masha -> 'assistant', иначе ''.
   */
  function normalizeRole(value) {
    if (value === null || value === undefined) return '';
    var s = String(value).trim().toLowerCase().replace(/^@/, '');
    if (!s) return '';
    if (USER_ROLES[s]) return 'user';
    if (ASSISTANT_ROLES[s]) return 'assistant';
    // «Вы» в телеграм-стиле и подписи вида "Маша (AI)"
    if (s.indexOf('маша') === 0 || s.indexOf('masha') === 0) return 'assistant';
    if (s.indexOf('эдуард') === 0 || s.indexOf('eduard') === 0) return 'user';
    return '';
  }

  /* ------------------------------------------------------------------ даты */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var RX_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  var RX_DOT = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

  /**
   * parseTimestamp(value) -> epoch ms (0, если распознать не удалось).
   * Поддерживает: unix sec, unix ms, ISO-8601, 'YYYY-MM-DD HH:MM(:SS)',
   * 'DD.MM.YYYY HH:MM:SS' и числовые строки.
   */
  function parseTimestamp(value) {
    if (value === null || value === undefined) return 0;

    if (typeof value === 'number') {
      if (!isFinite(value) || value <= 0) return 0;
      // < 1e11 — это секунды (1e11 мс = 1973 год, 1e11 сек = 5138 год)
      return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
    }

    var s = String(value).trim();
    if (!s) return 0;

    // Числовая строка: секунды или миллисекунды
    if (/^\d+(\.\d+)?$/.test(s)) return parseTimestamp(parseFloat(s));

    var m = RX_DOT.exec(s);
    if (m) {
      var y = parseInt(m[3], 10);
      if (y < 100) y += y >= 70 ? 1900 : 2000;
      var d = new Date(
        y,
        parseInt(m[2], 10) - 1,
        parseInt(m[1], 10),
        m[4] ? parseInt(m[4], 10) : 0,
        m[5] ? parseInt(m[5], 10) : 0,
        m[6] ? parseInt(m[6], 10) : 0
      );
      var t = d.getTime();
      return isFinite(t) && t > 0 ? t : 0;
    }

    if (RX_ISO.test(s)) {
      // 'YYYY-MM-DD HH:MM' без зоны V8 понимает как локальное время — то, что нужно
      var iso = Date.parse(s);
      if (isFinite(iso) && iso > 0) return iso;
      return 0;
    }

    // Последний шанс: пусть попробует движок ("12 Aug 2024 21:14", RFC и т.п.)
    var fallback = Date.parse(s);
    return isFinite(fallback) && fallback > 0 ? fallback : 0;
  }

  /** 'YYYY-MM-DD HH:MM' локально из ts ('' если ts=0). */
  function isoFromTs(ts) {
    if (!(ts > 0)) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 'YYYY-MM-DD' локально из ts ('' если ts=0). */
  function dayFromTs(ts) {
    if (!(ts > 0)) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* --------------------------------------------------------------- контент */

  /**
   * Достаёт текст из чего угодно: строки, числа, массива фрагментов
   * (Telegram plain/bold/link), объекта {text|content|value}.
   */
  function textFromValue(value, opts) {
    opts = opts || {};
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return '';
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) {
        var p = textFromValue(value[i], opts);
        if (p) parts.push(p);
      }
      return parts.join(opts.separator || '');
    }
    if (typeof value === 'object') {
      var kind = String(value.type || '').toLowerCase();
      if (kind === 'image' || kind === 'photo') return '[фото]';
      if (kind === 'sticker') return '[стикер]';
      if (kind === 'voice' || kind === 'audio' || kind === 'video' || kind === 'document' || kind === 'file') return '[файл]';
      var inner = value.text !== undefined ? value.text
        : value.content !== undefined ? value.content
          : value.value !== undefined ? value.value
            : value.message !== undefined ? value.message
              : '';
      return textFromValue(inner, opts);
    }
    return '';
  }

  /** Чистка текста: \\r\\n -> \\n, вырезание base64, схлопывание пустых строк. */
  function cleanContent(text) {
    if (!text) return '';
    var s = String(text).replace(/\r\n?/g, '\n');
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(s)) return '[фото]';
    s = s.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{120,}/gi, '[фото]');
    s = s.replace(/[ \t]+\n/g, '\n');
    s = s.replace(/\n{4,}/g, '\n\n\n');
    s = s.trim();
    if (s.length > 400 && /base64/i.test(s)) {
      s = s.replace(/[A-Za-z0-9+/=]{200,}/g, '[вложение]');
    }
    return s.trim();
  }

  function isImageFile(f) {
    if (!f || typeof f !== 'object') return false;
    var t = String(f.type || '') + ' ' + String(f.file_type || '') + ' ' + String(f.mime_type || '');
    if (/image\//i.test(t)) return true;
    return /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(String(f.name || f.file_name || ''));
  }

  /** Заглушка вместо пустого сообщения — если у записи есть хоть какая-то нагрузка. */
  function placeholderFrom(raw, ctx) {
    if (!raw || typeof raw !== 'object') return '';
    // Telegram: сначала смотрим media_type — по нему видно, что именно прислали
    var mt = raw.media_type !== undefined && raw.media_type !== null ? String(raw.media_type).toLowerCase() : '';
    if (mt) {
      if (mt === 'sticker') return raw.sticker_emoji ? '[стикер ' + raw.sticker_emoji + ']' : '[стикер]';
      if (mt === 'voice_message' || mt === 'audio_file') return '[голосовое]';
      if (mt === 'video_message') return '[кружок]';
      if (mt === 'animation') return '[гифка]';
      if (mt === 'video_file') return '[видео]';
      if (mt === 'photo') return '[фото]';
      if (mt === 'file' || mt === 'document') {
        return /^image\//i.test(String(raw.mime_type || '')) ? '[фото]' : '[файл]';
      }
    }
    if (raw.gif_id !== undefined || raw.gif_url) return '[гифка]';
    if (raw.voice || raw.voice_message) return '[голосовое]';
    if (raw.poll) return '[опрос]';
    if (raw.gift_id !== undefined || raw.stars !== undefined) return '[подарок]';
    if (Array.isArray(raw.files) && raw.files.length) {
      var img = false;
      for (var i = 0; i < raw.files.length; i++) if (isImageFile(raw.files[i])) { img = true; break; }
      return img ? '[фото]' : '[файл]';
    }
    if (raw.photo || raw.image || raw.photo_url) return '[фото]';
    if (raw.sticker) return '[стикер]';
    if (raw.document || raw.voice || raw.audio || raw.video || raw.file) {
      return /^image\//i.test(String(raw.mime_type || '')) ? '[фото]' : '[файл]';
    }
    if (raw.error) return '[ответ не получен]';
    // Qwen-поворот без текста (генерация прервана/цензура) — ход диалога важнее текста
    if (Array.isArray(raw.content_list)) return '[ответ не получен]';
    if (ctx && ctx.keepEmpty) return '[сообщение без текста]';
    return '';
  }

  /* ------------------------------------------------------------------ Telegram
   * В экспорте личного чата Telegram собеседник (она) — тот, чей id совпадает
   * с id самого чата (для личного чата top-level id = id собеседника).
   * Ник при этом не важен: он мог меняться (ガビマル -> ヒロ), а id остаётся.
   * Все остальные участники — он (пользователь).
   */
  function telegramPeerKeys(container) {
    var keys = [];
    if (!container || typeof container !== 'object' || Array.isArray(container)) return keys;
    var id = container.id;
    if (id !== undefined && id !== null && String(id).trim() !== '') {
      keys.push('user' + String(id).trim());
      keys.push(String(id).trim());
      keys.push('channel' + String(id).trim());
    }
    var nm = container.name;
    if (typeof nm === 'string' && nm.trim()) keys.push(nm.trim());
    return keys;
  }

  function isPersonalChat(container) {
    if (!container || typeof container !== 'object') return false;
    var t = String(container.type || '');
    if (t === 'personal_chat' || t === 'private_chat' || t === 'saved_messages') return true;
    return /^(public|private)_(group|supergroup|channel)$/i.test(t) ? false : (t === '');
  }

  function sameUser(a, b) {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a).trim() === String(b).trim();
  }

  /** Кто это в личном чате: 'assistant' (она) или 'user' (он). */
  function roleFromTelegram(raw, ctx) {
    if (!raw || typeof raw !== 'object') return '';
    var from = raw.from;
    var fid = raw.from_id !== undefined ? raw.from_id : raw.fromId;

    if (ctx && ctx.herName && (sameUser(from, ctx.herName) || sameUser(fid, ctx.herName))) return 'assistant';
    if (ctx && ctx.myName && (sameUser(from, ctx.myName) || sameUser(fid, ctx.myName))) return 'user';

    var keys = (ctx && ctx.peerKeys) || [];
    for (var i = 0; i < keys.length; i++) {
      if (sameUser(fid, keys[i]) || sameUser(from, keys[i])) return 'assistant';
    }
    if (ctx && ctx.assumeOthersAreUser) return 'user';
    return '';
  }

  /** Список участников экспорта — для CLI и подсказок в интерфейсе. */
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
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'service') continue;
      var name = m.from !== undefined && m.from !== null ? String(m.from) : '';
      var id = m.from_id !== undefined ? m.from_id : m.fromId;
      var key = (id !== undefined && id !== null ? String(id) : name);
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
    var out = order.map(function (k) { return byKey[k]; });
    out.sort(function (a, b) { return b.count - a.count; });
    return out;
  }

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  var ROLE_KEYS = ['role', 'from', 'sender', 'author', 'senderName', 'sender_name', 'name', 'user', 'who', 'speaker', 'userType'];
  var CONTENT_KEYS = ['content', 'text', 'message', 'body', 'value', 'msg', 'content_text'];
  var TS_KEYS = ['timestamp', 'ts', 'date', 'time', 'created_at', 'createdAt', 'datetime', 'sentAt', 'sent_at', 'date_unixtime'];

  /**
   * normalizeMessage(raw, ctx) -> {role, content, ts, iso, day, src} | null
   * ctx = {source, format, report(kind, detail)}
   */
  function normalizeMessage(raw, ctx) {
    ctx = typeof ctx === 'string' ? { format: ctx } : (ctx || {});
    var report = typeof ctx.report === 'function' ? ctx.report : function () { };
    var source = ctx.source || 'archive';
    var format = ctx.format || '';

    if (raw === null || raw === undefined) { report('empty', ''); return null; }
    if (typeof raw === 'string') raw = { content: raw };
    if (Array.isArray(raw)) raw = { role: raw[0], timestamp: raw[1], content: raw[2], id: raw[3] };
    if (typeof raw !== 'object') { report('empty', ''); return null; }

    // Сервисные записи Telegram (type: 'service') — не сообщения
    var t = raw.type;
    if (t !== undefined && t !== null) {
      var tl = String(t).toLowerCase();
      if (tl === 'service' || tl === 'system') { report('service', String(t)); return null; }
      if (format === 'telegram' && tl !== 'message') { report('service', String(t)); return null; }
    }

    var role = (typeof ctx.roleFor === 'function') ? (ctx.roleFor(raw, ctx) || '') : '';
    if (!role) role = normalizeRole(pick(raw, ROLE_KEYS));
    if (!role) {
      var rawRole = pick(raw, ROLE_KEYS);
      if (rawRole === undefined || rawRole === null || String(rawRole).trim() === '') {
        if (ctx.defaultRole) role = ctx.defaultRole;
        else { report('no-role', ''); return null; }
      } else {
        report('bad-role', String(rawRole));
        return null;
      }
    }

    var content = textFromValue(pick(raw, CONTENT_KEYS));

    // Qwen: пустой content, но есть content_list с phase:'answer'
    if (!content && Array.isArray(raw.content_list) && raw.content_list.length) {
      var answers = [];
      for (var i = 0; i < raw.content_list.length; i++) {
        var item = raw.content_list[i];
        if (!item) continue;
        if (item.phase === 'answer' || item.phase === undefined) {
          answers.push(textFromValue(item.content !== undefined ? item.content : item.text, { separator: '\n\n' }));
        }
      }
      content = answers.filter(function (x) { return !!x; }).join('\n\n');
    }

    content = cleanContent(content);
    if (!content) {
      content = placeholderFrom(raw, ctx);
      if (!content) { report('empty', ''); return null; }
    }

    var ts = parseTimestamp(pick(raw, TS_KEYS));
    var extId = pick(raw, ['extId', 'id', 'message_id', 'msg_id']);
    return {
      role: role,
      content: content,
      ts: ts,
      iso: isoFromTs(ts),
      day: dayFromTs(ts),
      src: String(source),
      extId: extId === undefined || extId === null ? '' : String(extId)
    };
  }

  /* ------------------------------------------------------- определение формата */

  function looksLikeTelegram(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    if (m.from_id !== undefined || m.fromId !== undefined) return true;
    if (m.type === 'message' && (m.text !== undefined || m.date !== undefined)) return true;
    if (m.role === undefined && m.from !== undefined && (m.text !== undefined || m.date !== undefined)) return true;
    if (m.role === undefined && m.sender_name !== undefined) return true;
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

  /** detectFormat(json) -> 'qwen'|'telegram'|'messages'|'array'|'export'|'unknown' */
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
      var hasFrom = msgs.some(function (x) { return x && typeof x === 'object' && (x.from !== undefined || x.from_id !== undefined); });
      if (hasFrom) return 'telegram';
      if (typeof json.v === 'number') return 'export';
      return 'messages';
    }
    if (msgs && typeof msgs === 'object') return 'messages'; // словарь id -> сообщение

    if (json.chat && json.chat.messages) return 'qwen';
    return 'unknown';
  }

  /* -------------------------------------------------------------- нормализация */

  /**
   * normalizeArchive(json, opts) -> {format, messages, total, skipped, warnings}
   * opts = {source, format, defaultRole}
   */
  function normalizeArchive(json, opts) {
    opts = opts || {};
    var warnings = [];
    var messages = [];
    var total = 0;
    var skipped = 0;
    var serviceSkipped = 0;
    var src = opts.source || opts.fileName || 'archive';

    function warn(text) {
      if (!text) return;
      if (warnings.length >= MAX_WARNINGS) return;
      if (warnings.indexOf(text) !== -1) return;
      warnings.push(text);
    }

    function report(kind, detail) {
      if (kind === 'bad-role') warn('Неизвестная роль «' + detail + '» — сообщение пропущено');
      else if (kind === 'no-role') warn('У сообщения нет роли — пропущено');
      else if (kind === 'service') serviceSkipped++;
      else if (kind === 'empty') warn('Пустое сообщение — пропущено');
    }

    var data = json;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { warn('Строка не является JSON: ' + e.message); data = null; }
    }

    var format = opts.format || detectFormat(data);
    var empty = { format: 'unknown', messages: [], total: 0, skipped: 0, warnings: warnings };

    /* Telegram: кто «она». По умолчанию — собеседник чата (его id = id чата).
       Если определить не удалось, а участников ровно двое, подсказываем
       интерфейсу, что нужно спросить пользователя. */
    var peerKeys = telegramPeerKeys(data);
    var participants = detectParticipants(data);
    var assumeOthersAreUser = false;
    var peerResolved = false;
    var personal = isPersonalChat(data);
    if (format === 'telegram' && personal && participants.length) {
      for (var pi = 0; pi < participants.length; pi++) {
        if (participants[pi].isPeer) { peerResolved = true; break; }
      }
      if (!peerResolved && opts.herName) {
        for (var pj = 0; pj < participants.length; pj++) {
          if (sameUser(participants[pj].name, opts.herName) || sameUser(participants[pj].id, opts.herName)) {
            peerResolved = true;
            break;
          }
        }
      }
      if (peerResolved) assumeOthersAreUser = true;
    }
    /* Неоднозначность считаем по факту: если роли так и не определились и
       ни одно сообщение не принято — нужно спросить пользователя, кто «она».
       (Если хотя бы часть распозналась по известным именам — не пристаём.) */
    var ambiguous = false;

    if (data === null || data === undefined) {
      warn('Входной JSON пустой или не распознан');
      return empty;
    }
    if (format === 'unknown') {
      warn('Формат архива не распознан (ожидались array / messages / qwen / export)');
      return empty;
    }

    function ctxFor(fmt) {
      var ctx = {
        source: src,
        format: fmt,
        report: report,
        defaultRole: opts.defaultRole,
        keepEmpty: opts.keepEmpty,
        herName: opts.herName,
        myName: opts.myName
      };
      if (fmt === 'telegram') {
        ctx.peerKeys = peerKeys;
        ctx.assumeOthersAreUser = assumeOthersAreUser;
        ctx.roleFor = function (raw, c) {
          var r = roleFromTelegram(raw, c);
          if (r) return r;
          // Личный чат: участников двое, значит всё, что не она — он.
          return c.assumeOthersAreUser ? 'user' : '';
        };
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
        else if (chat && chat.chat && chat.chat.history && chat.chat.history.messages) list = values(chat.chat.history.messages);
        else if (chat && Array.isArray(chat.messages)) list = chat.messages;
        else if (chat && chat.history && chat.history.messages) list = values(chat.history.messages);
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

    if (!messages.length && format === 'telegram' && personal && participants.length >= 2) {
      ambiguous = true;
      warn('Не понятно, кто из участников — она: '
        + participants.map(function (p) { return p.name || p.id; }).join(', ')
        + '. Укажите, кто из них Маша, и сообщения импортируются.');
    }

    return {
      format: format,
      messages: messages,
      total: total,
      skipped: skipped,
      serviceSkipped: serviceSkipped,
      warnings: warnings,
      participants: participants,
      peerResolved: peerResolved,
      ambiguous: ambiguous
    };
  }

  function values(obj) {
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === 'object') return Object.keys(obj).map(function (k) { return obj[k]; });
    return [];
  }

  /* ------------------------------------------------------------ архив/индекс */

  function searchEngine() {
    if (root && root.MashaSearch && typeof root.MashaSearch.extractKeywords === 'function') return root.MashaSearch;
    return null;
  }

  function setSearchEngine(api) {
    if (api && typeof api.extractKeywords === 'function') root.MashaSearch = api;
    engineState.checked = false;
    return searchEngine();
  }

  // Проверяем движок термов один раз: пустой/сломанный search-engine.js не должен дать пустой индекс.
  var engineState = { checked: false, ok: false, engine: null, reason: '' };

  function termEngine() {
    if (engineState.checked) return engineState;
    engineState.checked = true;
    engineState.ok = false;
    engineState.engine = null;
    engineState.reason = '';
    var e = searchEngine();
    if (!e) {
      engineState.reason = 'js/search-engine.js не найден — используется встроенный упрощённый разбор';
      return engineState;
    }
    try {
      var probe = e.extractKeywords('экзамен по математике', 12);
      if (Array.isArray(probe) && probe.length > 0) {
        engineState.ok = true;
        engineState.engine = e;
        engineState.reason = 'js/search-engine.js';
      } else {
        engineState.reason = 'js/search-engine.js вернул пустой результат — используется встроенный упрощённый разбор';
      }
    } catch (err) {
      engineState.reason = 'js/search-engine.js упал (' + (err && err.message ? err.message : err) + ') — используется встроенный упрощённый разбор';
    }
    return engineState;
  }

  var FALLBACK_STOP = words('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между the a an and or but if then than that this these those is are was were be been being to of in on at for with from by as it its he she they we you i not no do does did have has had will would can could should my your his her their our me him them us what which who whom when where why how all any both each few more most other some such only own same so too very just about into over after before again');

  var FALLBACK_ENDINGS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ой', 'ей', 'ом', 'ем', 'ах', 'ях', 'ов', 'ев', 'ий', 'ый', 'ую', 'юю', 'ам', 'ям', 'ы', 'и', 'а', 'я', 'о', 'е', 'у', 'ю', 'ь'];

  /** Упрощённый, но детерминированный извлекатель термов (если search-engine.js нет). */
  function fallbackKeywords(text, limit) {
    limit = limit > 0 ? limit : 12;
    var raw = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]+/g, ' ');
    var parts = raw.split(/\s+/);
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < parts.length && out.length < limit; i++) {
      var w = parts[i];
      if (!w || w.length < 3) continue;
      if (!/[a-zа-я]/.test(w)) continue; // цифровой мусор
      if (FALLBACK_STOP[w]) continue;
      var stem = w;
      for (var e = 0; e < FALLBACK_ENDINGS.length; e++) {
        var end = FALLBACK_ENDINGS[e];
        if (stem.length - end.length >= 4 && stem.slice(-end.length) === end) { stem = stem.slice(0, -end.length); break; }
      }
      if (stem.length < 3 || FALLBACK_STOP[stem] || seen[stem]) continue;
      seen[stem] = true;
      out.push(stem);
    }
    return out;
  }

  function keywordsFor(text, limit) {
    var st = termEngine();
    if (st.ok && st.engine) {
      try {
        var res = st.engine.extractKeywords(text, limit);
        return Array.isArray(res) ? res : [];
      } catch (e) { /* падаем в fallback */ }
    }
    return fallbackKeywords(text, limit);
  }

  function rowContent(row) {
    if (row === null || row === undefined) return '';
    if (Array.isArray(row)) return typeof row[2] === 'string' ? row[2] : '';
    return typeof row.content === 'string' ? row.content : '';
  }

  function rowTs(row) {
    if (Array.isArray(row)) return row[1] > 0 ? row[1] : 0;
    return row.ts > 0 ? row.ts : 0;
  }

  function rowRole(row) {
    if (Array.isArray(row)) return row[0];
    return row.role;
  }

  /** id сообщения в исходном архиве — по нему приложение дедуплицирует
      повторный импорт, не теряя одинаковые реплики в одну секунду. */
  function rowExtId(row) {
    if (row === null || row === undefined) return '';
    if (Array.isArray(row)) return row[3] === undefined || row[3] === null ? '' : String(row[3]);
    var v = row.extId !== undefined ? row.extId : row.id;
    return v === undefined || v === null ? '' : String(v);
  }

  /**
   * buildArchive(messages, opts) -> {v, builtAt, count, sources, messages:[[role,ts,content,(extId)],...]}
   * Сортирует по ts (бездатные — в конец), присваивает seq (= index+1).
   */
  function buildArchive(messages, opts) {
    opts = opts || {};
    var list = (messages || []).filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length;
    });
    list = list.slice().sort(function (a, b) {
      var ta = a.ts > 0 ? a.ts : Number.MAX_SAFE_INTEGER;
      var tb = b.ts > 0 ? b.ts : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });
    var rows = list.map(function (m) {
      var row = [m.role, m.ts > 0 ? m.ts : 0, m.content];
      var ext = m.extId !== undefined && m.extId !== null ? String(m.extId) : (m.id !== undefined && m.id !== null ? String(m.id) : '');
      if (ext) row.push(ext);
      return row;
    });
    var sources = opts.sources;
    if (!sources) {
      var set = [];
      list.forEach(function (m) { if (m.src && set.indexOf(m.src) === -1) set.push(m.src); });
      sources = set;
    }
    return {
      v: 1,
      builtAt: opts.builtAt || Date.now(),
      count: rows.length,
      sources: sources,
      messages: rows
    };
  }

  /**
   * buildIndex(rows, opts) -> {v, maxPostings, terms:{term:[seq,...]}}
   * rows — строки архива [role,ts,content] или объекты {content}.
   * Постинг-лист обрезается maxPostings самыми свежими seq.
   */
  function buildIndex(rows, opts) {
    opts = opts || {};
    var maxPostings = opts.maxPostings > 0 ? opts.maxPostings : MAX_POSTINGS_DEFAULT;
    var limit = opts.keywordsLimit > 0 ? opts.keywordsLimit : 12;
    var list = rows || [];
    var terms = new Map();
    for (var i = 0; i < list.length; i++) {
      var content = rowContent(list[i]);
      if (!content) continue;
      var seq = i + 1;
      var keys = keywordsFor(content, limit);
      for (var k = 0; k < keys.length; k++) {
        var term = keys[k];
        var arr = terms.get(term);
        if (!arr) { arr = []; terms.set(term, arr); }
        arr.push(seq);
      }
    }
    var out = {};
    terms.forEach(function (arr, term) {
      out[term] = arr.length > maxPostings ? arr.slice(arr.length - maxPostings) : arr;
    });
    return { v: 1, maxPostings: maxPostings, terms: out };
  }

  /* --------------------------------------------------------------- чтение файлов */

  function isGzipName(name) {
    return /\.(json\.)?gz$/i.test(String(name || '')) || /\.bin$/i.test(String(name || ''));
  }

  function toBytes(arrayBuffer) {
    if (arrayBuffer instanceof Uint8Array) return arrayBuffer;
    if (arrayBuffer instanceof ArrayBuffer) return new Uint8Array(arrayBuffer);
    if (arrayBuffer && arrayBuffer.buffer) return new Uint8Array(arrayBuffer.buffer, arrayBuffer.byteOffset, arrayBuffer.byteLength);
    return new Uint8Array(arrayBuffer || 0);
  }

  async function streamToText(stream) {
    var reader = stream.getReader();
    var decoder = new TextDecoder('utf-8');
    var text = '';
    for (; ;) {
      var step = await reader.read();
      if (step.done) break;
      text += decoder.decode(step.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  }

  /** Распаковка gzip через DecompressionStream (fallback — понятная ошибка). */
  async function gunzipText(arrayBuffer) {
    var DS = root && root.DecompressionStream;
    if (typeof DS !== 'function') {
      throw new Error('Браузер не поддерживает DecompressionStream — распакуйте .gz/.bin в .json и загрузите заново');
    }
    var bytes = toBytes(arrayBuffer);
    if (!bytes.length) throw new Error('Пустой gzip-файл');
    if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      // Не gzip: возможно, обычный JSON с «неправильным» расширением
      var plain = new TextDecoder('utf-8').decode(bytes);
      if (plain.trim().charAt(0) === '{' || plain.trim().charAt(0) === '[') return plain;
      throw new Error('Файл не похож на gzip (нет сигнатуры 1f 8b)');
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DS('gzip'));
    if (typeof root.Response === 'function') return await new Response(stream).text();
    return await streamToText(stream);
  }

  async function readArrayBuffer(file) {
    if (!file) throw new Error('Пустой файл');
    if (typeof file.arrayBuffer === 'function') return await file.arrayBuffer();
    if (file instanceof ArrayBuffer) return file;
    if (file instanceof Uint8Array) return file;
    throw new Error('У файла нет метода arrayBuffer() — не могу прочитать содержимое');
  }

  /** readFileText(file) -> строка (gzip распаковывается автоматически). */
  async function readFileText(file) {
    if (typeof file === 'string') return file;
    if (!file) throw new Error('Пустой файл');
    var name = file.name || '';
    if (isGzipName(name)) return await gunzipText(await readArrayBuffer(file));
    if (typeof file.text === 'function') return await file.text();
    if (typeof file.arrayBuffer === 'function') return new TextDecoder('utf-8').decode(toBytes(await file.arrayBuffer()));
    throw new Error('Не умею читать файл: нет ни text(), ни arrayBuffer()');
  }

  /* ------------------------------------------------------------------ импорт */

  function toFileArray(files) {
    if (!files) return [];
    if (Array.isArray(files)) return files.slice();
    if (typeof files.length === 'number') {
      var out = [];
      for (var i = 0; i < files.length; i++) out.push(files[i]);
      return out;
    }
    return [files];
  }

  function emptyStats() {
    return {
      files: 0, inserted: 0, duplicates: 0, skipped: 0, terms: 0,
      durationMs: 0, total: 0, format: null, formats: {}, warnings: [], errors: []
    };
  }

  /**
   * importFiles(files, opts) -> Stats
   * opts = {memory, onProgress, source='archive', buildIndex=true, batchSize}
   * Файлы читаются по одному через file.text() (без fetch) и сразу уходят в memory.importMessages.
   * onProgress(filesDone, filesTotal, detail) — detail = {phase, file, messagesDone, messagesTotal}
   */
  async function importFiles(files, opts) {
    opts = opts || {};
    var memory = opts.memory;
    if (!memory || typeof memory.importMessages !== 'function') {
      throw new Error('Не передана база памяти: нужен memory.importMessages(messages, opts)');
    }
    var list = toFileArray(files);
    var source = opts.source || 'archive';
    var buildIndexFlag = opts.buildIndex !== false;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var chooseHer = typeof opts.chooseHer === 'function' ? opts.chooseHer : null;
    var herName = opts.herName || '';
    var stats = emptyStats();
    var started = Date.now();
    var filesTotal = list.length;

    function emit(done, detail) {
      if (!onProgress) return;
      try { onProgress(done, filesTotal, detail || {}); } catch (e) { /* колбэк пользователя не должен ломать импорт */ }
    }

    emit(0, { phase: 'start', filesTotal: filesTotal });

    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      var name = (file && file.name) ? file.name : ('файл-' + (i + 1));
      emit(i, { phase: 'read', file: name, index: i });
      try {
        var text = await readFileText(file);
        if (!text || !text.trim()) throw new Error('файл пустой');

        var parsed;
        try {
          parsed = JSON.parse(text);
        } catch (parseErr) {
          // Возможно, это gzip с расширением .json — сигнатура 0x1f
          if (text.charCodeAt(0) === 0x1f) {
            parsed = JSON.parse(await gunzipText(await readArrayBuffer(file)));
          } else {
            throw new Error('не удалось разобрать JSON (' + parseErr.message + ')');
          }
        }

        var result = normalizeArchive(parsed, { source: source, fileName: name, herName: herName });
        // Если по архиву не понять, кто «она» (нестандартный экспорт) —
        // спрашиваем у пользователя и повторяем разбор с его ответом.
        if (result.ambiguous && chooseHer) {
          var chosen = await chooseHer(result.participants || [], name);
          if (chosen) {
            herName = chosen;
            result = normalizeArchive(parsed, { source: source, fileName: name, herName: chosen });
          }
        }
        stats.total += result.total;
        stats.skipped += result.skipped;
        stats.formats[result.format] = (stats.formats[result.format] || 0) + 1;
        if (!stats.format || stats.format === 'unknown') stats.format = result.format;
        for (var w = 0; w < result.warnings.length && stats.warnings.length < 40; w++) {
          if (stats.warnings.indexOf(result.warnings[w]) === -1) stats.warnings.push(result.warnings[w]);
        }
        if (result.format === 'unknown') throw new Error('формат архива не распознан');
        if (!result.messages.length) throw new Error('в файле не найдено ни одного сообщения');

        var fileStats = await memory.importMessages(result.messages, {
          source: source,
          buildIndex: buildIndexFlag,
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
        emit(i + 1, { phase: 'file-done', file: name, index: i, fileStats: fileStats });
      } catch (err) {
        stats.errors.push(name + ': ' + (err && err.message ? err.message : String(err)));
        emit(i + 1, { phase: 'file-error', file: name, index: i, error: stats.errors[stats.errors.length - 1] });
      }
    }

    stats.durationMs = Date.now() - started;
    emit(filesTotal, { phase: 'done', stats: stats });
    return stats;
  }

  /** importGzipBuffer(arrayBuffer, opts) -> Stats (.json.gz / .bin). */
  async function importGzipBuffer(arrayBuffer, opts) {
    opts = opts || {};
    var memory = opts.memory;
    if (!memory || typeof memory.importMessages !== 'function') {
      throw new Error('Не передана база памяти: нужен memory.importMessages(messages, opts)');
    }
    var text = await gunzipText(arrayBuffer);
    var parsed = JSON.parse(text);
    var result = normalizeArchive(parsed, { source: opts.source || 'archive', herName: opts.herName || '' });
    if (!result.messages.length) {
      return { files: 0, inserted: 0, duplicates: 0, skipped: result.skipped, terms: 0, durationMs: 0, total: result.total, format: result.format, formats: {}, warnings: result.warnings, errors: ['в gzip-архиве нет сообщений'] };
    }
    var memStats = await memory.importMessages(result.messages, {
      source: opts.source || 'archive',
      buildIndex: opts.buildIndex !== false,
      onProgress: opts.onProgress
    }) || {};
    return {
      files: 1,
      inserted: memStats.inserted || 0,
      duplicates: memStats.duplicates || 0,
      skipped: result.skipped + (memStats.skipped || 0),
      terms: memStats.terms || 0,
      durationMs: memStats.durationMs || 0,
      total: result.total,
      format: result.format,
      formats: (function () { var o = {}; o[result.format] = 1; return o; })(),
      warnings: result.warnings,
      errors: []
    };
  }

  /* ------------------------------------------------------------------ бэкапы */

  /**
   * exportBackup(opts) -> Blob (JSON: настройки, факты, отношения, последние 500 сообщений, мета архива).
   * opts = {memory, settings, facts, relations, recentLimit=500}
   */
  async function exportBackup(opts) {
    opts = opts || {};
    var memory = opts.memory || null;
    var limit = opts.recentLimit > 0 ? opts.recentLimit : 500;
    var out = {
      v: 1,
      app: 'masha',
      kind: 'backup',
      exportedAt: Date.now(),
      settings: opts.settings || null,
      facts: opts.facts || [],
      relations: opts.relations || [],
      archive: null,
      messages: []
    };

    if (memory) {
      try {
        if (typeof memory.getStats === 'function') out.archive = await memory.getStats();
      } catch (e) { out.archiveError = String(e && e.message || e); }
      try {
        if (typeof memory.getRecent === 'function') {
          var recent = (await memory.getRecent(limit)) || [];
          out.messages = recent.map(function (m) {
            return [m.role, m.ts > 0 ? m.ts : 0, m.content];
          });
        }
      } catch (e) { out.messagesError = String(e && e.message || e); }
    }

    var text = JSON.stringify(out);
    if (typeof root.Blob === 'function') return new root.Blob([text], { type: 'application/json; charset=utf-8' });
    return { text: text, type: 'application/json; charset=utf-8', size: text.length };
  }

  /** importBackup(file) -> разобранный бэкап (применяет вызывающий). */
  async function importBackup(file) {
    var text = await readFileText(file);
    if (!text || !text.trim()) throw new Error('Файл бэкапа пустой');
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Не удалось разобрать бэкап: ' + e.message);
    }
    if (!data || typeof data !== 'object') throw new Error('Бэкап повреждён: ожидался объект JSON');
    if (!Array.isArray(data.messages) && !data.archive && !data.settings && !data.facts) {
      throw new Error('Это не похоже на бэкап «Маши» (нет messages/archive/settings)');
    }
    return data;
  }

  /* -------------------------------------------------------------------- api */

  return {
    version: VERSION,
    detectFormat: detectFormat,
    parseTimestamp: parseTimestamp,
    normalizeRole: normalizeRole,
    normalizeMessage: normalizeMessage,
    normalizeArchive: normalizeArchive,
    importFiles: importFiles,
    importGzipBuffer: importGzipBuffer,
    readFileText: readFileText,
    gunzipText: gunzipText,
    exportBackup: exportBackup,
    importBackup: importBackup,
    // Telegram: определение ролей и участников (он/она)
    detectParticipants: detectParticipants,
    telegramPeerKeys: telegramPeerKeys,
    roleFromTelegram: roleFromTelegram,
    isPersonalChat: isPersonalChat,
    // дополнительные утилиты (используются CLI и build-archive.html)
    buildArchive: buildArchive,
    buildIndex: buildIndex,
    setSearchEngine: setSearchEngine,
    termEngine: termEngine,
    fallbackKeywords: fallbackKeywords,
    MAX_WARNINGS: MAX_WARNINGS,
    MAX_POSTINGS: MAX_POSTINGS_DEFAULT
  };
});
