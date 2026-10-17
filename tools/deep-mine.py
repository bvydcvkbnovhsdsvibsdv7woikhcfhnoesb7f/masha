#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
deep-mine.py — самое глубокое разминирование её речи (126 801 сообщение).

    python tools/deep-mine.py

Пишет:
    tools/voice-bank.json   — машинно: архетипы реплик с примерами, вкусы,
                              манера рассказывать, банк «вопрос → ответ»
    tools/voice-report.md   — человекочитаемо то же самое

Зачем: чтобы в промпт можно было подставить не «статистику», а её живые фразы
по любой ситуации — и она могла говорить о чём угодно как она сама.
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
SPAM = re.compile(r"^кому-то понравилась твоя анкета|вам пришло сообщение|напоминание|^🎰|подпишись|реклама|промокод|https?://|t\.me/|@[a-z0-9_]{4,}", re.I)

# Архетипы: (имя, регулярка). Порядок важен — берём первый подходящий.
ARCHETYPES = [
    ("приветствие", r"^(привет|хай|здравствуй|доброе утро|доброе|утро|добрый день|добрый вечер)"),
    ("прощание/сон", r"(сладких снов|спокойной ночи|я спать|пока|давай|до завтра|спи\b|ложись|иди спать)"),
    ("нежность", r"(люблю тебя|люблю|скучаю|обнимаю|целую|мой любимый|мой мальчик|зая|коть|котик|мууж|солнце|ангелок)"),
    ("обида/злость", r"(дурак|бесит|обойдешься|отстань|не пиши|обиделась|обидно|надоело|достал|хватит|злюсь|психанула|игнор)"),
    ("примирение", r"(прости|извини|я не обижаюсь|не обижайся|помирились|мир\b|ничего страшного)"),
    ("отказ", r"^(не|нет|неа|не буду|не хочу|не могу|ни за что|да ну)"),
    ("согласие", r"^(да|ага|угу|хорошо|ладно|ок|окей|конечно|ясно|понятно)"),
    ("пустышка", r"^(-_-|\.|\?|ну|ну да|эх|блин|капец|ужас|хех|ну капец)$"),
    ("школа", r"(школ|урок|контрольн|экзамен|физик|биолог|учител|домашк|огэ|егэ|класс)"),
    ("семья", r"(мама|мамой|маме|отчим|папой|бабушк|малой|Ваня|брат|тёт|сестр)"),
    ("кот", r"(\bкот|коть|котик|котёнок|котенок|мурч|царап)"),
    ("еда", r"(сырник|банан|кофе|чипсик|шоколадк|кушать|покуша|ем\b|поела|еда|аппетит|вкусн)"),
    ("сон", r"(спать|сплю|выспал|ложиться|усну|проснул|не выспал|кровать)"),
    ("игры", r"(роблокс|бравл|майнкрафт|гренни|стандофф|игра|игру|уровень)"),
    ("музыка/фильм", r"(песн|трек|музык|слушаю|фильм|сериал|мультик|аниме|тикток|ютуб|рилс)"),
    ("подруги", r"(подруг|друзья|Настя|Полина|Ксюша|одноклассн|дружим|сорусь с)"),
    ("ревность", r"(ревну|ревност|с кем|кто это|шиппер)"),
    ("планы/встречи", r"(приеду|приезжай|встретимся|увидимся|свадьб|замуж|подар|вживую)"),
    ("шутка/смех", r"(хаха|ахах|хахаха|лол|рофл|кек|кринж|ору|смешно|прикол)"),
    ("быт", r"(магазин|уборк|готовл|готовить|посуда|порядок|погуля|поехала|автобус)"),
    ("рассказ", r"^.{80,}"),
]

TASTE_RX = re.compile(r"(?:^|\s)(?:я\s+)?(люблю|обожаю|нравится|не люблю|ненавижу|бесит|терпеть не могу|хочу|мечтаю|боюсь|не нравится)\s+([^.!?\n]{3,70})", re.I)

CONNECTORS = ["короче", "и вот", "а потом", "ну так вот", "типо", "в общем", "как бы", "ну", "значится", "вообщем"]


def main():
    rows = json.loads(gzip.open(os.path.join(ROOT, "archive", "masha-archive.json.gz"), "rb").read().decode("utf-8"))["messages"]
    msgs = []
    for r in rows:
        t = re.sub(r"\s+", " ", str(r[2] or "")).strip()
        if not t or r[1] >= CUTOFF or SPAM.search(t) or t.startswith("["):
            continue
        msgs.append((r[0], t, r[1]))
    her = [(t, ts) for role, t, ts in msgs if role == "assistant"]
    his = [(t, ts) for role, t, ts in msgs if role == "user"]
    print("её сообщений: %d | его: %d" % (len(her), len(his)))

    bank = {"v": 1, "built": datetime.now(MSK).isoformat(), "her": len(her)}

    # ---------- 1. АРХЕТИПЫ ----------
    arch = collections.OrderedDict()
    for name, _ in ARCHETYPES:
        arch[name] = {"count": 0, "examples": []}
    used = set()
    for t, ts in her:
        key = None
        low = t.lower()
        for name, rx in ARCHETYPES:
            if re.search(rx, low, re.I):
                key = name
                break
        if key is None:
            key = "прочее"
        if key not in arch:
            arch[key] = {"count": 0, "examples": []}
        arch[key]["count"] += 1
        if key not in used or len(arch[key]["examples"]) < 120:
            if len(t.split()) >= 2 and len(t) <= 120:
                arch[key]["examples"].append({"d": D(ts), "t": t[:130]})
    # чистим дубли внутри архетипов
    for k, v in arch.items():
        seen = set()
        ex = []
        for e in v["examples"]:
            kk = e["t"].lower()[:28]
            if kk in seen:
                continue
            seen.add(kk)
            ex.append(e)
        v["examples"] = ex[:80]
    bank["archetypes"] = arch
    print("архетипов: %d" % len(arch))

    # ---------- 2. ВКУСЫ И МНЕНИЯ ----------
    tastes = collections.Counter()
    taste_examples = collections.defaultdict(list)
    for t, ts in her:
        for m in TASTE_RX.finditer(t):
            verb = m.group(1).lower()
            obj = re.sub(r"\s+", " ", m.group(2)).strip(" ,-")
            if len(obj) < 3:
                continue
            key = verb + " " + obj
            tastes[key] += 1
            if len(taste_examples[verb]) < 40:
                taste_examples[verb].append({"d": D(ts), "t": t[:120]})
    bank["tastes"] = [{"what": k, "n": n} for k, n in tastes.most_common(120)]
    bank["tasteExamples"] = {k: v for k, v in taste_examples.items()}

    # ---------- 3. МАНЕРА РАССКАЗЫВАТЬ ----------
    stories = [(t, ts) for t, ts in her if len(t.split()) >= 10]
    conn = collections.Counter()
    for t, ts in stories:
        low = t.lower()
        for c in CONNECTORS:
            if low.startswith(c):
                conn[c] += 1
    starts = collections.Counter()
    for t, ts in stories:
        w = re.findall(r"[а-яё]+", t.lower())
        if w:
            starts[w[0]] += 1
    bank["storytelling"] = {
        "count": len(stories),
        "connectors": [{"c": c, "n": n} for c, n in conn.most_common(12)],
        "starts": [{"w": w, "n": n} for w, n in starts.most_common(15)],
        "examples": [{"d": D(ts), "t": t[:200]} for t, ts in stories[:60]]
    }

    # ---------- 4. БАНК «ВОПРОС → ОТВЕТ» ----------
    pairs = []
    for i in range(len(msgs) - 1):
        role, t, ts = msgs[i]
        if role != "user" or not t.endswith("?"):
            continue
        nxt = msgs[i + 1]
        if nxt[0] != "assistant":
            continue
        q, a = t.strip(), nxt[1].strip()
        if len(q.split()) > 12 or len(a.split()) > 14:
            continue
        pairs.append({"q": q[:90], "a": a[:90], "d": D(ts)})
    # дедуп по паре
    seen = set()
    uniq = []
    for p in pairs:
        k = (p["q"].lower()[:30], p["a"].lower()[:30])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(p)
    bank["pairs"] = uniq[:4000]
    print("пар «вопрос → ответ»: %d (уникальных %d)" % (len(pairs), len(uniq)))

    # ---------- 5. О ЧЁМ ГОВОРИТ ----------
    topics = collections.Counter()
    TOPIC_RX = {
        "школа": r"школ|урок|класс|учител", "семья": r"мама|малой|бабушк|отчим|папой",
        "кот": r"\bкот|коть|котёнок", "еда": r"сырник|банан|кофе|чипсик|шоколадк|поела|кушать",
        "сон": r"спать|сплю|выспал", "игры": r"роблокс|майнкрафт|бравл|гренни|игра",
        "музыка": r"песн|трек|музык|плейлист", "фильмы": r"фильм|сериал|мультик|аниме",
        "подруги": r"подруг|Настя|Полина|Ксюша|дружим", "танцы": r"танц|тренировк|волейбол",
        "внешность": r"волос|ногт|макияж|накрас|прическ", "здоровье": r"болит|тошн|голова|температур|таблетк",
        "быт": r"магазин|уборк|готовлю|посуда", "погода": r"холодно|жарко|дождь|снег|ветер",
        "телефон": r"телефон|зарядк|интернет|наушник|ютуб",
    }
    for t, ts in her:
        for name, rx in TOPIC_RX.items():
            if re.search(rx, t, re.I):
                topics[name] += 1
    bank["topics"] = [{"t": k, "n": n} for k, n in topics.most_common()]

    # ---------- сохранение ----------
    with open(os.path.join(HERE, "voice-bank.json"), "w", encoding="utf-8") as f:
        json.dump(bank, f, ensure_ascii=False, separators=(",", ":"))
    print("voice-bank.json: %.0f КБ" % (os.path.getsize(os.path.join(HERE, "voice-bank.json")) / 1024))

    # ---------- отчёт ----------
    md = []
    W = md.append
    W("# РЕКОНСТРУКЦИЯ ЕЁ РЕЧИ — по всем 126 801 сообщениям")
    W("")
    W("## 1. Архетипы её реплик")
    W("")
    for name, v in arch.items():
        if not v["count"]:
            continue
        W("### %s — %d сообщений" % (name, v["count"]))
        for e in v["examples"][:14]:
            W("- `%s` %s" % (e["d"], e["t"]))
        W("")
    W("## 2. Её вкусы и мнения")
    W("")
    for item in bank["tastes"][:70]:
        W("- %s" % item["what"])
    W("")
    W("## 3. Как она рассказывает")
    W("")
    W("Соединительные слова в начале рассказа: " + ", ".join("%s (%d)" % (c["c"], c["n"]) for c in bank["storytelling"]["connectors"]))
    W("")
    W("Первые слова её рассказов: " + ", ".join("%s (%d)" % (s["w"], s["n"]) for s in bank["storytelling"]["starts"]))
    W("")
    for e in bank["storytelling"]["examples"][:30]:
        W("- `%s` %s" % (e["d"], e["t"]))
    W("")
    W("## 4. О чём она говорит")
    W("")
    W(" | ".join("%s: %d" % (t["t"], t["n"]) for t in bank["topics"]))
    W("")
    W("## 5. Банк «вопрос → её ответ» (первые 60)")
    W("")
    for p in uniq[:60]:
        W("- **%s** → «%s»" % (p["q"], p["a"]))
    W("")
    with open(os.path.join(HERE, "voice-report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")
    print("voice-report.md: %d строк" % len(md))


if __name__ == "__main__":
    main()
