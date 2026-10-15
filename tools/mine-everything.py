#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
mine-everything.py — добрать всё, что осталось: вопросы, истории, конфликты,
ответные цепочки, его речь, редкие слова, даты, места, статистику по времени.

    python tools/mine-everything.py

Файлы в tools/:
    все-вопросы.txt              — все её вопросы (хронологически)
    истории.txt                  — все её длинные сообщения (её рассказы)
    конфликты-и-примирения.txt   — все ссоры и примирения с контекстом
    ответные-цепочки.txt         — что он написал → что она ответила
    его-речь.txt                 — анализ его сообщений
    редкие-слова.txt             — слова, которые использует только она
    даты-и-события.txt           — все даты, праздники, годовщины
    места-и-бренды.txt           — города, места, игры, сервисы, песни
    время-и-статистика.txt       — по годам, дням недели, часам, длине, эмодзи
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
SPAM = re.compile(r"^кому-то понравилась твоя анкета|вам пришло сообщение|напоминание|^🎰|подпишись|реклама|промокод|https?://|t\.me/|@[a-z0-9_]{4,}", re.I)

D = lambda ts: datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y")
DT = lambda ts: datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y %H:%M")

STOP = set("""и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только
ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был
него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней
для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того
потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем
всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего
них какая много разве три эту моя впрочем свою этой перед иногда лучше чуть том нельзя такой им
более всегда конечно всю между это оно ах ох ух эх""".split())


def main():
    rows = json.loads(gzip.open(os.path.join(ROOT, "archive", "masha-archive.json.gz"), "rb").read().decode("utf-8"))["messages"]
    msgs = []
    for r in rows:
        t = re.sub(r"\s+", " ", str(r[2] or "")).strip()
        if not t or r[1] >= CUTOFF or SPAM.search(t):
            continue
        msgs.append((r[0], t, r[1]))
    her = [(t, ts) for role, t, ts in msgs if role == "assistant"]
    his = [(t, ts) for role, t, ts in msgs if role == "user"]
    print("Сообщений: %d (её %d, его %d)" % (len(msgs), len(her), len(his)))

    def write(name, lines):
        p = os.path.join(HERE, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        print("%-30s %6.0f КБ, строк %d" % (name, os.path.getsize(p) / 1024, len(lines)))

    # ---------- 1. ВСЕ ЕЁ ВОПРОСЫ ----------
    q = ["ВСЕ ЕЁ ВОПРОСЫ — %d" % sum(1 for t, _ in her if t.endswith("?"))]
    for t, ts in her:
        if t.endswith("?"):
            q.append("[%s] %s" % (DT(ts), t))
    write("все-вопросы.txt", q)

    # ---------- 2. ИСТОРИИ (длинные сообщения) ----------
    st = ["ЕЁ ИСТОРИИ И РАССКАЗЫ — сообщения длиннее 12 слов"]
    for t, ts in her:
        if len(t.split()) > 12:
            st.append("[%s] %s" % (DT(ts), t))
    write("истории.txt", st)

    # ---------- 3. КОНФЛИКТЫ И ПРИМИРЕНИЯ ----------
    conf = ["КОНФЛИКТЫ И ПРИМИРЕНИЯ — с контекстом (±3 сообщения)"]
    PAT = re.compile(r"(поссор|ссор\w+|обидел|психанул|наорал|бесит|злюсь|игнор|прости|извини|помирил|я не обижаюсь)", re.I)
    idx_shown = set()
    for i, (role, t, ts) in enumerate(msgs):
        if role != "assistant" or not PAT.search(t):
            continue
        start = max(0, i - 3)
        if start in idx_shown:
            continue
        idx_shown.add(start)
        conf.append("")
        conf.append("── %s ──" % DT(ts))
        for j in range(start, min(len(msgs), i + 4)):
            r2, t2, ts2 = msgs[j]
            conf.append("   [%s] %s: %s" % (datetime.fromtimestamp(ts2 / 1000, MSK).strftime("%H:%M"), "она" if r2 == "assistant" else "он ", t2[:170]))
    write("конфликты-и-примирения.txt", conf)

    # ---------- 4. ОТВЕТНЫЕ ЦЕПОЧКИ ----------
    chain = ["ЧТО ОН НАПИСАЛ → ЧТО ОНА ОТВЕТИЛА (все ответы на конкретные сообщения)"]
    pairs = 0
    for i in range(len(msgs) - 1):
        role, t, ts = msgs[i]
        if role != "user":
            continue
        nxt = msgs[i + 1]
        if nxt[0] != "assistant":
            continue
        pairs += 1
        chain.append("[%s] он: %s" % (D(ts), t[:140]))
        chain.append("            она: %s" % nxt[1][:140])
    chain.insert(1, "всего пар: %d" % pairs)
    write("ответные-цепочки.txt", chain)

    # ---------- 5. ЕГО РЕЧЬ ----------
    hl = ["АНАЛИЗ ЕГО СООБЩЕНИЙ — %d" % len(his), ""]
    lens = sorted(len(t.split()) for t, _ in his)
    hl.append("медиана слов: %d, среднее: %.2f" % (lens[len(lens) // 2], sum(lens) / len(lens)))
    hl.append("с эмодзи: %d (%.0f%%)" % (sum(1 for t, _ in his if re.search(r"[❤💋🫶🥰😭🙄🩷]", t)), 100 * sum(1 for t, _ in his if re.search(r"[❤💋🫶🥰😭🙄🩷]", t)) / len(his)))
    hl.append("")
    hl.append("ЕГО самые частые сообщения:")
    for t, n in collections.Counter(x.lower() for x, _ in his if len(x.split()) <= 3).most_common(60):
        hl.append("   %5d  %s" % (n, t))
    hl.append("")
    hl.append("ЕГО частые обороты (2 слова):")
    c2 = collections.Counter()
    for t, _ in his:
        w = re.findall(r"[а-яё]{3,}", t.lower())
        for i in range(len(w) - 1):
            if w[i] not in STOP and w[i + 1] not in STOP:
                c2[w[i] + " " + w[i + 1]] += 1
    for t, n in c2.most_common(50):
        hl.append("   %5d  %s" % (n, t))
    hl.append("")
    hl.append("ЕГО слова, которых нет/почти нет у неё:")
    hw, ww = collections.Counter(), collections.Counter()
    for t, _ in his:
        for w in re.findall(r"[а-яё]{4,}", t.lower()):
            if w not in STOP:
                hw[w] += 1
    for t, _ in her:
        for w in re.findall(r"[а-яё]{4,}", t.lower()):
            if w not in STOP:
                ww[w] += 1
    for w, n in sorted([(w, n) for w, n in hw.items() if n >= 40], key=lambda x: -(x[1] / (ww.get(x[0], 0) + 3)))[:40]:
        hl.append("   %-16s он %6d | она %6d" % (w, n, ww.get(w, 0)))
    write("его-речь.txt", hl)

    # ---------- 6. РЕДКИЕ СЛОВА ----------
    rw = ["СЛОВА, КОТОРЫЕ ЕСТЬ ТОЛЬКО У НЕЁ", ""]
    wher, whis = collections.Counter(), collections.Counter()
    for t, _ in her:
        for w in re.findall(r"[а-яё]{4,}", t.lower()):
            wher[w] += 1
    for t, _ in his:
        for w in re.findall(r"[а-яё]{4,}", t.lower()):
            whis[w] += 1
    only = [(w, n) for w, n in wher.items() if n >= 5 and whis.get(w, 0) == 0]
    only.sort(key=lambda x: -x[1])
    rw.append("Всего таких слов: %d" % len(only))
    rw.append("")
    for w, n in only[:400]:
        rw.append("   %5d  %s" % (n, w))
    write("редкие-слова.txt", rw)

    # ---------- 7. ДАТЫ И СОБЫТИЯ ----------
    dt = ["ДАТЫ, ПРАЗДНИКИ, СОБЫТИЯ", ""]
    MON = r"(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)"
    hits = collections.Counter()
    for role, t, ts in msgs:
        for m in re.finditer(r"\b(\d{1,2})\s+" + MON + r"\w*", t, re.I):
            hits["%s %s" % (m.group(1), m.group(2).lower())] += 1
    dt.append("Даты (число + месяц) по частоте:")
    for k, n in hits.most_common(40):
        dt.append("   %5d  %s" % (n, k))
    dt.append("")
    for label, rx in [("день рождения", r"день рождения|днюх|с др\b|с днём рождения|др у меня|у меня др"),
                      ("новый год", r"новый год|нового года|нг\b"),
                      ("8 марта", r"8 марта|восьмое марта"),
                      ("14 февраля", r"14 февраля|валентин"),
                      ("23 февраля", r"23 февраля"),
                      ("годовщина", r"годовщин|два года вместе|2 года вместе"),
                      ("встреча вживую", r"вживую|в живую|увидимся|встретимся|приеду к тебе|приезжай")]:
        pat = re.compile(rx, re.I)
        items = [(r, t, ts) for r, t, ts in msgs if pat.search(t)]
        dt.append("")
        dt.append("### %s — %d упоминаний" % (label, len(items)))
        for r, t, ts in items[:20]:
            dt.append("   [%s %s] %s" % (D(ts), "она" if r == "assistant" else "он ", t[:150]))
    write("даты-и-события.txt", dt)

    # ---------- 8. МЕСТА И БРЕНДЫ ----------
    pl = ["МЕСТА, ГОРОДА, БРЕНДЫ, ИГРЫ, СЕРВИСЫ", ""]
    lat = collections.Counter()
    for role, t, ts in msgs:
        for w in re.findall(r"\b[A-Za-z][A-Za-z0-9'&.\-]{2,}\b", t):
            lat[w] += 1
    pl.append("Латинские слова (бренды, игры, сервисы) по частоте:")
    for w, n in lat.most_common(80):
        pl.append("   %5d  %s" % (n, w))
    pl.append("")
    cyr = collections.Counter()
    for role, t, ts in msgs:
        for w in re.findall(r"\b[А-ЯЁ][а-яё]{3,}\b", t):
            if w.lower() not in STOP:
                cyr[w] += 1
    pl.append("Русские имена собственные (с большой буквы) по частоте:")
    for w, n in cyr.most_common(80):
        pl.append("   %5d  %s" % (n, w))
    pl.append("")
    pl.append("Упоминания мест:")
    for label, rx in [("Красноярск", r"красноярск"), ("школа №", r"школ\w* №?\s*\d+"), ("колледж", r"колледж"),
                      ("деревня/дача", r"деревн|дач[аеу]"), ("речка", r"речк"), ("больница", r"больниц|поликлиник"),
                      ("магазин", r"магазин|пятёрочк|пятерочк|магнит|лент[ае]"), ("кино", r"кино|фильм в кино")]:
        pat = re.compile(rx, re.I)
        items = [(r, t, ts) for r, t, ts in msgs if pat.search(t)]
        pl.append("   %-16s %d" % (label, len(items)))
    write("места-и-бренды.txt", pl)

    # ---------- 9. ВРЕМЯ И СТАТИСТИКА ----------
    tm = ["СТАТИСТИКА ПО ВРЕМЕНИ И ДЛИНЕ", ""]
    by_hour = collections.Counter()
    by_weekday = collections.Counter()
    by_year = collections.Counter()
    emo_year = collections.Counter()
    len_year = collections.defaultdict(list)
    for t, ts in her:
        d = datetime.fromtimestamp(ts / 1000, MSK)
        by_hour[d.hour] += 1
        by_weekday[d.strftime("%A")] += 1
        by_year[d.year] += 1
        len_year[d.year].append(len(t.split()))
        if re.search(r"[❤💋🫶🥰😭🙄🩷]", t):
            emo_year[d.year] += 1
    tm.append("По часам (Красноярск):")
    for h in range(24):
        tm.append("   %02d:00  %6d  %s" % (h, by_hour.get(h, 0), "#" * int(by_hour.get(h, 0) / 200)))
    tm.append("")
    tm.append("По дням недели:")
    for d, n in by_weekday.most_common():
        tm.append("   %-10s %6d" % (d, n))
    tm.append("")
    tm.append("По годам: всего её сообщений | с эмодзи | средняя длина")
    for y in sorted(by_year):
        ls = len_year[y]
        tm.append("   %d  %6d | %5d (%.0f%%) | %.2f слов" % (y, by_year[y], emo_year.get(y, 0),
                                                            100.0 * emo_year.get(y, 0) / by_year[y], sum(ls) / len(ls)))
    write("время-и-статистика.txt", tm)

    print("\nВСЁ ГОТОВО")


if __name__ == "__main__":
    main()
