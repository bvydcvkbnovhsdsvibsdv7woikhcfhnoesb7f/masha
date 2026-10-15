#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
analyze-pairs.py — глубокий разбор: что она отвечает НА КОНКРЕТНЫЕ СИТУАЦИИ.

    python tools/analyze-pairs.py

Читает archive/masha-archive.json.gz и пишет tools/pairs-report.txt:
  • таблицы «он написал X → она ответила Y» (реальные ответы с частотами);
  • как часто она пишет 1, 2, 3+ сообщения подряд (её «серии»);
  • с каких слов начинаются её сообщения;
  • как часто она задаёт вопросы;
  • эмодзи по типам сообщений.
"""
import argparse
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

# ситуация -> по каким словам его сообщения её искать
TRIGGERS = [
    ("он признаётся в любви", r"\b(люблю тебя|люблю|люблю тебя очень|ты моя)\b"),
    ("он скучает", r"\b(скучаю|скучно без тебя|соскучился)\b"),
    ("он просит прощения", r"\b(прости|извини|прошу прощения|извиняюсь)\b"),
    ("он говорит про сон", r"\b(спать|ложусь|спокойной ночи|сладких снов|я устал)\b"),
    ("он про еду", r"\b(кушал|покушал|поел|кушать|приятного аппетита)\b"),
    ("он спрашивает как дела", r"\b(как дела|как ты|как оно|что делаешь)\b"),
    ("он комплимент", r"\b(красив|умниц|хорошая|лучшая|любимая|милая)\b"),
    ("он занят работой/учёбой", r"\b(работа|учусь|пары|колледж|экзамен|зачёт)\b"),
    ("он грустит/плохо", r"\b(грустно|плохо|тяжело|депресс|устал)\b"),
    ("он ревнует/злится", r"\b(ревную|ревность|бесит|злюсь|психанул)\b"),
    ("он о ней (забота)", r"\b(поешь|отдохни|ложись|укутайся|не болей|поправляйся)\b"),
    ("он пишет просто привет", r"^(привет|прив|хай|здравствуй|доброе утро|добрый день)"),
    ("он спрашивает где она", r"\b(ты где|где ты|ты тут|ты здесь)\b"),
    ("он шутит/подкалывает", r"\b(хаха|ахах|шучу|лол|ор)\b"),
    ("он говорит про секс/постель", r"\b(трахн|секс|постел|целовать|обнимать|ласкать)\b"),
]


def read(path):
    raw = gzip.open(path, "rb").read() if path.endswith(".gz") else open(path, "rb").read()
    return json.loads(raw.decode("utf-8")).get("messages") or []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", default=os.path.join(ROOT, "archive", "masha-archive.json.gz"))
    ap.add_argument("--out", default=os.path.join(HERE, "pairs-report.txt"))
    args = ap.parse_args()

    rows = read(args.archive)
    seq = []
    for r in rows:
        text = re.sub(r"\s+", " ", str(r[2] or "")).strip()
        if not text or text.startswith("["):
            continue
        seq.append((r[0], text))

    out = []
    w = out.append

    def head(t):
        w("")
        w("=" * 74)
        w("  " + t)
        w("=" * 74)

    her = [t for role, t in seq if role == "assistant"]
    w("ГЛУБОКИЙ РАЗБОР ДИАЛОГОВ — %d сообщений (она: %d)" % (len(seq), len(her)))

    # ---------- 1. Серии сообщений ----------
    head("ЕЁ СЕРИИ: сколько сообщений она пишет подряд")
    runs = []
    i = 0
    while i < len(seq):
        if seq[i][0] == "assistant":
            j = i
            while j < len(seq) and seq[j][0] == "assistant":
                j += 1
            runs.append(j - i)
            i = j
        else:
            i += 1
    cnt = collections.Counter(runs)
    total_runs = len(runs) or 1
    for k in range(1, 7):
        w("  %d сообщ. подряд: %5d серий (%.0f%%)" % (k, cnt.get(k, 0), 100.0 * cnt.get(k, 0) / total_runs))
    w("  7 и больше:       %5d серий (%.0f%%)" % (sum(v for k, v in cnt.items() if k >= 7),
                                                  100.0 * sum(v for k, v in cnt.items() if k >= 7) / total_runs))
    w("  средняя серия: %.2f сообщения" % (sum(runs) / total_runs))
    w("  ВЫВОД: %.0f%% её серий — это 1 сообщение, %.0f%% — 2 и больше." % (
        100.0 * cnt.get(1, 0) / total_runs, 100.0 * sum(v for k, v in cnt.items() if k >= 2) / total_runs))

    # ---------- 2. Первое слово ----------
    head("С КАКИХ СЛОВ ОНА НАЧИНАЕТ")
    first = collections.Counter(t.split()[0].lower().strip(",.:;!?()") for t in her if t.split())
    for word, n in first.most_common(25):
        w("  %6d  %s" % (n, word))

    # ---------- 3. Вопросы ----------
    head("ВОПРОСЫ")
    q = [t for t in her if t.rstrip().endswith("?")]
    w("  сообщений с вопросом в конце: %d (%.0f%%)" % (len(q), 100.0 * len(q) / len(her)))
    qs = collections.Counter(t.lower() for t in q if len(t.split()) <= 5)
    for text, n in qs.most_common(25):
        w("  %5d  %s" % (n, text))

    # ---------- 4. Эмодзи по типам ----------
    head("ЭМОДЗИ")
    emo = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27BF\u2764\uFE0F]")
    with_emoji = [t for t in her if emo.search(t)]
    w("  с эмодзи: %d (%.1f%%)" % (len(with_emoji), 100.0 * len(with_emoji) / len(her)))
    w("  самые частые сообщения с эмодзи:")
    for text, n in collections.Counter(t for t in with_emoji if len(t.split()) <= 12).most_common(15):
        w("  %5d  %s" % (n, text))

    # ---------- 5. Таблицы «ситуация -> её ответ» ----------
    head("ЧТО ОНА ОТВЕЧАЕТ НА КОНКРЕТНЫЕ СИТУАЦИИ (реальные ответы с частотами)")
    for label, rx in TRIGGERS:
        pat = re.compile(rx, re.I)
        answers = collections.Counter()
        for idx in range(len(seq) - 1):
            role, text = seq[idx]
            if role != "user" or not pat.search(text):
                continue
            # её следующие 1-3 сообщения подряд
            k = idx + 1
            got = 0
            while k < len(seq) and seq[k][0] == "assistant" and got < 3:
                answers[seq[k][1]] += 1
                got += 1
                k += 1
        w("")
        w("--- %s ---" % label)
        if not answers:
            w("   (нет совпадений)")
            continue
        for text, n in answers.most_common(14):
            w("  %5d  %s" % (n, text[:90]))

    with open(args.out, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print("Готово: " + args.out)


if __name__ == "__main__":
    main()
