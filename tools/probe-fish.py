# -*- coding: utf-8 -*-
"""Проверка Fish Audio: что доступно на бесплатном тарифе и работает ли
мгновенное клонирование (references) без создания модели."""
import base64
import json
import os
import sys
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

TOKENS = r"C:\Users\Эдуард\Downloads\токены.txt"
ROOT = r"C:\Users\Эдуард\Downloads\masha-fixed"
CLIPS = r"C:\Users\Эдуард\Downloads\голос-для-клонирования"


def token(name):
    for line in open(TOKENS, encoding="utf-8"):
        if line.strip().startswith(name + "="):
            return line.split("=", 1)[1].strip()
    return ""


KEY = token("fish_key")


def api(method, url, body=None, ctype="application/json"):
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + KEY)
    req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return r.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()


print("=== 1. мои голоса (модели) ===")
st, raw = api("GET", "https://api.fish.audio/model?page_size=20")
print("  HTTP", st)
try:
    d = json.loads(raw.decode("utf-8"))
    items = d.get("items") or d.get("data") or []
    print("  голосов в аккаунте:", len(items))
    for it in items[:5]:
        print("   -", it.get("title"), "|", it.get("_id"), "|", it.get("state"))
except Exception:
    print("  ответ:", raw[:300])

print()
print("=== 2. баланс / кредиты ===")
for url in ("https://api.fish.audio/wallet", "https://api.fish.audio/wallet/self", "https://api.fish.audio/me"):
    st, raw = api("GET", url)
    print(" ", url.split("api.fish.audio")[1], "→ HTTP", st, raw[:200].decode("utf-8", "replace"))

# транскрипт первого клипа — узнаем через наш релей
print()
print("=== 3. транскрипт клипа (через наш релей) ===")
clip = os.path.join(CLIPS, "05_2024-08-29_7s.ogg")
b64 = base64.b64encode(open(clip, "rb").read()).decode("ascii")
body = json.dumps({"stt": True, "audio": b64, "mime": "audio/ogg"}).encode("utf-8")
req = urllib.request.Request("https://masha-relay.lusnikoveduard9.workers.dev/api/relay", data=body,
                             headers={"Content-Type": "application/json"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read().decode("utf-8"))
        text = d.get("text", "")
        print("  распознано:", "«" + text + "»")
except Exception as e:
    text = ""
    print("  ошибка STT:", e)

print()
print("=== 4. мгновенное клонирование (references) без модели ===")
ref_b64 = base64.b64encode(open(clip, "rb").read()).decode("ascii")
attempts = [
    ("references c base64", {"text": "Привет, это мой голос.", "format": "mp3",
                             "references": [{"audio": ref_b64, "text": text or "привет"}]}),
    ("references c data-url", {"text": "Привет, это мой голос.", "format": "mp3",
                               "references": [{"audio": "data:audio/ogg;base64," + ref_b64, "text": text or "привет"}]}),
    ("reference_id пустой", {"text": "Привет, это мой голос.", "format": "mp3"}),
]
for name, payload in attempts:
    st, raw = api("POST", "https://api.fish.audio/v1/tts", payload)
    print(" ", name, "→ HTTP", st, "| байт:", len(raw))
    if st == 200 and len(raw) > 1000:
        out = os.path.join(r"C:\Users\Эдуард\Downloads", "fish-test-" + name.split()[0] + ".mp3")
        open(out, "wb").write(raw)
        print("    СОХРАНЁН:", out)
        break
    else:
        print("    ответ:", raw[:240].decode("utf-8", "replace"))
