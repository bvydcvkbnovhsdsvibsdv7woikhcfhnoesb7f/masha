#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
mine-names.py — вытащить из архива ПРАВДУ о её имени и родных (с доказательствами).

    python tools/mine-names.py

Считает не по моим догадкам, а по данным:
  • как он к ней обращается (слова в звательном падеже: «Маша, ...», «Вика, ...»);
  • какие женские имена вообще встречаются и с какой частотой;
  • что она говорит про своё имя («меня зовут», «моё имя»);
  • где речь про обман и настоящее имя.
"""
import collections
import gzip
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# слова, которые выглядят как имя, но ими не являются
NOT_NAMES = set("""мама папа бабушка девочка девушка милая любимая зая зайка коть котик котёнок
солнышко ангел малыш муж жена дура дурочка умница красотка привет пока спасибо пожалуйста
да нет ну ах ох эх блин капец ужас кошмар понятно хорошо ладно милая родная хорошая лучшая
что кто где когда почему зачем как это она он они мы вы ты я всё все давай хватит стой
Вика Вику Вике Викой Виктория Виктории Викторию Викуся Маша Машу Маше Машей Машенька Мария
Настя Настю Насте Настей Полина Полину Полине Лиза Лизу Лизе Кристина Даша Катя Алина Соня
Арина Ксюша Аня Саша Диана Милана Лера Юля Оля Таня Вероника Ника Мила Алиса Ева Кира Злата""".split())


def main():
    rows = json.loads(gzip.open(os.path.join(ROOT, "archive", "masha-archive.json.gz"), "rb").read().decode("utf-8"))["messages"]
    msgs = [(r[0], re.sub(r"\s+", " ", str(r[2] or "")).strip(), r[1]) for r in rows if r[2]]
    his = [(t, ts) for role, t, ts in msgs if role == "user"]
    her = [(t, ts) for role, t, ts in msgs if role == "assistant"]
    print("Сообщений: %d (он %d, она %d)\n" % (len(msgs), len(his), len(her)))

    # 1. как он её зовёт: слово в начале сообщения перед запятой или в конце
    print("=" * 70)
    print("  КАК ОН ЕЁ НАЗЫВАЕТ (обращения в его сообщениях)")
    print("=" * 70)
    voc = collections.Counter()
    for t, ts in his:
        m = re.match(r"^([А-ЯЁ][а-яё]{2,10})\s*[,!?]", t)
        if m:
            w = m.group(1)
            if w.lower() not in NOT_NAMES:
                voc[w] += 1
        for m2 in re.finditer(r"[,!]\s+([А-ЯЁ][а-яё]{2,10})\s*[,!?.]", t):
            w = m2.group(1)
            if w.lower() not in NOT_NAMES:
                voc[w] += 1
    for w, n in voc.most_common(30):
        print("   %6d  %s" % (n, w))

    # 2. все женские имена по частоте
    print()
    print("=" * 70)
    print("  ЖЕНСКИЕ ИМЕНА В ПЕРЕПИСКЕ (кандидаты на её имя)")
    print("=" * 70)
    fem = collections.Counter()
    fem_her = collections.Counter()
    fem_his = collections.Counter()
    for t, ts in his + her:
        for w in re.findall(r"\b[А-ЯЁ][а-яё]{2,9}(?:а|я|ия)\b", t):
            lw = w.lower()
            if lw in NOT_NAMES:
                continue
            fem[w] += 1
    for t, ts in his:
        for w in re.findall(r"\b[А-ЯЁ][а-яё]{2,9}(?:а|я|ия)\b", t):
            if w.lower() not in NOT_NAMES:
                fem_his[w] += 1
    for t, ts in her:
        for w in re.findall(r"\b[А-ЯЁ][а-яё]{2,9}(?:а|я|ия)\b", t):
            if w.lower() not in NOT_NAMES:
                fem_her[w] += 1
    for w, n in fem.most_common(35):
        print("   %-14s всего %6d | он %6d | она %6d" % (w, n, fem_his.get(w, 0), fem_her.get(w, 0)))

    # 3. что она говорит про своё имя
    print()
    print("=" * 70)
    print("  ЧТО ОНА ГОВОРИТ ПРО СВОЁ ИМЯ")
    print("=" * 70)
    for rx in [r"меня зовут", r"моё имя|мое имя", r"зови меня", r"на самом деле меня", r"моё настоящее имя"]:
        pat = re.compile(rx, re.I)
        hits = [t for t, ts in her if pat.search(t)]
        print("\n  «%s»: %d" % (rx, len(hits)))
        for t in hits[:8]:
            print("      %s" % t[:110])

    # 4. обман и настоящее имя
    print()
    print("=" * 70)
    print("  ГДЕ РЕЧЬ ПРО ОБМАН / НАСТОЯЩЕЕ ИМЯ")
    print("=" * 70)
    pat = re.compile(r"(врёшь|врешь|соврал|соврала|обман|не вика|какая вика|настоящ\w+ имя|имя своё|имя свое|меня зовут не)", re.I)
    hits = [(role, t, ts) for role, t, ts in msgs if pat.search(t)]
    print("  найдено: %d" % len(hits))
    for role, t, ts in hits[:25]:
        import datetime
        d = datetime.datetime.fromtimestamp(ts / 1000).strftime("%d.%m.%Y")
        print("   [%s %s] %s" % (d, "она" if role == "assistant" else "он ", t[:100]))

    # 5. любые «Маша» в переписке
    print()
    print("=" * 70)
    print("  ВСЕ УПОМИНАНИЯ «МАША» (первые 20)")
    print("=" * 70)
    mash = [(role, t, ts) for role, t, ts in msgs if re.search(r"\bмаш", t, re.I)]
    print("  всего: %d" % len(mash))
    import datetime
    for role, t, ts in mash[:20]:
        d = datetime.datetime.fromtimestamp(ts / 1000).strftime("%d.%m.%Y")
        print("   [%s %s] %s" % (d, "она" if role == "assistant" else "он ", t[:100]))


if __name__ == "__main__":
    main()
