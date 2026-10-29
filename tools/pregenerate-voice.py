#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pregenerate-voice.py — заранее озвучивает её частые фразы и кладёт в кэш.

    python tools/pregenerate-voice.py [сколько_фраз]

Почему так: на слабом CPU одна фраза синтезируется ~60 секунд. Но фразы у неё
короткие и повторяющиеся — озвучив самые частые один раз, мы получаем мгновенную
озвучку для большой доли её сообщений.

Печатает прогресс и пишет лог voice/pregenerate-log.txt
"""
import gzip
import json
import os
import re
import sys
import time
import wave

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("TTS_HOME", os.path.join(ROOT, ".tts-home"))
os.environ.setdefault("HF_HOME", os.path.join(ROOT, ".hf-cache"))
os.environ.setdefault("COQUI_TOS_AGREED", "1")

CACHE_DIR = os.path.join(ROOT, "voice", "cache")
REFERENCE_WAV = os.path.join(ROOT, "voice", "reference.wav")
LOG = os.path.join(ROOT, "voice", "pregenerate-log.txt")
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 40
CHUNK = int(sys.argv[2]) if len(sys.argv) > 2 else 0   # сколько фраз сделать за этот запуск (0 = все)
MIN_FREE_MB = 350        # минимум ФИЗИЧЕСКОЙ памяти
MIN_VIRTUAL_MB = 2200    # минимум свободной виртуальной (файл подкачки)

SPAM = re.compile(r"https?://|t\.me/|@[a-z0-9_]{4,}|кому-то понравилась|вам пришло", re.I)
# служебные подписи в архиве — озвучивать не нужно
PLACEHOLDERS = {"стикер", "фото", "видео", "голосовое", "гс", "стикеры", "фотография",
                "файл", "документ", "аудио", "кружок", "пересланное сообщение",
                "ответ", "реплай", "ссылка", "изображение", "видеосообщение"}


def log(msg):
    print(msg, flush=True)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


def normalize(text):
    t = str(text or "").lower()
    t = re.sub(r"[❤💋🫶🥰😭🙄🩷💖🥲🩵🤍💔😍😘🥹🖤]", "", t)
    t = re.sub(r"[^а-яё0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def cache_path(text):
    import hashlib
    key = hashlib.md5(normalize(text).encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, key + ".wav")


def pick_phrases():
    """Берёт её самые частые короткие сообщения из архива + её ритуалы."""
    path = os.path.join(ROOT, "archive", "masha-archive.json.gz")
    counts = {}
    if os.path.exists(path):
        rows = json.loads(gzip.open(path, "rb").read().decode("utf-8"))["messages"]
        for r in rows:
            if r[0] != "assistant":
                continue
            t = re.sub(r"\s+", " ", str(r[2] or "")).strip()
            if not t or len(t) > 45 or len(t.split()) < 1:
                continue
            if SPAM.search(t) or t.startswith("[") or normalize(t) in PLACEHOLDERS:
                continue
            key = normalize(t)
            if not key:
                continue
            if key not in counts:
                counts[key] = {"text": t, "n": 0}
            counts[key]["n"] += 1
    rituals = [
        "Доброе утро",
        "Сладких снов, любимый. Люблю тебя очень сильно и крепко обнимаю",
        "И я тебя люблю очень сильно",
        "Пока, целую",
        "Нормально, а ты?",
        "Ты кушал?",
        "Скучаю очень сильно",
        "Обнимаю тебя крепко",
    ]
    out = []
    seen = set()
    for r in rituals:
        k = normalize(r)
        if k and k not in seen:
            seen.add(k)
            out.append(r)
    top = sorted(counts.values(), key=lambda x: -x["n"])
    for item in top:
        k = normalize(item["text"])
        if k in seen:
            continue
        seen.add(k)
        out.append(item["text"])
        if len(out) >= LIMIT:
            break
    return out[:LIMIT]


def free_mb():
    try:
        import ctypes
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        st = MEMORYSTATUSEX()
        st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
        return (st.ullAvailPhys // (1024 * 1024), st.ullAvailVirtual // (1024 * 1024))
    except Exception:
        return (4096, 8192)


def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    avail, virt = free_mb()
    log("память: физической свободно %d МБ, виртуальной %d МБ" % (avail, virt))
    if avail < MIN_FREE_MB and virt < MIN_VIRTUAL_MB:
        log("МАЛО ПАМЯТИ (физической %d МБ, виртуальной %d МБ). Закрой программы и запусти снова."
            % (avail, virt))
        return 3
    if avail < 900:
        log("физической памяти мало (%d МБ) — модель будет частично в файле подкачки, "
            "загрузка и озвучка пойдут МЕДЛЕННЕЕ, но работать будет." % avail)
    open(LOG, "w", encoding="utf-8").close()
    log("=== заранее озвучиваю её частые фразы ===")
    phrases = pick_phrases()
    log("фраз к озвучке: %d" % len(phrases))

    import numpy as np
    import torch
    try:
        torch.set_num_threads(max(1, os.cpu_count() or 1))
    except Exception:
        pass
    from TTS.api import TTS

    t0 = time.time()
    log("загружаю модель...")
    model = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
    log("модель загружена за %.0f сек" % (time.time() - t0))

    if not os.path.exists(REFERENCE_WAV):
        log("нет reference.wav — сначала запусти check-voice.py")
        return 1

    log("считаю латент голоса...")
    latent, embedding = model.synthesizer.tts_model.get_conditioning_latents(audio_path=[REFERENCE_WAV])
    log("латент готов")

    done = 0
    skipped = 0
    made_now = 0
    for i, text in enumerate(phrases, 1):
        p = cache_path(text)
        if os.path.exists(p):
            skipped += 1
            log("[%d/%d] уже есть: «%s»" % (i, len(phrases), text[:50]))
            continue
        t = time.time()
        try:
            out = model.synthesizer.tts_model.inference(
                text, "ru", latent, embedding,
                temperature=0.75, length_penalty=1.0, repetition_penalty=5.0,
                top_k=50, top_p=0.85, speed=1.0, enable_text_splitting=False,
            )
        except Exception as e:
            log("[%d/%d] ОШИБКА «%s»: %s" % (i, len(phrases), text[:40], e))
            continue
        arr = np.asarray(out["wav"], dtype=np.float32).reshape(-1)
        pcm = (np.clip(arr, -1, 1) * 32767).astype(np.int16).tobytes()
        buf = os.path.join(CACHE_DIR, os.path.basename(p) + ".tmp")
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(pcm)
        os.replace(buf, p)
        done += 1
        el = time.time() - t
        left = len(phrases) - i
        log("[%d/%d] «%s» → %.1f сек аудио за %.0f сек | осталось ~%.0f мин" % (
            i, len(phrases), text[:50], len(arr) / 24000, el, left * el / 60))
        made_now += 1
        if CHUNK and made_now >= CHUNK:
            log("сделал порцию из %d фраз, останавливаюсь (запусти снова для продолжения)" % CHUNK)
            break

    log("=== готово: новых %d, уже было %d, всего в кэше %d ===" % (
        done, skipped, len([f for f in os.listdir(CACHE_DIR) if f.endswith(".wav")])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
