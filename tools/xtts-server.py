#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
xtts-server.py — сервер её голоса (XTTS v2) с кэшем. Без FastAPI — обычный
многопоточный HTTP из стандартной библиотеки: с torch работает надёжнее.

    python tools/xtts-server.py

  * модель и латент голоса считаются ОДИН раз при старте (~3 минуты);
  * кэш voice/cache/<md5>.wav — повторная фраза играет мгновенно;
  * если синтез уже идёт, второй запрос сразу получает 503 busy
    (приложение просто пропустит озвучку, а не зависнет);
  * GET / — статус: ready, cache, hits, requests, busy.
"""
import hashlib
import io
import json
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORT = int(os.environ.get("XTTS_PORT", "8788"))

os.environ.setdefault("TTS_HOME", os.path.join(ROOT, ".tts-home"))
os.environ.setdefault("HF_HOME", os.path.join(ROOT, ".hf-cache"))
os.environ.setdefault("COQUI_TOS_AGREED", "1")
try:
    os.makedirs(os.environ["TTS_HOME"], exist_ok=True)
except Exception:
    pass

CACHE_DIR = os.path.join(ROOT, "voice", "cache")
REFERENCE_WAV = os.path.join(ROOT, "voice", "reference.wav")
MAX_TTS_CHARS = 400
CANDIDATE_DIRS = [
    os.environ.get("XTTS_VOICE_DIR", ""),
    os.path.join(ROOT, "voice", "клонирование"),
    os.path.join(ROOT, "voice", "clips"),
]

STATE = {
    "model": None, "latent": None, "embedding": None,
    "ready": False, "loading": True, "error": "",
    "requests": 0, "cache_hits": 0,
}
LOCK = threading.Lock()
BUSY = threading.Event()


def log(msg):
    print("[xtts] %s" % msg, flush=True)


def normalize(text):
    t = str(text or "").lower()
    t = re.sub(r"[❤💋🫶🥰😭🙄🩷💖🥲🩵🤍💔😍😘🥹🖤]", "", t)
    t = re.sub(r"[^а-яё0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def cache_path(text):
    return os.path.join(CACHE_DIR, hashlib.md5(normalize(text).encode("utf-8")).hexdigest() + ".wav")


def count_cache():
    try:
        return len([f for f in os.listdir(CACHE_DIR) if f.endswith(".wav")])
    except Exception:
        return 0


def find_reference():
    if os.path.exists(REFERENCE_WAV):
        return REFERENCE_WAV
    files = []
    for d in CANDIDATE_DIRS:
        if d and os.path.isdir(d):
            for f in sorted(os.listdir(d)):
                low = f.lower()
                if low.endswith((".wav", ".ogg", ".mp3", ".m4a", ".flac")) and not low.startswith(("reference", "все")):
                    files.append(os.path.join(d, f))
    return files[0] if files else None


def load_everything():
    try:
        import torch
        try:
            torch.set_num_threads(max(1, os.cpu_count() or 1))
        except Exception:
            pass
        from TTS.api import TTS
        log("загружаю модель (1-3 минуты, один раз)...")
        t0 = time.time()
        model = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        log("модель загружена за %.0f сек" % (time.time() - t0))
        ref = find_reference()
        if not ref:
            raise RuntimeError("нет образца голоса: положи её голосовые в voice/клонирование")
        log("считаю латент голоса...")
        t0 = time.time()
        latent, embedding = model.synthesizer.tts_model.get_conditioning_latents(audio_path=[ref])
        log("латент готов за %.0f сек" % (time.time() - t0))
        STATE.update({"model": model, "latent": latent, "embedding": embedding, "ready": True, "loading": False})
        log("ГОТОВ: http://127.0.0.1:%d | фраз в кэше: %d" % (PORT, count_cache()))
    except Exception as e:
        STATE["error"] = str(e)
        STATE["loading"] = False
        log("ОШИБКА загрузки: %s" % e)


def wav_bytes(arr, rate=24000):
    import numpy as np
    a = np.clip(np.asarray(arr, dtype=np.float32).reshape(-1), -1.0, 1.0)
    pcm = (a * 32767.0).astype(np.int16).tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def synthesize(text, speed=1.0):
    """Возвращает (wav_bytes|None, from_cache, error|None)."""
    p = cache_path(text)
    if os.path.exists(p):
        STATE["cache_hits"] += 1
        try:
            with open(p, "rb") as f:
                return f.read(), True, None
        except Exception:
            pass
    if not STATE["ready"]:
        return None, False, "модель ещё загружается" if STATE["loading"] else ("ошибка: " + (STATE["error"] or "не готова"))
    if not LOCK.acquire(blocking=False):
        return None, False, "busy"
    BUSY.set()
    try:
        model = STATE["model"]
        out = model.synthesizer.tts_model.inference(
            str(text)[:MAX_TTS_CHARS],
            "ru",
            STATE["latent"],
            STATE["embedding"],
            temperature=0.75,
            length_penalty=1.0,
            repetition_penalty=5.0,
            top_k=50,
            top_p=0.85,
            speed=speed,
            enable_text_splitting=False,
        )
        data = wav_bytes(out["wav"])
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            tmp = p + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, p)
        except Exception as e:
            log("не смог сохранить в кэш: %s" % e)
        return data, False, None
    except Exception as e:
        return None, False, str(e)
    finally:
        BUSY.clear()
        LOCK.release()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, data, ctype="application/json; charset=utf-8", extra=None):
        body = data if isinstance(data, (bytes, bytearray)) else json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        self._send(200, {
            "ok": True, "service": "masha-xtts", "ready": STATE["ready"],
            "loading": STATE["loading"], "error": STATE["error"],
            "cache": count_cache(), "cache_hits": STATE["cache_hits"],
            "requests": STATE["requests"], "busy": BUSY.is_set(), "port": PORT,
        })

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8", "replace") if length else ""
            body = json.loads(raw) if raw.strip() else {}
        except Exception:
            self._send(400, {"ok": False, "error": "bad_json"})
            return
        text = str(body.get("text") or "").strip()[:MAX_TTS_CHARS]
        if not text:
            self._send(400, {"ok": False, "error": "no_text"})
            return
        try:
            speed = float(body.get("speed") or 1.0)
        except Exception:
            speed = 1.0
        STATE["requests"] += 1
        t0 = time.time()
        data, from_cache, err = synthesize(text, speed)
        if err:
            self._send(503 if err == "busy" else 500, {"ok": False, "error": err})
            return
        log("«%s» -> %.1f сек%s" % (text[:45], time.time() - t0, " (кэш)" if from_cache else ""))
        self._send(200, data, ctype="audio/wav", extra={"X-Cache": "hit" if from_cache else "miss"})


def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    threading.Thread(target=load_everything, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    log("сервер поднят на http://127.0.0.1:%d (модель грузится в фоне)" % PORT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("остановлен")


if __name__ == "__main__":
    main()
