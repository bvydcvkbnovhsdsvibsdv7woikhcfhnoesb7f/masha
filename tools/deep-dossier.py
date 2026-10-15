#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
deep-dossier.py — максимально глубокий разбор архива: все детали по всем 265 080 сообщениям.

    python tools/deep-dossier.py

Разделы: хронология отношений · люди вокруг · семья · быт и расписание · музыка и игры ·
конфликты и примирения · планы и мечты · здоровье · внешность · внутренние шутки и словечки ·
что он для неё значит · эволюция стиля по годам.
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
D = lambda ts: datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y")
DT = lambda ts: datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y %H:%M")

STOP = set("""и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только
ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был
него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней
для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того
потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем
всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего
них какая много разве три эту моя впрочем свою этой перед иногда лучше чуть том нельзя такой им
более всегда конечно всю между это оно ах ох ух эх кстати вообще просто очень короче типа типо
вроде кажись значит ага угу ладно ок окей ясно спс спасибо пожалуйста привет пока щас знаю
знаешь хочешь будешь давай надо нету такое кажется наверное почему зачем когда сегодня завтра
вчера постоянно сильно прям блин капец пипец ужас кошмар хватит совсем здесь там тогда откуда""".split())

FAMILY = r"(мама|мамой|маме|маму|мать|отчим\w*|папа|папой|папе|папу|малой|малого|малому|брат\w*|бабушк\w*|тёт\w*|тет\w*|сестр\w*|сестра|кот\w*|коть|кошк\w*|Ваня|Ваню|Ване)"


def main():
    rows = json.loads(gzip.open(os.path.join(ROOT, "archive", "masha-archive.json.gz"), "rb").read().decode("utf-8"))["messages"]
    msgs = [(r[0], re.sub(r"\s+", " ", str(r[2] or "")).strip(), r[1]) for r in rows if r[2]]
    his = [(t, ts) for role, t, ts in msgs if role == "user"]
    her = [(t, ts) for role, t, ts in msgs if role == "assistant"]

    out = []
    W = out.append
    def head(t):
        W(""); W("=" * 80); W("  " + t); W("=" * 80)
    def quotes(items, limit=20, width=110):
        for role, t, ts in items[:limit]:
            W("   [%s %s] %s" % (D(ts), "она" if role == "assistant" else "он ", t[:width]))
    def find(rx, limit=20, who=None, width=110):
        pat = re.compile(rx, re.I)
        res = [(r, t, ts) for r, t, ts in msgs if (who is None or r == who) and pat.search(t)]
        W("   найдено: %d" % len(res))
        quotes(res, limit, width)
        return res

    W("ГЛУБОКИЙ РАЗБОР АРХИВА — %d сообщений (она %d, он %d)" % (len(msgs), len(her), len(his)))

    # ---------- A. ХРОНОЛОГИЯ ----------
    head("A. ХРОНОЛОГИЯ ОТНОШЕНИЙ")
    W("Первое сообщение: [%s] %s: %s" % (DT(msgs[0][2]), "она" if msgs[0][0] == "assistant" else "он ", msgs[0][1][:90]))
    W("Последнее сообщение: [%s] %s: %s" % (DT(msgs[-1][2]), "она" if msgs[-1][0] == "assistant" else "он ", msgs[-1][1][:90]))

    for label, rx in [("первое «люблю»", r"\bлюблю\b"), ("первое «скучаю»", r"скучаю"),
                      ("первое «прости»", r"\bпрости\b"), ("первое «зая»", r"\bзая\b"),
                      ("первое упоминание мужа", r"\bмуж\w*\b"), ("первое «целую»", r"целую"),
                      ("первый «игнор»", r"игнор"), ("первая ссора", r"поссор|ссор\w+")]:
        pat = re.compile(rx, re.I)
        for r, t, ts in msgs:
            if pat.search(t):
                W("%-24s [%s] %s: %s" % (label, DT(ts), "она" if r == "assistant" else "он ", t[:80]))
                break

    days = collections.Counter(D(ts) for _, _, ts in msgs)
    W("\nСамые активные дни:")
    for d, n in days.most_common(12):
        W("   %s — %d сообщений" % (d, n))

    # паузы
    gaps = []
    for i in range(1, len(msgs)):
        dt = msgs[i][2] - msgs[i - 1][2]
        if dt > 24 * 3600 * 1000:
            gaps.append((dt, msgs[i - 1], msgs[i]))
    gaps.sort(key=lambda x: -x[0])
    W("\nСамые длинные паузы в переписке:")
    for dt, a, b in gaps[:6]:
        W("   %d дней: с %s до %s" % (dt / 86400000, D(a[2]), D(b[2])))
        W("        перед паузой: %s" % a[1][:80])
        W("        после паузы:  %s" % b[1][:80])

    head("A2. «ГОДОВЩИНА», «ДВА ГОДА», ПЛАНЫ НА БУДУЩЕЕ")
    find(r"годовщин|два года|2 года|три года|познакомились", 25)
    find(r"(приеду|приезжай|увидимся|встретимся|вживую|в живую|билет|поезд|самолёт|самолет)", 25)
    find(r"(свадьб|замуж|жен\w+ меня|Лушникова|фамили\w+)", 20)
    find(r"(дети|ребёнок|ребенок|сын|дочь|беременн)", 15)

    # ---------- B. ЛЮДИ ----------
    head("B. ЛЮДИ ВОКРУГ (кто упоминается и как часто)")
    people = collections.Counter()
    ctx_examples = collections.defaultdict(list)
    NAME = re.compile(r"\b([А-ЯЁ][а-яё]{2,12})\b")
    SOCIAL = re.compile(r"(подруг\w*|друг\w*|парн\w*|мальчик\w*|девочк\w*|одноклассниц\w*|сестр\w*|брат\w*|тёт\w*|тет\w*|дяд\w*|крёстн\w*|крестн\w*|бывш\w*)")
    for role, t, ts in msgs:
        for m in NAME.finditer(t):
            w = m.group(1)
            if w.lower() in STOP or len(w) < 3:
                continue
            people[w] += 1
            if len(ctx_examples[w]) < 2 and SOCIAL.search(t):
                ctx_examples[w].append((role, t, ts))
    for w, n in people.most_common(40):
        W("   %6d  %s" % (n, w))
        for role, t, ts in ctx_examples[w]:
            W("           [%s] %s" % (D(ts), t[:100]))

    # ---------- C. СЕМЬЯ ----------
    head("C. СЕМЬЯ И ДОМ — все истории")
    for who, rx in [("мама", r"\bмам[аеуыой]?\b|мамочк\w*"),
                    ("отчим/папа", r"отчим\w*|\bпап[аеуыой]?\b|папочк\w*"),
                    ("брат Ваня / малой", r"\bмалой\b|\bмал(ого|ому|ым|енький)\b|\bВан[яюеи]\b|\bбрат\w*"),
                    ("бабушка", r"бабушк\w*"),
                    ("тётя/дядя/сёстры", r"\bтёт\w+|\bтет\w+|\bдяд\w+|\bсестр\w+|\bсестра\b"),
                    ("коты", r"\bкот\w*|\bкоть\b|\bкошк\w*|\bмурч\w*")]:
        W("\n--- %s ---" % who)
        find(rx, 18, who="assistant")

    # ---------- D. БЫТ И РАСПИСАНИЕ ----------
    head("D. БЫТ, РАСПИСАНИЕ, ПРИВЫЧКИ")
    W("--- во сколько ложится и встаёт ---")
    find(r"(я спать|спать хочу|ложусь|уснул\w*|проснул\w*|встал\w*|я в \d{1,2} только проснулась)", 20, who="assistant")
    W("\n--- школа ---")
    find(r"(в школ\w+|урок\w*|контрольн\w*|физик\w*|биолог\w*|ОГЭ|ЕГЭ|каникул\w*)", 18, who="assistant")
    W("\n--- тренировки ---")
    find(r"(тренировк\w*|танц\w*|старшие|похуде\w*|вес\b)", 18, who="assistant")
    W("\n--- еда ---")
    find(r"(сырник\w*|банан\w*|кофе|чипсик\w*|шоколадк\w*|куша\w*|покуша\w*|ем\b|поела)", 18, who="assistant")
    W("\n--- телефон, игры, приложения ---")
    find(r"(роблокс\w*|бравл\w*|гренни|майнкрафт\w*|тт\b|тикток\w*|ютуб\w*|телеграм\w*|игра\w*|стикер\w*)", 18, who="assistant")

    # ---------- E. МУЗЫКА ----------
    head("E. МУЗЫКА — что слушает")
    find(r"(песн\w*|трек\w*|музык\w*|наушник\w*|заела|исполнител\w*|бит\w*)", 25, who="assistant")

    # ---------- F. КОНФЛИКТЫ ----------
    head("F. КОНФЛИКТЫ И ПРИМИРЕНИЯ")
    conf = find(r"(поссор\w*|ссор\w*|обидел\w*|обидн\w*|психанул\w*|злюсь|бесит|надоел\w*|устал\w+ от|игнор\w*)", 30)
    W("\n--- как мирятся ---")
    find(r"(прости|извини|помирил\w*|мир\b|не обижайся|я не обижаюсь|хватит извиняться)", 25)
    W("\n--- из-за чего ссоры (частые слова рядом) ---")
    words = collections.Counter()
    for role, t, ts in msgs:
        if re.search(r"поссор|ссор|обидел|психанул", t, re.I):
            for w in re.findall(r"[а-яё]{4,}", t.lower()):
                if w not in STOP:
                    words[w] += 1
    W("   " + ", ".join("%s(%d)" % (w, n) for w, n in words.most_common(25)))

    # ---------- G. ЗДОРОВЬЕ ----------
    head("G. ЗДОРОВЬЕ — все эпизоды")
    find(r"(голов\w*\s+бол\w*|болит\s+голов\w*|тошн\w*|температур\w*|горл\w*|живот\w*|врач\w*|таблетк\w*|больниц\w*|панич\w*|обморок\w*)", 30, who="assistant")

    # ---------- H. ВНЕШНОСТЬ ----------
    head("H. ВНЕШНОСТЬ И ОДЕЖДА")
    find(r"(волос\w*|карие|глаз\w*|рост\w*|худая|худеньк\w*|фигур\w*|кожа|брови|ногт\w*|стрижк\w*|куртк\w*|кроссовк\w*|плать\w*|юбк\w*)", 25)

    # ---------- I. ШУТКИ И СЛОВЕЧКИ ----------
    head("I. ВНУТРЕННИЕ ШУТКИ И ЕЁ СЛОВЕЧКИ")
    for label, rx in [("лошади", r"лошад\w*"), ("квадроцикл", r"квадроцикл\w*|квадрик\w*"),
                      ("«Пит»", r"\bПит\w*\b"), ("«муж/жена»", r"\bмуж\w*|\bжен[ауы]\b"),
                      ("«нытик»/«дурак»", r"нытик\w*|дурак\w*|дурочк\w*"), ("«зая/коть»", r"\bза[йя]\w*|\bкоть\b|\bкотик\w*")]:
        W("\n--- %s ---" % label)
        find(rx, 10)

    W("\n--- её слова, которые она использует ГОРАЗДО чаще него ---")
    wher, whis = collections.Counter(), collections.Counter()
    for t, ts in her:
        for w in re.findall(r"[а-яё]{4,}", t.lower()):
            if w not in STOP:
                wher[w] += 1
    for t, ts in his:
        for w in re.findall(r"[а-яё]{4,}", t.lower()):
            if w not in STOP:
                whis[w] += 1
    diff = [(w, n, whis.get(w, 0)) for w, n in wher.items() if n >= 40]
    diff.sort(key=lambda x: -(x[1] / (x[2] + 3)))
    for w, n, o in diff[:40]:
        W("   %-16s она %6d | он %6d" % (w, n, o))

    # ---------- J. ЭВОЛЮЦИЯ ----------
    head("J. ЭВОЛЮЦИЯ: длина и темы по годам-месяцам")
    by_month = collections.defaultdict(list)
    for t, ts in her:
        by_month[datetime.fromtimestamp(ts / 1000, MSK).strftime("%Y-%m")].append(t)
    for ym in sorted(by_month):
        items = by_month[ym]
        avg = sum(len(x.split()) for x in items) / max(1, len(items))
        W("   %s: %5d сообщ., средняя длина %.1f слов" % (ym, len(items), avg))

    # ---------- K. ЧТО ОН ДЛЯ НЕЁ ЗНАЧИТ ----------
    head("K. ЧТО ОН ДЛЯ НЕЁ ЗНАЧИТ (её слова о нём)")
    find(r"(ты мой|мой любимый|мой мальчик|ты лучший|самый лучший|ты для меня|без тебя|не могу без тебя|ты моё|ты мое)", 25, who="assistant")

    text = "\n".join(out) + "\n"
    dst = os.path.join(HERE, "dossier-full.txt")
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
    print("Готово: %s (%d строк, %.0f КБ)" % (dst, len(out), os.path.getsize(dst) / 1024))


if __name__ == "__main__":
    main()
