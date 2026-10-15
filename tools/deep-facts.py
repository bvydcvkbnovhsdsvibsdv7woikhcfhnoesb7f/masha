#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
deep-facts.py — сквозной проход по ВСЕМ 265 080 сообщениям: добыча фактов с доказательствами.

    python tools/deep-facts.py

Что делает: проходит каждое сообщение архива и собирает кандидатов на факты
(имя, родные, возраст, город, учёба, даты, привычки) вместе с доказательствами —
датой, автором и самим сообщением. Пишет:
    tools/facts-report.txt      — человекочитаемый отчёт
    archive/masha-facts.json.gz — машинный набор фактов для «мозга»
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

# слова, похожие на имена, но ими не являющиеся (служебные и междометия)
NOT_NAME = set("""мама папа бабушка дедушка девочка девушка милая любимая зая зайка зайчик коть котик
котёнок котенок солнышко солнце ангел малыш малой муж жена дура дурочка умница умничка красотка
привет пока спасибо пожалуйста давай хватит стой точно устала извини прости целую тебе твои какой
какая какое кого кому сколько поняла понял нельзя спать можно помочь хочешь кушала ахуела блять
хах хаха хахаха хахахаха дааа урааа завтра сегодня дома тогда куда откуда правда сука измена
пизда нихуя многа беда сама хотя меня тебя твоя время секунду минутку кайф ой эээ ааа неи неа
хоть ну ах ох эх блин капец ужас кошмар что кто где когда почему зачем как это она он они мы вы ты я
всё все да нет""".split())


def load():
    data = json.loads(gzip.open(os.path.join(ROOT, "archive", "masha-archive.json.gz"), "rb").read().decode("utf-8"))
    return data["messages"]


class Evidence:
    def __init__(self):
        self.items = collections.Counter()
        self.examples = collections.defaultdict(list)

    def add(self, value, role, text, ts, keep=3):
        if not value:
            return
        self.items[value] += 1
        if len(self.examples[value]) < keep:
            self.examples[value].append((role, text[:110], ts))

    def top(self, n=15):
        return self.items.most_common(n)


def main():
    rows = load()
    msgs = []
    for r in rows:
        t = re.sub(r"\s+", " ", str(r[2] or "")).strip()
        msgs.append((r[0], t, r[1]))
    print("Прошёл по всем сообщениям: %d" % len(msgs))

    his = [(t, ts) for role, t, ts in msgs if role == "user" and t]
    her = [(t, ts) for role, t, ts in msgs if role == "assistant" and t]

    out = []
    W = out.append

    def head(title):
        W("")
        W("=" * 78)
        W("  " + title)
        W("=" * 78)

    def dump(ev, title, limit=15):
        head(title)
        if not ev.items:
            W("  (ничего не найдено)")
            return
        for value, n in ev.top(limit):
            W("  %6d  %s" % (n, value))
            for role, text, ts in ev.examples[value]:
                d = datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y")
                W("          [%s %s] %s" % (d, "она" if role == "assistant" else "он ", text))

    # ---------- 1. ИМЯ: чем он её зовёт ----------
    voc = Evidence()
    for t, ts in his:
        for m in re.finditer(r"(?:^|[,!?]\s+)([А-ЯЁ][а-яё]{2,10})\s*(?:[,!?.]|$)", t):
            w = m.group(1)
            if w.lower() not in NOT_NAME:
                voc.add(w.capitalize(), "user", t, ts)
        for m in re.finditer(r"(?:люблю тебя|целую|обнимаю|спасибо|доброе утро|сладких снов)[,!\s]+([А-ЯЁ][а-яё]{2,10})", t):
            w = m.group(1)
            if w.lower() not in NOT_NAME:
                voc.add(w.capitalize(), "user", t, ts, keep=2)
    dump(voc, "1. ИМЯ: как он к ней обращается (звательный падеж в его сообщениях)", 25)

    # ---------- 2. ИМЯ: как она сама себя называет ----------
    self_name = Evidence()
    for t, ts in her:
        for m in re.finditer(r"\b(?:я|меня зовут|моё имя|мое имя)\s+([А-ЯЁ][а-яё]{2,10})\b", t):
            w = m.group(1)
            if w.lower() not in NOT_NAME:
                self_name.add(w.capitalize(), "assistant", t, ts)
        for m in re.finditer(r"\bя\s+(?!не\b)([А-ЯЁ][а-яё]{2,10})\b", t):
            w = m.group(1)
            if w.lower() not in NOT_NAME:
                self_name.add(w.capitalize(), "assistant", t, ts, keep=1)
    dump(self_name, "2. ИМЯ: как она говорит о себе («я …», «меня зовут …»)", 20)

    # ---------- 3. ИМЯ: отрицания и споры ----------
    head("3. ИМЯ: где она отрицает имя или спорят о нём")
    rx = re.compile(r"(я не [А-ЯЁ][а-яё]{2,10}|какая (?:у тебя )?[А-ЯЁ][а-яё]{2,10}|не [А-ЯЁ][а-яё]{2,10}\b|моё имя|мое имя|имя знаешь|зовут)", re.I)
    n = 0
    for role, t, ts in msgs:
        if rx.search(t):
            d = datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y")
            W("   [%s %s] %s" % (d, "она" if role == "assistant" else "он ", t[:110]))
            n += 1
            if n >= 30:
                break
    if not n:
        W("  (не найдено)")

    # ---------- 4. ИМЯ ИЗ АНКЕТ ДАЙВИНЧИКА ----------
    prof = Evidence()
    for role, t, ts in msgs:
        for m in re.finditer(r"анкета[:\s]*([А-ЯЁ][а-яё]{2,12})\s*,\s*(\d{1,2})", t):
            prof.add("%s, %s" % (m.group(1), m.group(2)), role, t, ts)
    dump(prof, "4. ИМЯ: имена из уведомлений «понравилась анкета» (её и чужие)", 20)

    # ---------- 5. РОДНЫЕ: имена ----------
    kin = Evidence()
    KIN_RX = [
        (r"(?:мам[ауы]|мама|мамой|маме)\s+(?:зовут\s+)?([А-ЯЁ][а-яё]{2,10})", "мама"),
        (r"(?:пап[ауы]|папа|папой|отчим[ау]?|отчим)\s+(?:зовут\s+)?([А-ЯЁ][а-яё]{2,10})", "папа/отчим"),
        (r"(?:брат[ау]?|малой|малого|малому|брат)\s+(?:зовут\s+)?([А-ЯЁ][а-яё]{2,10})", "брат"),
        (r"(?:бабушк[ауи]|бабушка)\s+(?:зовут\s+)?([А-ЯЁ][а-яё]{2,10})", "бабушка"),
        (r"(?:кот[ау]?|кота|кошк[ау]|котёнка|котенка)\s+(?:зовут\s+)?([А-ЯЁ][а-яё]{2,10})", "кот"),
        (r"зовут\s+([А-ЯЁ][а-яё]{2,10})", "«зовут»"),
    ]
    for rx, label in KIN_RX:
        pat = re.compile(rx, re.I)
        for role, t, ts in msgs:
            for m in pat.finditer(t):
                w = m.group(1)
                if w.lower() not in NOT_NAME:
                    kin.add(label + ": " + w.capitalize(), role, t, ts, keep=2)
    dump(kin, "5. РОДНЫЕ: имена мамы, папы, брата, бабушки, кота (только если явно сказано)", 25)

    # ---------- 6. КТО ОН ----------
    him = Evidence()
    for role, t, ts in msgs:
        for w in ["Эдуард", "Эдик", "Адик", "Эд", "Эдюша", "Эдуардик"]:
            if re.search(r"\b" + w, t, re.I):
                him.add(w, role, t, ts, keep=1)
    dump(him, "6. ЕГО ИМЯ (как она его называет и как он сам)", 12)

    # ---------- 7. ВОЗРАСТ И ДНИ РОЖДЕНИЯ ----------
    age = Evidence()
    for role, t, ts in msgs:
        for m in re.finditer(r"\bмне\s+(\d{1,2})\b", t, re.I):
            age.add("мне " + m.group(1), role, t, ts, keep=2)
    dump(age, "7. ВОЗРАСТ («мне N» — её и его фразы)", 12)

    bday = Evidence()
    for role, t, ts in msgs:
        for m in re.finditer(r"(\d{1,2})\s+(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\w*", t, re.I):
            bday.add("%s %s" % (m.group(1), m.group(2).lower()), role, t, ts, keep=1)
    dump(bday, "7б. ДАТЫ: какие числа и месяцы упоминаются чаще всего", 18)

    # ---------- 8. УЧЁБА, ГОРОД, РАБОТА ----------
    misc = Evidence()
    for role, t, ts in msgs:
        for rx, label in [(r"\b(\d{1,2})\s*класс", "класс"), (r"\b(ОГЭ|ЕГЭ|огэ|егэ)", "экзамен"),
                          (r"\b(колледж|техникум|универ|институт)", "учёба его"), (r"\b(армия|армию|военкомат)", "армия"),
                          (r"\b(Красноярск\w*)", "город"), (r"\b(работа|работаю|смена|зарплат\w*)", "работа")]:
            pat = re.compile(rx)
            for m in pat.finditer(t):
                misc.add(label + ": " + (m.group(0) if m.groups() and m.group(1) else label), role, t, ts, keep=1)
    dump(misc, "8. УЧЁБА / ГОРОД / РАБОТА / АРМИЯ", 20)

    # ---------- 9. ПРИВЫЧКИ И БЫТ ----------
    habits = Evidence()
    for t, ts in her:
        for rx, label in [(r"тренировк\w*|танц\w*", "тренировки/танцы"), (r"школ\w*|урок\w*", "школа"),
                          (r"голов\w*\s+бол\w*|болит\s+голов\w*", "голова болит"), (r"тошн\w*", "тошнота"),
                          (r"сырник\w*", "сырники"), (r"банан\w*", "бананы"), (r"кофе", "кофе"),
                          (r"кот\w*|коть|котик", "кот"), (r"малой|брат", "брат/малой"),
                          (r"лошад\w*", "лошади"), (r"квадроцикл\w*|квадрик", "квадроцикл"),
                          (r"в\s+тт|тикток\w*", "тикток"), (r"песн\w*|музык\w*", "музыка"),
                          (r"не\s+сплю|спать\s+хочу|я\s+спать", "сон"), (r"погуля\w*|гулять", "гулять")]:
            pat = re.compile(rx, re.I)
            for m in pat.finditer(t):
                habits.add(label, role, t, ts, keep=1)
    dump(habits, "9. ЕЁ ПРИВЫЧКИ И БЫТ (по её же сообщениям)", 20)

    # ---------- 10. ЗНАКОМСТВО И ОТНОШЕНИЯ ----------
    head("10. ЗНАКОМСТВО, ДАТЫ, ОТНОШЕНИЯ (все упоминания)")
    rx = re.compile(r"(дайвинчик|дайвин|познакомились|годовщина|18 августа|август 2023|первый раз написал|два года|встречаемся|отношения)", re.I)
    n = 0
    for role, t, ts in msgs:
        if rx.search(t):
            d = datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y")
            W("   [%s %s] %s" % (d, "она" if role == "assistant" else "он ", t[:110]))
            n += 1
            if n >= 40:
                break

    text = "\n".join(out) + "\n"
    with open(os.path.join(HERE, "facts-report.txt"), "w", encoding="utf-8") as f:
        f.write(text)
    print("Отчёт: tools/facts-report.txt (%d строк)" % len(out))

    # ---------- машинный набор фактов ----------
    facts = {
        "v": 1,
        "builtAt": datetime.now(MSK).isoformat(),
        "messages": len(msgs),
        "hisVocatives": [{"name": k, "count": v} for k, v in voc.top(25)],
        "herSelfNames": [{"name": k, "count": v} for k, v in self_name.top(15)],
        "profileNames": [{"value": k, "count": v} for k, v in prof.top(25)],
        "kin": [{"value": k, "count": v} for k, v in kin.top(25)],
        "hisName": [{"value": k, "count": v} for k, v in him.top(10)],
        "ages": [{"value": k, "count": v} for k, v in age.top(12)],
        "dates": [{"value": k, "count": v} for k, v in bday.top(18)],
        "misc": [{"value": k, "count": v} for k, v in misc.top(20)],
        "habits": [{"value": k, "count": v} for k, v in habits.top(20)]
    }
    dst = os.path.join(ROOT, "archive", "masha-facts.json.gz")
    blob = json.dumps(facts, ensure_ascii=False, separators=(",", ":"))
    with open(dst, "wb") as f:
        f.write(gzip.compress(blob.encode("utf-8"), 9))
    print("Факты: archive/masha-facts.json.gz (%.0f КБ)" % (os.path.getsize(dst) / 1024))


if __name__ == "__main__":
    main()
