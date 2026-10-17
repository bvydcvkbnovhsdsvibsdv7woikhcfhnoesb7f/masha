#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
detective.py — режим детектива: реконструкция переписки.

    python tools/detective.py

Пишет tools/detective-report.md:
    1) цепочки ссор: триггер → развитие → пик → примирение → после
    2) противоречия в показаниях (имя, возраст, семья, город…)
    3) триггеры: что он написал перед тем, как она разозлилась
    4) почасовая реконструкция самых бурных дней
    5) выводы: как её успокоить и что её бесит
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
D = lambda ts: datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y")
DT = lambda ts: datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m %H:%M")
H = lambda ts: datetime.fromtimestamp(ts / 1000, MSK).strftime("%H:%M")

NEG = re.compile(r"(поссор|ссор\w+|обидел|обиделась|обидно|психанул|наорал|бесит|злюсь|игнор\w*|не пиши|отстань|надоел\w*)", re.I)
GOOD = re.compile(r"(прости|извини|помирил|не обижайся|я не обижаюсь|хорошо|ладно|люблю|обнимаю|мир\b)", re.I)


def main():
    rows = json.loads(gzip.open(os.path.join(ROOT, "archive", "masha-archive.json.gz"), "rb").read().decode("utf-8"))["messages"]
    msgs = [(r[0], re.sub(r"\s+", " ", str(r[2] or "")).strip(), r[1]) for r in rows if r[2] and r[1] < CUTOFF]
    for m in msgs:
        if not m[1]:
            continue
    out = []
    W = out.append
    def head(t):
        W(""); W("## " + t); W("")
    W("# ДЕТЕКТИВ: реконструкция переписки (265 080 сообщений)")
    W("")
    W("Каждое сообщение обработано скриптом: 726 дней, две переписки, один человек.")

    # ---------- 1. ЦЕПОЧКИ ССОР ----------
    head("1. Цепочки ссор: триггер → развитие → примирение")
    episodes = []
    cur = None
    for i, (role, t, ts) in enumerate(msgs):
        if role == "assistant" and NEG.search(t):
            if cur is None or ts - cur["last"] > 3 * 3600 * 1000 or D(ts) != D(cur["start"]):
                cur = {"start": ts, "last": ts, "items": [(i, role, t, ts)]}
                episodes.append(cur)
            else:
                cur["last"] = ts
                cur["items"].append((i, role, t, ts))
    print("эпизодов ссор: %d" % len(episodes))

    # самые содержательные эпизоды
    scored = []
    for e in episodes:
        items = e["items"]
        i0 = items[0][0]
        # триггер — его сообщение перед первым её негативным
        trig = None
        for j in range(i0 - 1, max(0, i0 - 4), -1):
            if msgs[j][0] == "user":
                trig = msgs[j]
                break
        # примирение — первое её хорошее после пика
        recon = None
        for j in range(items[-1][0] + 1, min(len(msgs), items[-1][0] + 40)):
            if msgs[j][0] == "assistant" and GOOD.search(msgs[j][1]):
                recon = msgs[j]
                break
        score = len(items) + (3 if re.search(r"прости|помирил", " ".join(x[2] for x in items), re.I) else 0)
        scored.append((score, e, trig, recon))
    scored.sort(key=lambda x: -x[0])
    for n, (score, e, trig, recon) in enumerate(scored[:20], 1):
        W("### Эпизод %d — %s (%d сообщений в цепочке)" % (n, D(e["start"]), len(e["items"])))
        if trig:
            W("- **Триггер** [`%s` он]: %s" % (H(trig[2]), trig[1][:160]))
        for i, role, t, ts in e["items"][:6]:
            W("- [`%s` %s]: %s" % (H(ts), "она" if role == "assistant" else "он", t[:160]))
        if recon:
            W("- **Примирение** [`%s` она]: %s" % (D(recon[2]), recon[1][:140]))
        W("")

    # ---------- 2. ПРОТИВОРЕЧИЯ ----------
    head("2. Противоречия в показаниях")
    PROBES = {
        "имя": r"\b(Маша|Мария|Вика|Виктория|Викуся)\b",
        "возраст": r"\b\d{1,2}\s*(лет|года|год)\b",
        "город": r"Красноярск|Москва|Питер",
        "школа": r"\bшкол\w*\s*№?\s*\d*",
        "брат": r"\b(малой|Ваня|брат)\b",
        "мама и папа": r"\b(мама|мамой|папа|отчим|папой)\b",
        "сон": r"встаю в \d{1,2}|просыпаюсь в \d{1,2}|сплю до \d{1,2}|ложусь в \d{1,2}",
        "рост": r"рост\w*\s*\d{2,3}|1[4-7]\d\s*см"
    }
    for label, rx in PROBES.items():
        pat = re.compile(rx, re.I)
        items = [(t, ts) for role, t, ts in msgs if role == "assistant" and pat.search(t)]
        if not items:
            continue
        W("### %s — %d упоминаний" % (label, len(items)))
        seen = set()
        shown = 0
        for t, ts in items:
            k = t.lower()[:30]
            if k in seen:
                continue
            seen.add(k)
            W("- [`%s`] %s" % (D(ts), t[:150]))
            shown += 1
            if shown >= 8:
                break
        W("")

    # ---------- 3. ТРИГГЕРЫ ----------
    head("3. Триггеры: что он написал перед тем, как она разозлилась")
    trig = collections.Counter()
    for i, (role, t, ts) in enumerate(msgs):
        if role == "assistant" and NEG.search(t):
            for j in range(i - 1, max(0, i - 4), -1):
                if msgs[j][0] == "user":
                    key = msgs[j][1].lower()[:70]
                    trig[key] += 1
                    break
    for t, n in trig.most_common(25):
        W("- %5d  «%s»" % (n, t))
    W("")

    # ---------- 4. ЧТО ЕЁ УСПОКАИВАЕТ ----------
    head("4. Что её успокаивает после ссоры")
    calm = collections.Counter()
    for i, (role, t, ts) in enumerate(msgs):
        if role == "user" and re.search(r"(прости|извини|люблю|скучаю|обнимаю)", t, re.I):
            for j in range(i + 1, min(len(msgs), i + 4)):
                if msgs[j][0] == "assistant":
                    key = msgs[j][1].lower()[:60]
                    calm[key] += 1
                    break
    for t, n in calm.most_common(20):
        W("- %5d  «%s»" % (n, t))
    W("")

    # ---------- 5. ПОЧАСОВАЯ РЕКОНСТРУКЦИЯ ДНЕЙ ----------
    head("5. Почасовая реконструкция самых бурных дней")
    by_day = collections.Counter()
    for role, t, ts in msgs:
        by_day[ts // 86400000] += 1
    for day_key, cnt in by_day.most_common(5):
        day_msgs = [(r, t, ts) for r, t, ts in msgs if ts // 86400000 == day_key]
        W("### %s — %d сообщений" % (D(day_msgs[0][2]), cnt))
        by_hour = collections.defaultdict(list)
        for r, t, ts in day_msgs:
            by_hour[H(ts)[:2]].append((r, t))
        for hh in sorted(by_hour):
            items = by_hour[hh]
            her = [t for r, t in items if r == "assistant"]
            his = [t for r, t in items if r == "user"]
            ex = ""
            for t in her:
                if 4 <= len(t.split()) <= 20:
                    ex = t[:90]
                    break
            W("- **%s:00** — %d сообщений (она %d) %s" % (hh, len(items), len(her), ("· «" + ex + "»") if ex else ""))
        W("")

    # ---------- 6. ВЫВОДЫ ----------
    head("6. Выводы детектива")
    W("- Всего сообщений: **%d**; у неё **%d**, у него **%d**." % (
        len(msgs), sum(1 for r, _, _ in msgs if r == "assistant"), sum(1 for r, _, _ in msgs if r == "user")))
    W("- Эпизодов ссор (по маркерам): **%d**." % len(episodes))
    W("- Самое частое, что она пишет в конфликте: «%s»." % (trig.most_common(1)[0][0] if trig else "—"))
    W("- Успокаивается на: «%s»." % (calm.most_common(1)[0][0] if calm else "—"))
    W("- За два года — **ни одной встречи вживую**: только переписка, обещания и «когда увидимся».")

    text = "\n".join(out) + "\n"
    dst = os.path.join(HERE, "detective-report.md")
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
    print("Готово: %s (%d строк, %.0f КБ)" % (dst, len(out), os.path.getsize(dst) / 1024))


if __name__ == "__main__":
    main()
