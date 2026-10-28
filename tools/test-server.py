# -*- coding: utf-8 -*-
"""Проверка сервера голоса: синтез + отзывчивость + кэш."""
import json
import sys
import threading
import time
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = "http://127.0.0.1:8788"


def get_status(timeout=10):
    with urllib.request.urlopen(BASE + "/", timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def post_tts(text, timeout=600):
    data = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(BASE + "/tts", data=data, headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        audio = r.read()
        cache = r.headers.get("X-Cache", "?")
    return audio, time.time() - t0, cache


result = {}


def worker(text, key):
    try:
        audio, el, cache = post_tts(text)
        result[key] = (audio, el, cache)
        print("  [%s] «%s»: %.1f сек, %d КБ, кэш=%s" % (key, text[:30], el, len(audio) / 1024, cache), flush=True)
    except Exception as e:
        result[key] = None
        print("  [%s] ОШИБКА: %s" % (key, e), flush=True)


print("=== 1. первый синтез (должен быть медленным) ===", flush=True)
t = threading.Thread(target=worker, args=("Привет", "first"))
t.start()
# пока идёт синтез — проверяем, что сервер отвечает
waits = 0
while t.is_alive() and waits < 20:
    time.sleep(5)
    waits += 1
    try:
        st = get_status(5)
        print("    сервер отвечает во время синтеза: ready=%s cache=%s (через %d сек)" % (st.get("ready"), st.get("cache"), waits * 5), flush=True)
        break
    except Exception as e:
        print("    сервер НЕ отвечает через %d сек: %s" % (waits * 5, e), flush=True)
t.join()

print("=== 2. повторный синтез (должен быть из кэша) ===", flush=True)
worker("Привет", "second")

print("=== 3. новая фраза ===", flush=True)
worker("И я тебя люблю очень сильно", "third")

print("=== итоги ===", flush=True)
for k, v in result.items():
    if v:
        audio, el, cache = v
        print("  %-7s %.1f сек, %d КБ, cache=%s" % (k, el, len(audio) / 1024, cache), flush=True)
    else:
        print("  %-7s ошибка" % k, flush=True)

# сохраняем первый удачный файл
for k in ("first", "second", "third"):
    if result.get(k) and result[k][0]:
        with open(r"C:\Users\Эдуард\Downloads\тест-голос-Привет.wav", "wb") as f:
            f.write(result[k][0])
        print("  сохранил: C:\\Users\\Эдуард\\Downloads\\тест-голос-Привет.wav", flush=True)
        break

try:
    st = get_status(10)
    print("  статус: cache=%s hits=%s requests=%s" % (st.get("cache"), st.get("cache_hits"), st.get("requests")), flush=True)
except Exception:
    pass
print("ГОТОВО", flush=True)
