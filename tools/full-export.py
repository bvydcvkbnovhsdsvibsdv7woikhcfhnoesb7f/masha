#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
full-export.py — выгрузить АБСОЛЮТНО всё: каждое сообщение текстом + статистика.

    python tools/full-export.py

Пишет:
    tools/полная-переписка.txt  — каждое сообщение: [дата время] автор: текст
    tools/её-сообщения.txt      — только её сообщения, по порядку (её «дневник»)
    tools/статистика.txt        — медиа по месяцам, ответы, изменённые, длины и т.п.
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
CUTOFF = 1786554000000


def load_raw():
    """Читает оба исходных экспорта, если они есть, иначе — готовый архив."""
    src = [os.path.join(os.path.expanduser("~"), "Downloads", "chat1.json"),
           os.path.join(os.path.expanduser("~"), "Downloads", "chat2.json")]
    if all(os.path.exists(p) for p in src):
        msgs = []
        for p in src:
            d = json.load(open(p, encoding="utf-8"))
            for m in d.get("messages", []):
                if str(m.get("date_unixtime", "")).isdigit():
                    msgs.append(m)
        msgs.sort(key=lambda m: int(m["date_unixtime"]))
        return msgs, "исходные экспорты chat1.json + chat2.json"
    rows = json.loads(gzip.open(os.path.join(ROOT, "archive", "masha-archive.json.gz"), "rb").read().decode("utf-8"))["messages"]
    return rows, "собранный архив masha-archive.json.gz"


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
    return ""


def main():
    msgs, source = load_raw()
    print("Источник: %s — %d записей" % (source, len(msgs)))

    # определяем, кто «она»: собеседник чата (не owner)
    peer = None
    stats = collections.Counter()
    media_month = collections.defaultdict(collections.Counter)
    peer_ids = collections.Counter()

    # в экспортах Telegram у сообщений есть from_id; owner неизвестен, поэтому
    # берём участника, которого нет в первых двух ролях, по самому частому id.
    for m in msgs:
        fid = m.get("from_id")
        if fid:
            peer_ids[fid] += 1
    if peer_ids:
        # самый частый id — это «она» (у неё id 6457495066 в обоих файлах)
        for fid, _ in peer_ids.most_common():
            if str(fid) == "user6457495066":
                peer = fid
                break
        if peer is None:
            peer = peer_ids.most_common(1)[0][0]

    full = open(os.path.join(HERE, "полная-переписка.txt"), "w", encoding="utf-8")
    herf = open(os.path.join(HERE, "её-сообщения.txt"), "w", encoding="utf-8")
    full.write("ПОЛНАЯ ПЕРЕПИСКА — каждое сообщение. Автор: «она» / «он». Источник: %s\n" % source)
    full.write("Расставание обозначено отдельной чертой; в память Маши оно не попадает.\n\n")
    herf.write("ВСЕ ЕЁ СООБЩЕНИЯ ПО ПОРЯДКУ — «дневник»\n\n")

    prev_break = False
    n = 0
    for m in msgs:
        typ = m.get("type")
        if typ == "service":
            stats["служебные"] += 1
            continue
        ts = int(m["date_unixtime"]) if str(m.get("date_unixtime", "")).isdigit() else 0
        if not ts:
            stats["без даты"] += 1
            continue
        dt = datetime.fromtimestamp(ts, MSK)
        who = "она" if m.get("from_id") == peer else "он"
        txt = text_of(m.get("text")).strip()
        kind = media_kind(m)
        body = txt
        if kind:
            stats["медиа: " + kind] += 1
            media_month[dt.strftime("%Y-%m")][kind] += 1
            if not body:
                body = "[%s]" % kind
        if not body:
            stats["пустые"] += 1
            continue
        if m.get("reply_to_message_id"):
            stats["ответы на сообщение"] += 1
        if m.get("edited"):
            stats["изменённые"] += 1
        if m.get("forwarded_from"):
            stats["пересланные"] += 1
        stats["всего"] += 1
        if who == "она":
            stats["её"] += 1
        else:
            stats["его"] += 1

        if ts * 1000 >= CUTOFF and not prev_break:
            full.write("\n" + "=" * 70 + "\nРАССТАВАНИЕ (13–18.08.2026) — в память Маши не входит\n" + "=" * 70 + "\n\n")
            prev_break = True
        line = "[%s] %s: %s\n" % (dt.strftime("%d.%m.%Y %H:%M"), who, body.replace("\n", " / "))
        full.write(line)
        if who == "она":
            herf.write(line)
        n += 1

    full.close()
    herf.close()
    print("полная-переписка.txt: %.1f МБ" % (os.path.getsize(os.path.join(HERE, "полная-переписка.txt")) / 1048576))
    print("её-сообщения.txt: %.1f МБ" % (os.path.getsize(os.path.join(HERE, "её-сообщения.txt")) / 1048576))

    # ---------- статистика ----------
    st = []
    S = st.append
    S("СТАТИСТИКА ПО ПЕРЕПИСКЕ")
    S("=" * 60)
    S("источник: %s" % source)
    S("")
    for k in ["всего", "её", "его", "служебные", "пустые", "ответы на сообщение", "изменённые", "пересланные"]:
        if stats[k]:
            S("%-22s %d" % (k, stats[k]))
    S("")
    S("МЕДИА ПО ТИПАМ")
    for k, v in sorted(stats.items()):
        if k.startswith("медиа:"):
            S("   %-20s %d" % (k.replace("медиа: ", ""), v))
    S("")
    S("МЕДИА ПО МЕСЯЦАМ (фото / стикеры / голосовые / видео / прочее)")
    for ym in sorted(media_month):
        c = media_month[ym]
        total = sum(c.values())
        S("   %s  всего %5d | фото %4d | стикеры %4d | голос %3d | видео %3d | прочее %3d" % (
            ym, total, c.get("фото", 0), c.get("sticker", 0),
            c.get("voice_message", 0), c.get("video_file", 0) + c.get("video_message", 0) + c.get("animation", 0),
            total - c.get("фото", 0) - c.get("sticker", 0) - c.get("voice_message", 0) - c.get("video_file", 0) - c.get("video_message", 0) - c.get("animation", 0)))
    text = "\n".join(st) + "\n"
    with open(os.path.join(HERE, "статистика.txt"), "w", encoding="utf-8") as f:
        f.write(text)
    print("статистика.txt: %d строк" % len(st))


if __name__ == "__main__":
    main()
