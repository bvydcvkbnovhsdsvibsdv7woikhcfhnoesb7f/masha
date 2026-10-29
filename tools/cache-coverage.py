# -*- coding: utf-8 -*-
"""Сколько её реальных сообщений покроет кэш из N самых частых фраз."""
import gzip
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = r"C:\Users\Эдуард\Downloads\masha-fixed"
ARCH = os.path.join(ROOT, "archive", "masha-archive.json.gz")
SPAM = re.compile(r"https?://|t\.me/|@[a-z0-9_]{4,}", re.I)


def norm(t):
    t = str(t or "").lower()
    t = re.sub(r"[❤💋🫶🥰😭🙄🩷💖🥲🩵🤍💔😍😘🥹🖤]", "", t)
    t = re.sub(r"[^а-яё0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


rows = json.loads(gzip.open(ARCH, "rb").read().decode("utf-8"))["messages"]
counts = {}
total = 0
for r in rows:
    if r[0] != "assistant":
        continue
    t = re.sub(r"\s+", " ", str(r[2] or "")).strip()
    if not t or SPAM.search(t):
        continue
    k = norm(t)
    if not k:
        continue
    total += 1
    counts[k] = counts.get(k, 0) + 1

print("всего её сообщений (пригодных для кэша): %d" % total)
print("уникальных фраз: %d" % len(counts))
print()
ordered = sorted(counts.items(), key=lambda x: -x[1])
run = 0
marks = [10, 25, 50, 100, 200, 300, 500, 800, 1200, 2000]
print("покрытие по количеству озвученных фраз:")
for i, (k, n) in enumerate(ordered, 1):
    run += n
    if i in marks:
        print("  %5d фраз → %5.1f%% её сообщений" % (i, 100.0 * run / total))
print()
print("примеры топ-40 фраз (что попадёт в кэш):")
for i, (k, n) in enumerate(ordered[:40], 1):
    print("  %2d. %-45s (встречается %d раз)" % (i, k[:45], n))

# сколько символов нужно озвучить для N фраз
for n in (100, 200, 300):
    chars = sum(len(k) for k, _ in ordered[:n])
    secs = chars / 12.0  # примерно 12 символов в секунду речи
    print("\nпервые %d фраз: %d символов ≈ %.0f минут аудио" % (n, chars, secs / 60))
