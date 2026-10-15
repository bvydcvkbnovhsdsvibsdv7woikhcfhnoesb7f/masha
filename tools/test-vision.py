#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Разовый тест: принимает ли модель картинки (vision)."""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

KEY = os.environ.get("DEEPSEEK_API_KEY") or ""
URL = "https://api.deepseek.com/chat/completions"

# крошечная картинка 1x1 (PNG)
PNG = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6300010000050001a5f645400000000049454e44ae426082")).decode()
IMG = "data:image/png;base64," + PNG

MODELS = ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat"]


def ask(model):
    body = json.dumps({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "Что на фото? Ответь одним словом."},
                {"type": "image_url", "image_url": {"url": IMG}},
            ],
        }],
        "max_tokens": 30,
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(URL, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        reply = data["choices"][0]["message"].get("content", "")
        return "OK", str(reply).strip()[:80]
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(raw)["error"]["message"]
        except Exception:
            msg = raw
        return "HTTP %s" % e.code, msg[:200]
    except Exception as e:
        return "нет связи", str(e)[:200]


print()
if not KEY:
    print("нет ключа")
    sys.exit(2)
for m in MODELS:
    status, text = ask(m)
    print("%-18s фото -> %s: %s" % (m, status, text))
print()
