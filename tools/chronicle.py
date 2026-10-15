#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
chronicle.py — точная хроника: КАЖДЫЙ день переписки + книга её цитат.

    python tools/chronicle.py

Пишет:
    tools/chronicle.md   — по каждому активному дню: сколько сообщений, её лучшие
                           сообщения того дня, метки событий (ссора, примирение,
                           подарок, встреча, здоровье…), топ-дни, первые упоминания
    tools/quotebook.md   — её цитаты по 14 эмоциональным темам (по 60 на тему)
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

MARKERS = [
    ("ссора", r"поссор|ссор\w+|обидел|психанул|наорал|бесит|злюсь"),
    ("примирение", r"прости|извини|помирил|не обижайся|я не обижаюсь"),
    ("ревность", r"ревну|ревност|с кем ты|кто это"),
    ("подарок", r"подар\w+|сюрприз|цвет\w+|букет"),
    ("встреча/приезд", r"приеду|приезжай|встретимся|увидимся|поезд|билет|вокзал"),
    ("свадьба/будущее", r"свадьб|замуж|дети|ребёнок|ребенок|квартир|жить вместе|вживую"),
    ("здоровье", r"голов\w* бол\w*|болит|тошн\w*|температур\w*|горл\w*|таблетк\w*|врач"),
    ("тренировка", r"тренировк|танц\w+|волейбол|похуде"),
    ("школа", r"школ\w+|урок\w*|контрольн\w*|экзамен|физик|биолог"),
    ("кот", r"\bкот\w*|коть|котик|котёнок|котенок"),
    ("семья", r"мама|мамой|маме|отчим|папой|бабушк|малой|Ваня|брат"),
    ("сон", r"спать|сплю|уснул|проснул|выспал|ложусь"),
    ("еда", r"сырник|банан|кофе|чипсик|шоколадк|куша|покуша"),
    ("игры", r"роблокс|бравл|гренни|игра\w+|стандофф"),
    ("музыка", r"песн\w+|трек|музык|наушник"),
    ("деньги", r"деньг|рубл|перевёл|перевод|зарплат|1000|500"),
]

TOPICS_FIRST = {
    "первое «люблю»": r"\bлюблю\b",
    "первое «скучаю»": r"скучаю",
    "первое «зая»": r"\bзая\b",
    "первое «коть»": r"\bкоть\b",
    "первое «мууж»": r"муу+ж",
    "первое «обойдешься»": r"обойдешься",
    "первое «приплыли»": r"приплыли",
    "первое «-_-»": r"-_-\s*$",
    "первое упоминание лошади": r"лошад",
    "первое упоминание пита": r"\bпит\b",
    "первое упоминание квадрика": r"квадрик",
    "первое «прости»": r"\bпрости\b",
    "первое «обиделась»": r"обиделась",
    "первое «игнор»": r"игнор",
    "первое про свадьбу": r"свадьб",
    "первое про приезд": r"приезжай|приеду",
    "первое про военкомат": r"военкомат",
    "первое про Дайвинчик": r"дайвинчик|дайвин",
    "первое про Ваню": r"\bВан[яюе]\b",
    "первое про школу": r"в школ",
    "первое про тренировку": r"тренировк",
    "первое про головную боль": r"голов\w* бол|болит голов",
    "первое «сладких снов»": r"сладких снов",
    "первое «доброе утро»": r"доброе утро",
}

SALIENT = re.compile(r"(люблю|скучаю|прости|обидел|поссор|приеду|подар|болит|боюсь|расстат|навсегда|важно|хочу сказать|устал)", re.I)


def salience(t):
    n = len(t.split())
    if n < 4 or n > 26:
        return 0.0
    s = 1.0 + (min(n, 16) - 4) * 0.22
    if SALIENT.search(t):
        s += 2.2
    if re.search(r"[❤💋🫶🥰😭😢🙄🩷]", t):
        s += 0.4
    return s


def main():
    rows = json.loads(gzip.open(os.path.join(ROOT, "archive", "masha-archive.json.gz"), "rb").read().decode("utf-8"))["messages"]
    msgs = []
    for r in rows:
        t = re.sub(r"\s+", " ", str(r[2] or "")).strip()
        if not t or r[1] >= CUTOFF or SPAM.search(t):
            continue
        msgs.append((r[0], t, r[1]))
    print("Сообщений (без расставания и мусора): %d" % len(msgs))

    # ---------- ХРОНИКА ПО ДНЯМ ----------
    by_day = collections.OrderedDict()
    for role, t, ts in msgs:
        day = datetime.fromtimestamp(ts / 1000, MSK).strftime("%Y-%m-%d")
        by_day.setdefault(day, []).append((role, t, ts))
    print("Активных дней: %d" % len(by_day))

    md = []
    W = md.append
    W("# ТОЧНАЯ ХРОНИКА ПЕРЕПИСКИ — каждый день")
    W("")
    W("Источник: 265 080 сообщений (chat1 + chat2). Расставание 13–18.08.2026 и пересланный мусор исключены.")
    W("Формат: **дата** — всего сообщений (она/он) · метки событий · её 3 самых «событийных» сообщения дня.")
    W("")

    # первые упоминания
    W("## Первые упоминания важного")
    W("")
    for label, rx in TOPICS_FIRST.items():
        pat = re.compile(rx, re.I)
        for role, t, ts in msgs:
            if pat.search(t):
                d = datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y %H:%M")
                W("- **%s** — %s (%s): %s" % (label, d, "она" if role == "assistant" else "он", t[:110]))
                break
    W("")

    # топ-дни
    W("## Самые активные дни")
    W("")
    top_days = sorted(by_day.items(), key=lambda kv: -len(kv[1]))[:25]
    for day, items in top_days:
        her = sum(1 for r, _, _ in items if r == "assistant")
        W("- **%s** — %d сообщений (она %d, он %d)" % (day, len(items), her, len(items) - her))
    W("")

    # дни по месяцам
    W("## Хроника по дням")
    W("")
    cur_month = None
    for day in sorted(by_day):
        items = by_day[day]
        month = day[:7]
        if month != cur_month:
            cur_month = month
            total_her = sum(1 for r, _, _ in msgs if r == "assistant" and datetime.fromtimestamp(_ / 1000, MSK).strftime("%Y-%m") == month)
            W("")
            W("### %s" % month)
            W("")
        her = [(t, ts) for r, t, ts in items if r == "assistant"]
        his = [(t, ts) for r, t, ts in items if r == "user"]
        marks = []
        joined = " ".join(t for _, t, _ in items).lower()
        for label, rx in MARKERS:
            if re.search(rx, joined, re.I):
                marks.append(label)
        # её 3 лучших сообщения дня
        scored = sorted(((salience(t), ts, t) for t, ts in her if salience(t) > 0), key=lambda x: (-x[0], x[1]))
        picked, seen = [], set()
        for s, ts, t in scored:
            k = t.lower()[:22]
            if k in seen:
                continue
            seen.add(k)
            picked.append(t)
            if len(picked) >= 3:
                break
        W("**%s** — %d (%d/%d)%s" % (day, len(items), len(her), len(his), (" · " + ", ".join(marks)) if marks else ""))
        for q in picked:
            W("   - %s" % q[:190])
        W("")

    chronicle = "\n".join(md) + "\n"
    with open(os.path.join(HERE, "chronicle.md"), "w", encoding="utf-8") as f:
        f.write(chronicle)
    print("chronicle.md: %.0f КБ, строк %d" % (len(chronicle.encode("utf-8")) / 1024, len(md)))

    # ---------- КНИГА ЦИТАТ ----------
    book = []
    B = book.append
    B("# КНИГА ЕЁ ЦИТАТ — по темам (реальные сообщения с датами)")
    B("")
    CATS = [
        ("нежность и любовь", r"люблю|обнимаю|целую|скучаю|мой мальчик|мууж|зая"),
        ("утро и ночь", r"доброе утро|сладких снов|спать|проснул|выспал"),
        ("злость и обида", r"дурак|обойдешься|хватит|бесит|отстань|нафиг|игнор|обиделась"),
        ("примирение", r"прости|извини|не обижайся|я не обижаюсь|помирил"),
        ("ревность", r"ревну|с кем|кто это|шиппер"),
        ("семья: мама и отчим", r"мама|мамой|маме|отчим|папой|бабушк"),
        ("брат малой / Ваня", r"малой|малого|Ваня|брат"),
        ("кот и котёнок", r"\bкот\w*|коть|котик|котёнок|котенок"),
        ("школа и уроки", r"школ|урок|контрольн|экзамен|физик|биолог"),
        ("тренировки и танцы", r"тренировк|танц|волейбол|похуде"),
        ("еда", r"сырник|банан|кофе|чипсик|шоколадк|куша|покуша|аппетит"),
        ("здоровье", r"голов\w* бол|болит|тошн|температур|горло|таблетк|устала"),
        ("игры и телефон", r"роблокс|бравл|гренни|игра|тикток|\bтт\b|наушник"),
        ("музыка", r"песн|трек|музык|заела"),
        ("шутки: лошадь, пит, мууж", r"лошад|пит\b|квадрик|мууж|приплыли"),
        ("планы: приезд, свадьба, будущее", r"приеду|приезжай|встретимся|увидимся|свадьб|замуж|дети|квартир"),
        ("деньги и подарки", r"деньг|рубл|подар|перевёл|перевод|скинул"),
        ("учёба и работа его", r"колледж|пары|работа|зарплат|военкомат|арми"),
    ]
    for title, rx in CATS:
        pat = re.compile(rx, re.I)
        items = [(t, ts) for role, t, ts in msgs if role == "assistant" and pat.search(t)]
        scored = []
        seen = set()
        for t, ts in items:
            n = len(t.split())
            if n < 3 or n > 26:
                continue
            k = t.lower()[:22]
            if k in seen:
                continue
            seen.add(k)
            scored.append((1 + (min(n, 16) - 3) * 0.2 + (1.2 if SALIENT.search(t) else 0), ts, t))
        scored.sort(key=lambda x: (-x[0], x[1]))
        B("## %s — всего %d её сообщений" % (title, len(items)))
        B("")
        for s, ts, t in scored[:60]:
            B("- `%s` %s" % (datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y"), t[:200]))
        B("")
    quotebook = "\n".join(book) + "\n"
    with open(os.path.join(HERE, "quotebook.md"), "w", encoding="utf-8") as f:
        f.write(quotebook)
    print("quotebook.md: %.0f КБ" % (len(quotebook.encode("utf-8")) / 1024))

    # ---------- ИТОГОВЫЕ ЦИФРЫ ----------
    per_month = collections.defaultdict(lambda: [0, 0, 0, collections.Counter()])
    for role, t, ts in msgs:
        m = datetime.fromtimestamp(ts / 1000, MSK).strftime("%Y-%m")
        per_month[m][0] += 1
        per_month[m][1 if role == "assistant" else 2] += 1
        for w in re.findall(r"[а-яё]{4,}", t.lower()):
            per_month[m][3][w] += 1
    print("\nмесяц      всего   она    он   топ-слова")
    for m in sorted(per_month):
        tot, her, his, words = per_month[m]
        W2 = ", ".join(w for w, _ in words.most_common(5))
        print("%s %7d %6d %6d   %s" % (m, tot, her, his, W2))


if __name__ == "__main__":
    main()
