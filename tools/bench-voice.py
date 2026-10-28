# -*- coding: utf-8 -*-
"""Замер скорости XTTS с оптимизациями: кэш латентов голоса + короткие фразы."""
import os
import sys
import time
import wave

ROOT = r"C:\Users\Эдуард\Downloads\masha-fixed"
os.environ["TTS_HOME"] = os.path.join(ROOT, ".tts-home")
os.environ["HF_HOME"] = os.path.join(ROOT, ".hf-cache")
os.environ["COQUI_TOS_AGREED"] = "1"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import numpy as np
import torch
torch.set_num_threads(2)
torch.set_num_interop_threads(1)
print("потоков torch:", torch.get_num_threads(), flush=True)

from TTS.api import TTS

t0 = time.time()
model = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
print("модель загружена за %.1f сек" % (time.time() - t0), flush=True)

ref = os.path.join(ROOT, "voice", "reference.wav")
print("считаю латент голоса (один раз)...", flush=True)
t = time.time()
gpt_cond_latent, speaker_embedding = model.synthesizer.tts_model.get_conditioning_latents(audio_path=[ref])
print("латент за %.1f сек" % (time.time() - t), flush=True)

texts = [
    "Привет",
    "И я тебя люблю очень сильно",
    "Нормально, а ты?",
    "Сладких снов, любимый. Люблю тебя очень сильно и крепко обнимаю",
]

for txt in texts:
    for speed in (1.0, 1.3):
        t = time.time()
        out = model.synthesizer.tts_model.inference(
            txt,
            "ru",
            gpt_cond_latent,
            speaker_embedding,
            temperature=0.75,
            length_penalty=1.0,
            repetition_penalty=5.0,
            top_k=50,
            top_p=0.85,
            speed=speed,
            enable_text_splitting=False,
        )
        wav = np.asarray(out["wav"], dtype=np.float32).reshape(-1)
        dur = len(wav) / 24000
        el = time.time() - t
        print("  «%s» speed=%s → %.2f сек аудио за %.1f сек (x%.1f реального времени)" % (
            txt[:40], speed, dur, el, el / max(dur, 0.01)), flush=True)

print("ГОТОВО", flush=True)
