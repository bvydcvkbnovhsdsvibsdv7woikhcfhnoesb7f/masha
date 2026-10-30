# -*- coding: utf-8 -*-
"""Собирает индекс озвученных фраз для приложения (в т.ч. для телефона).

    python tools/build-tts-index.py

Читает voice/cache/*.wav + voice/cache/map.json + список её фраз из архива,
и пишет voice/tts-index.json:
    { "нормализованная фраза": "voice/cache/<hash>.wav", ... }
"""
import gzip
import hashlib
import importlib.util
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "voice", "cache")
MAP_FILE = os.path.join(CACHE, "map.json")
ARCH = os.path.join(ROOT, "archive", "masha-archive.json.gz")
OUT = os.path.join(ROOT, "voice", "tts-index.json")
LIMIT = 2000


def norm(t):
    t = str(t or "").lower()
    t = re.sub(r"[❤💋🫶🥰😭🙄🩷💖🥲🩵🤍💔😍😘🥹🖤]", "", t)
    t = re.sub(r"[^а-яё0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def h(text):
    return hashlib.md5(norm(text).encode("utf-8")).hexdigest()


def pick_phrases():
    """Тот же список, что озвучивает pregenerate-voice.py (топ по частоте + ритуалы)."""
    spec = importlib.util.spec_from_file_location("pg", os.path.join(ROOT, "tools", "pregenerate-voice.py"))
    pg = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pg)
    return pg.pick_phrases()


def main():
    index = {}
    # 1) из map.json (самый надёжный источник)
    if os.path.exists(MAP_FILE):
        try:
            mp = json.load(open(MAP_FILE, encoding="utf-8"))
            for key, text in mp.items():
                wav = os.path.join(CACHE, key + ".wav")
                if os.path.exists(wav):
                    index[norm(text)] = "voice/cache/" + key + ".wav"
            print("из map.json: %d" % len(index))
        except Exception as e:
            print("map.json не прочитан:", e)

    # 2) добираем по списку фраз (для старых, озвученных до появления map.json)
    try:
        phrases = pick_phrases()
        added = 0
        for text in phrases:
            key = h(text)
            wav = os.path.join(CACHE, key + ".wav")
            if os.path.exists(wav) and norm(text) not in index:
                index[norm(text)] = "voice/cache/" + key + ".wav"
                added += 1
        print("добрано из списка фраз: %d" % added)
    except Exception as e:
        print("список фраз не получен:", e)

    # 3) сколько файлов без текста (озвучены вручную/иным способом)
    total_wav = len([f for f in os.listdir(CACHE) if f.endswith(".wav")])
    known = len({v for v in index.values()})
    print("всего wav: %d | с текстом: %d | без текста: %d" % (total_wav, known, total_wav - known))

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print("индекс записан: %s (%d фраз, %.0f КБ)" % (OUT, len(index), os.path.getsize(OUT) / 1024))

    # короткая проверка покрытия
    if os.path.exists(ARCH):
        rows = json.loads(gzip.open(ARCH, "rb").read().decode("utf-8"))["messages"]
        total = 0
        hit = 0
        for r in rows:
            if r[0] != "assistant":
                continue
            t = norm(r[2])
            if not t:
                continue
            total += 1
            if t in index:
                hit += 1
        print("покрытие её сообщений: %.1f%% (%d из %d)" % (100.0 * hit / max(total, 1), hit, total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
