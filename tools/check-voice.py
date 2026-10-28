# -*- coding: utf-8 -*-
"""Проверка XTTS и первый синтез её голосом."""
import os
import sys
import time

ROOT = r"C:\Users\Эдуард\Downloads\masha-fixed"
os.environ["TTS_HOME"] = os.path.join(ROOT, ".tts-home")
os.environ["HF_HOME"] = os.path.join(ROOT, ".hf-cache")
os.environ["COQUI_TOS_AGREED"] = "1"
os.environ["USE_TORCH"] = "1"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

t0 = time.time()
print("[1] импорт torch...", flush=True)
import torch
print("    torch", torch.__version__, flush=True)

print("[2] импорт transformers...", flush=True)
import transformers
print("    transformers", transformers.__version__, flush=True)

print("[3] импорт XTTS...", flush=True)
from TTS.api import TTS
print("    TTS.api OK", flush=True)

print("[4] загружаю модель (может занять 1-2 мин)...", flush=True)
t = time.time()
model = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
print("    модель загружена за %.1f сек" % (time.time() - t), flush=True)

print("[5] собираю образец её голоса из 8 фрагментов...", flush=True)
import numpy as np
import librosa
import soundfile as sf

src = os.path.join(ROOT, "voice", "клонирование")
ref = os.path.join(ROOT, "voice", "reference.wav")
clips = sorted(f for f in os.listdir(src) if f.lower().endswith(".ogg") and not f.startswith("все"))
chunks = []
for f in clips:
    y, sr = librosa.load(os.path.join(src, f), sr=24000, mono=True)
    if y is None or len(y) == 0:
        continue
    chunks.append(y)
    print("    + %s (%.1f сек)" % (f, len(y) / sr), flush=True)
audio = np.concatenate(chunks)
sf.write(ref, audio, 24000)
print("    образец: %.1f сек -> %s" % (len(audio) / 24000, ref), flush=True)

print("[6] синтез её голосом...", flush=True)
t = time.time()
out = model.tts(
    text="Привет. Я тебя очень сильно люблю и крепко обнимаю.",
    speaker_wav=ref,
    language="ru",
    split_sentences=True,
)
print("    синтез за %.1f сек" % (time.time() - t), flush=True)

arr = np.asarray(out, dtype=np.float32).reshape(-1)
rms = float(np.sqrt(np.mean(arr ** 2)))
peak = float(np.max(np.abs(arr)))
print("    длина %.2f сек | пик %.3f | RMS %.4f" % (len(arr) / 24000, peak, rms), flush=True)

import wave
dst = r"C:\Users\Эдуард\Downloads\тест-голос-Маши.wav"
pcm = (np.clip(arr, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
with wave.open(dst, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(24000)
    w.writeframes(pcm)
print("[7] сохранено: %s (%.0f КБ)" % (dst, os.path.getsize(dst) / 1024), flush=True)
print("ВСЁ ГОТОВО за %.1f сек" % (time.time() - t0), flush=True)
