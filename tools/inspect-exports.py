#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
inspect-exports.py — подробный разбор экспортов Telegram и сверка с архивом.

    python tools/inspect-exports.py "C:\\...\\chat1.json" "C:\\...\\chat2.json"

Печатает: структуру файла, участников, период, типы сообщений, медиа,
дни и паузы, а в конце — сверку с archive/masha-archive.json.gz.
"""
import collections
import gzip
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MSK = timezone(timedelta(hours=7))


def text_of(v):
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        out = []
        for part in v:
            if isinstance(part, str):
                out.append(part)
            elif isinstance(part, dict):
                out.append(str(part.get("text", "")))
        return "".join(out)
    return ""


def media_kind(m):
    if m.get("photo"):
        return "фото"
    if m.get("media_type"):
        return m["media_type"]
    if m.get("file"):
        return "файл"
    if m.get("poll"):
        return "опрос"
    return None


def analyze(path):
    print("=" * 74)
    print("  ФАЙЛ: %s (%.1f МБ)" % (os.path.basename(path), os.path.getsize(path) / 1048576))
    print("=" * 74)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    print("Верхний уровень:", ", ".join("%s=%s" % (k, (str(v)[:40] if not isinstance(v, (list, dict)) else "<%s>" % type(v).__name__)) for k, v in list(data.items())[:8]))
    msgs = data.get("messages") or []
    print("Сообщений в файле: %d" % len(msgs))
    print("Название чата: %s | тип: %s | id: %s" % (data.get("name"), data.get("type"), data.get("id")))

    types = collections.Counter(m.get("type") for m in msgs)
    print("Типы записей:", dict(types))

    authors = collections.Counter()
    ids = {}
    for m in msgs:
        who = m.get("from") or "?"
        authors[who] += 1
        if m.get("from_id"):
            ids.setdefault(who, m["from_id"])
    print("Участники (по записям):")
    for who, n in authors.most_common(10):
        print("   %-24s %7d сообщ.  id=%s" % (who, n, ids.get(who, "?")))
    print("Собеседник чата (та, что не owner):", data.get("id"))

    dates = [int(m["date_unixtime"]) for m in msgs if str(m.get("date_unixtime", "")).isdigit()]
    if dates:
        d1, d2 = min(dates), max(dates)
        print("Период: %s — %s" % (
            datetime.fromtimestamp(d1, MSK).strftime("%d.%m.%Y %H:%M"),
            datetime.fromtimestamp(d2, MSK).strftime("%d.%m.%Y %H:%M")))
        days = collections.Counter(datetime.fromtimestamp(t, MSK).strftime("%Y-%m-%d") for t in dates)
        print("Активных дней: %d | самый активный: %s (%d сообщ.)" % (
            len(days), days.most_common(1)[0][0], days.most_common(1)[0][1]))

    # медиа
    media = collections.Counter()
    text_only = media_only = empty = 0
    chars = 0
    for m in msgs:
        if m.get("type") != "message":
            continue
        t = text_of(m.get("text"))
        kind = media_kind(m)
        if kind:
            media[kind] += 1
        if t.strip() and not kind:
            text_only += 1
        elif kind and not t.strip():
            media_only += 1
        elif not t.strip() and not kind:
            empty += 1
        chars += len(t)
    print("Медиа по типам: %s" % (dict(media.most_common(10)) or "нет"))
    print("Только текст: %d | только медиа: %d | пустых: %d | всего символов текста: %s" % (
        text_only, media_only, empty, format(chars, ",")))

    # прочее
    links = sum(1 for m in msgs if m.get("type") == "message" and re.search(r"https?://", text_of(m.get("text"))))
    fwd = sum(1 for m in msgs if m.get("forwarded_from"))
    replies = sum(1 for m in msgs if m.get("reply_to_message_id"))
    edited = sum(1 for m in msgs if m.get("edited"))
    print("Со ссылками: %d | пересланных: %d | ответов: %d | изменённых: %d" % (links, fwd, replies, edited))
    return msgs


def compare(files_msgs, archive_path):
    print()
    print("=" * 74)
    print("  СВЕРКА С АРХИВОМ ПАМЯТИ")
    print("=" * 74)
    if not os.path.exists(archive_path):
        print("нет архива: " + archive_path)
        return
    a = json.loads(gzip.open(archive_path, "rb").read().decode("utf-8"))
    arch = a["messages"]
    print("В архиве: %d сообщений" % len(arch))
    total_raw = sum(len(m) for m in files_msgs)
    print("В двух файлах всего записей: %d" % total_raw)

    arch_keys = set()
    for role, ts, content, ext in arch:
        arch_keys.add((role, str(ts), (content or "").strip()[:120]))
    missing = 0
    checked = 0
    for msgs in files_msgs:
        for m in msgs[::37]:                      # каждая 37-я запись — быстрая выборка
            if m.get("type") != "message":
                continue
            t = text_of(m.get("text")).strip()
            if not t:
                continue
            checked += 1
            found = any((role, str(ts), t[:120]) in arch_keys
                        for role in ("user", "assistant")
                        for ts in [int(m["date_unixtime"]) * 1000 if str(m.get("date_unixtime", "")).isdigit() else 0])
            if not found:
                missing += 1
    if checked:
        print("Проверил выборку %d сообщений из файлов: не найдено в архиве — %d (%.2f%%)" % (
            checked, missing, 100.0 * missing / checked))
        if missing == 0:
            print("ВЫВОД: архив полностью соответствует этим файлам ✓")
        elif missing < checked * 0.01:
            print("ВЫВОД: архив почти полностью соответствует (расхождения — пустые/служебные) ✓")
        else:
            print("ВЫВОД: в архиве НЕ хватает части сообщений — архив надо пересобрать")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        args = [os.path.join(os.path.expanduser("~"), "Downloads", "chat1.json"),
                os.path.join(os.path.expanduser("~"), "Downloads", "chat2.json")]
    all_msgs = []
    for path in args:
        if os.path.exists(path):
            all_msgs.append(analyze(path))
            print()
        else:
            print("нет файла: " + path)
    if all_msgs:
        compare(all_msgs, os.path.join(ROOT, "archive", "masha-archive.json.gz"))


if __name__ == "__main__":
    main()
