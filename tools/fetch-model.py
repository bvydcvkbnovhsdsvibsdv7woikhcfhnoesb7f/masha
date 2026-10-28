#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fetch-model.py — надёжное параллельное скачивание модели XTTS v2.

Особенности:
  * каждый кусок пишется в отдельный файл .chunks/<файл>.<номер>.part;
  * прогресс в .chunks/state.json — можно прервать и продолжить;
  * каждый кусок повторяется до 5 раз с таймаутом 60 с;
  * в конце куски склеиваются в итоговый файл с проверкой размера.

    python tools/fetch-model.py
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TTS_HOME = os.environ.get("TTS_HOME") or os.path.join(ROOT, ".tts-home")
DEST = os.path.join(TTS_HOME, "tts_models--multilingual--multi-dataset--xtts_v2")
CHUNK_DIR = os.path.join(DEST, ".chunks")
STATE_FILE = os.path.join(CHUNK_DIR, "state.json")
REPO = "tts-hub/XTTS-v2"
THREADS = 8
CHUNK = 8 * 1024 * 1024
RETRIES = 5
TIMEOUT = 60

os.makedirs(DEST, exist_ok=True)
os.makedirs(CHUNK_DIR, exist_ok=True)


def log(msg):
    print(msg, flush=True)


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            return json.load(open(STATE_FILE, encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_state(state):
    try:
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, STATE_FILE)
    except Exception:
        pass


def api_files():
    url = "https://huggingface.co/api/models/%s?blobs=true" % REPO
    with urllib.request.urlopen(url, timeout=40) as r:
        data = json.loads(r.read().decode("utf-8"))
    out = []
    for s in data.get("siblings", []):
        name = s.get("rfilename", "")
        if not name or name.startswith("samples/") or name == "dvae.pth" or name.startswith("."):
            continue
        out.append((name, int(s.get("size") or 0)))
    return out


def file_url(name):
    return "https://huggingface.co/%s/resolve/main/%s" % (REPO, urllib.parse.quote(name))


def fetch_range(url, start, end, path):
    req = urllib.request.Request(url, headers={"Range": "bytes=%d-%d" % (start, end)})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = r.read()
    expect = end - start + 1
    if len(data) != expect:
        raise RuntimeError("кусок %d-%d: получено %d из %d байт" % (start, end, len(data), expect))
    with open(path, "wb") as f:
        f.write(data)


def download_small(name, size):
    dst = os.path.join(DEST, name.replace("/", os.sep))
    os.makedirs(os.path.dirname(dst) or DEST, exist_ok=True)
    if os.path.exists(dst) and os.path.getsize(dst) == size and size > 0:
        log("  уже есть: %s (%.2f МБ)" % (name, size / 1048576))
        return
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            with urllib.request.urlopen(file_url(name), timeout=TIMEOUT) as r:
                data = r.read()
            with open(dst, "wb") as f:
                f.write(data)
            log("  скачан: %s (%.2f МБ)" % (name, os.path.getsize(dst) / 1048576))
            return
        except Exception as e:
            last = e
            log("  повтор %d/%d для %s: %s" % (attempt, RETRIES, name, e))
            time.sleep(1 + attempt)
    raise RuntimeError("не смог скачать %s: %s" % (name, last))


def download_big(name, size):
    """Качает большим файлом по кускам; состояние в state.json."""
    state = load_state()
    key = name
    done = set(state.get(key, {}).get("done", []))
    total_chunks = (size + CHUNK - 1) // CHUNK
    if len(done) == total_chunks and os.path.exists(os.path.join(DEST, name)) and os.path.getsize(os.path.join(DEST, name)) == size:
        log("  уже готов: %s (%.1f МБ)" % (name, size / 1048576))
        return

    log("  %s: %.1f МБ, кусков %d (готово %d), потоков %d" % (name, size / 1048576, total_chunks, len(done), THREADS))
    t0 = time.time()
    have = {"bytes": sum(min(CHUNK, size - i * CHUNK) for i in done)}
    lock_state = {"done": sorted(done)}

    todo = [i for i in range(total_chunks) if i not in done]

    def work(idx):
        start = idx * CHUNK
        end = min(start + CHUNK - 1, size - 1)
        part = os.path.join(CHUNK_DIR, "%s.%05d.part" % (name.replace("/", "_"), idx))
        if os.path.exists(part) and os.path.getsize(part) == end - start + 1:
            return idx
        last = None
        for attempt in range(1, RETRIES + 1):
            try:
                fetch_range(file_url(name), start, end, part)
                return idx
            except Exception as e:
                last = e
                time.sleep(0.5 * attempt)
        raise RuntimeError("кусок %d не скачался: %s" % (idx, last))

    with ThreadPoolExecutor(max_workers=THREADS) as ex:
        futs = {ex.submit(work, i): i for i in todo}
        for fu in as_completed(futs):
            idx = fu.result()
            lock_state["done"].append(idx)
            lock_state["done"] = sorted(set(lock_state["done"]))
            state[key] = {"done": lock_state["done"]}
            save_state(state)
            have["bytes"] += min(CHUNK, size - idx * CHUNK)
            el = max(time.time() - t0, 0.1)
            log("    %5.1f%% | %.0f МБ | %.2f МБ/с" % (
                100.0 * have["bytes"] / size, have["bytes"] / 1048576,
                (have["bytes"] - sum(min(CHUNK, size - i * CHUNK) for i in done)) / el / 1048576))

    # склейка
    target = os.path.join(DEST, name)
    log("  склеиваю %s из кусков…" % name)
    with open(target, "wb") as out:
        for idx in range(total_chunks):
            part = os.path.join(CHUNK_DIR, "%s.%05d.part" % (name.replace("/", "_"), idx))
            with open(part, "rb") as f:
                while True:
                    buf = f.read(1024 * 1024)
                    if not buf:
                        break
                    out.write(buf)
            os.remove(part)
    got = os.path.getsize(target)
    if got != size:
        raise RuntimeError("%s: размер %d != %d" % (name, got, size))
    log("  готов: %s (%.1f МБ)" % (name, got / 1048576))
    state[key] = {"done": list(range(total_chunks))}
    save_state(state)


def main():
    log("TTS_HOME: %s" % TTS_HOME)
    log("папка модели: %s" % DEST)
    files = api_files()
    if not files:
        log("не удалось получить список файлов")
        return 1
    fixed = []
    for name, size in files:
        if not size:
            try:
                req = urllib.request.Request(file_url(name), method="HEAD")
                with urllib.request.urlopen(req, timeout=40) as r:
                    size = int(r.headers.get("X-Linked-Size") or r.headers.get("Content-Length") or 0)
            except Exception as e:
                log("  размер не получен для %s: %s" % (name, e))
                size = 0
        fixed.append((name, size))
    total = sum(s for _, s in fixed if s)
    log("файлов: %d, всего %.2f ГБ" % (len(fixed), total / 1073741824))
    t0 = time.time()

    for name, size in sorted(fixed, key=lambda x: x[1]):
        if size >= 20 * 1024 * 1024:
            download_big(name, size)
        else:
            download_small(name, size)

    with open(os.path.join(DEST, "tos_agreed.txt"), "w", encoding="utf-8") as f:
        f.write("I have read, understood and agreed to the Terms and Conditions.")
    log("ГОТОВО за %.1f мин" % ((time.time() - t0) / 60))
    return 0


if __name__ == "__main__":
    sys.exit(main())
