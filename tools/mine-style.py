#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
mine-style.py — вытащить из архива её реальные фразы, темы и факты.

    python tools/mine-style.py
    python tools/mine-style.py --archive archive/masha-archive.json.gz --out tools/style-dossier.txt

Читает готовый архив (archive/masha-archive.json.gz) — те самые 265 080 сообщений —
и складывает в tools/style-dossier.txt:
  • самые частые её короткие сообщения (её настоящая «рубилка»);
  • характерные фразы по темам (семья, кот, школа, тренировки, еда, сон, чувства);
  • её ритуалы (спокойной ночи / доброе утро) — все варианты;
  • частые двусловные и трёхсловные обороты;
  • статистику стиля: длина, знаки, эмодзи, время суток.
"""
import argparse
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
MSK = timezone(timedelta(hours=7))          # Красноярск

EMOJI_RE = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u2764]")
TOPICS = {
    "семья": r"\b(мама|мам[уеы]|мать|отчим|пап[аеуы]|папа|бабушк\w*|брат\w*|малой|мал(ый|ого)|сестр\w*)\b",
    "кот": r"\b(кот\w*|кошк\w*|коть|мурч\w*)\b",
    "школа": r"\b(школ\w*|урок\w*|контрольн\w*|физик\w*|биолог\w*|учител\w*|домашк\w*|дз)\b",
    "тренировки": r"\b(тренировк\w*|танц\w*|похудел\w*|похудет\w*|вес|фигур\w*|качал\w*)\b",
    "еда": r"\b(сырник\w*|банан\w*|кофе|куша\w*|покуша\w*|кушать|есть хочу|кушать хочу|приятного аппетита|еда)\b",
    "сон": r"\b(спать|сплю|спит|сон|спать хочу|выспал\w*|ложусь|лягу|уснул\w*)\b",
    "чувства": r"\b(люблю|скучаю|скучно|ревн\w*|обидел\w*|обидн\w*|игнор\w*|целую|обнимаю|скучаешь)\b",
    "голова": r"\b(голов\w*|болит|тошн\w*|панич\w*|устал\w*|устала)\b",
    "музыка": r"\b(песн\w*|музык\w*|трек|слушаю|заела)\b",
    "мечты": r"\b(квадроцикл\w*|лошад\w*|речк\w*|мечт\w*|хочу поехать)\b",
}


def read_archive(path):
    if not os.path.exists(path):
        raise SystemExit("нет файла архива: " + path)
    raw = gzip.open(path, "rb").read() if path.endswith(".gz") else open(path, "rb").read()
    data = json.loads(raw.decode("utf-8"))
    return data.get("messages") or []


def norm(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", default=os.path.join(ROOT, "archive", "masha-archive.json.gz"))
    ap.add_argument("--out", default=os.path.join(HERE, "style-dossier.txt"))
    ap.add_argument("--top", type=int, default=60)
    args = ap.parse_args()

    rows = read_archive(args.archive)
    her, his = [], []
    for r in rows:
        role, ts, content = r[0], r[1], r[2]
        text = norm(content)
        if not text or text.startswith("["):
            continue
        (her if role == "assistant" else his).append((ts, text))

    out = []
    w = out.append

    def head(title):
        w("")
        w("=" * 72)
        w("  " + title)
        w("=" * 72)

    w("РАЗБОР АРХИВА ПЕРЕПИСКИ — её реальная речь")
    w("Всего сообщений: %d (она: %d, он: %d)" % (len(rows), len(her), len(his)))

    # ---- статистика стиля
    lens = [len(t.split()) for _, t in her]
    lens.sort()
    total = len(lens) or 1
    def pct(n):
        return 100.0 * n / total
    no_punct = sum(1 for _, t in her if not re.search(r"[.!?;:]$", t))
    with_emoji = sum(1 for _, t in her if EMOJI_RE.search(t))
    lower_first = sum(1 for _, t in her if t[:1].islower())
    head("СТИЛЬ В ЦИФРАХ")
    w("медиана слов: %d, среднее: %.2f" % (lens[len(lens) // 2] if lens else 0, sum(lens) / total))
    w("1 слово: %.0f%%   2 слова: %.0f%%   <=3 слов: %.0f%%   >=10 слов: %.1f%%   >=15 слов: %.1f%%" % (
        pct(sum(1 for x in lens if x == 1)), pct(sum(1 for x in lens if x == 2)),
        pct(sum(1 for x in lens if x <= 3)), pct(sum(1 for x in lens if x >= 10)),
        pct(sum(1 for x in lens if x >= 15))))
    w("без точки/знака в конце: %.0f%%" % pct(no_punct))
    w("с эмодзи: %.0f%% (примерно 1 из %.0f сообщений)" % (pct(with_emoji), total / max(1, with_emoji)))
    w("начинается со строчной буквы: %.0f%%" % pct(lower_first))
    emo = collections.Counter(c for _, t in her for c in EMOJI_RE.findall(t))
    w("эмодзи по частоте: " + ", ".join("%s %d" % (e, n) for e, n in emo.most_common(12)))

    # ---- часы
    hours = collections.Counter()
    for ts, _ in her:
        try:
            hours[datetime.fromtimestamp(ts / 1000, MSK).hour] += 1
        except Exception:
            pass
    head("КОГДА ОНА ПИШЕТ (час по Красноярску)")
    w("  ".join("%02d:%.0f%%" % (h, 100.0 * hours.get(h, 0) / total) for h in range(24)))
    peak = sorted(hours.items(), key=lambda kv: -kv[1])[:4]
    w("пиковые часы: " + ", ".join("%02d:00 (%d)" % (h, n) for h, n in peak))

    # ---- короткие реплики
    head("ЕЁ САМЫЕ ЧАСТЫЕ КОРОТКИЕ СООБЩЕНИЯ (это её живая речь)")
    short = collections.Counter(t.lower() for _, t in her if len(t.split()) <= 3 and len(t) <= 30)
    for text, n in short.most_common(args.top):
        w("  %5d  %s" % (n, text))

    # ---- фразы по темам
    head("ЕЁ ФРАЗЫ ПО ТЕМАМ (реальные цитаты)")
    for topic, rx in TOPICS.items():
        pat = re.compile(rx, re.I)
        bucket = collections.Counter(t for _, t in her if 2 <= len(t.split()) <= 9 and pat.search(t))
        w("")
        w("--- %s ---" % topic)
        for text, n in bucket.most_common(18):
            w("  %4d  %s" % (n, text))

    # ---- ритуалы
    head("РИТУАЛЫ (все варианты её формулировок)")
    for label, rx in [
        ("спокойной ночи", r"сладких снов|спокойной ночи|сладко спать"),
        ("доброе утро", r"доброе утро|с добрым утром"),
        ("люблю тебя", r"люблю тебя|люблю очень|очень сильно|крепко обнимаю|целую"),
        ("как дела у него", r"ты кушал|ты покушал|как дела|как ты там|что делаешь"),
    ]:
        pat = re.compile(rx, re.I)
        bucket = collections.Counter(t for _, t in her if pat.search(t))
        w("")
        w("--- %s ---" % label)
        for text, n in bucket.most_common(14):
            w("  %4d  %s" % (n, text))

    # ---- обороты
    head("ЧАСТЫЕ ОБОРОТЫ (2 слова / 3 слова)")
    def ngrams(lst, n):
        c = collections.Counter()
        for _, t in lst:
            words = re.findall(r"[а-яёa-z]+", t.lower())
            for i in range(len(words) - n + 1):
                c[" ".join(words[i:i + n])] += 1
        return c
    stop = set("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это оно ах ох ух эх".split())
    for n, limit in ((2, 45), (3, 30)):
        c = ngrams(her, n)
        items = [(k, v) for k, v in c.items() if v >= 8 and not all(x in stop for x in k.split())]
        items.sort(key=lambda kv: -kv[1])
        w("")
        w("--- %d слова ---" % n)
        w("  " + "; ".join("%s (%d)" % (k, v) for k, v in items[:limit]))

    # ---- примеры её рассказов (несколько сообщений подряд)
    head("КАК ОНА РАССКАЗЫВАЕТ ИСТОРИИ (её сообщения подряд, реальные)")
    shown = 0
    i = 0
    seq = [t for _, t in her]
    while i < len(seq) - 3 and shown < 12:
        chunk = seq[i:i + 3]
        if all(3 <= len(x.split()) <= 12 for x in chunk) and sum(len(x) for x in chunk) > 45:
            w("  • " + " / ".join(chunk))
            shown += 1
            i += 5
        else:
            i += 1

    text_out = "\n".join(out) + "\n"
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(text_out)
    print("Готово: " + args.out)
    print("Её сообщений разобрано: %d, его: %d" % (len(her), len(his)))


if __name__ == "__main__":
    main()
