# -*- coding: utf-8 -*-
"""Ищет публичное HF-пространство с XTTS, которое:
   * принимает ФАЙЛ образца голоса (Audio/File компонент),
   * поддерживает русский язык.
Печатает подходящие пространства и параметры их API."""
import json
import sys
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from gradio_client import Client


def running_spaces(query, limit=60):
    url = "https://huggingface.co/api/spaces?search=%s&limit=%d" % (urllib.parse.quote(query), limit)
    with urllib.request.urlopen(url, timeout=40) as r:
        items = json.loads(r.read().decode("utf-8"))
    return [it["id"] for it in items]


def is_running(space):
    try:
        with urllib.request.urlopen("https://huggingface.co/api/spaces/%s" % space, timeout=20) as r:
            d = json.loads(r.read().decode("utf-8"))
        rt = d.get("runtime") or {}
        return rt.get("stage") == "RUNNING"
    except Exception:
        return False


def analyze(space):
    """Возвращает список (api_name, params, ru_ok)."""
    c = Client(space, verbose=False)
    api = c.view_api(print_info=False, return_format="dict")
    named = api.get("named_endpoints") or {}
    found = []
    for name, info in named.items():
        params = info.get("parameters", [])
        comps = [(p.get("component") or "?", p.get("parameter_name") or p.get("label") or "?") for p in params]
        has_file = any(c0 in ("Audio", "File", "Image") for c0, _ in comps)
        ru = False
        for p in params:
            ch = p.get("choices") or []
            vals = []
            for x in ch:
                vals.append(x[1] if isinstance(x, (list, tuple)) and len(x) == 2 else x)
            if any(isinstance(v, str) and v.lower() in ("russian", "ru", "русский") for v in vals):
                ru = True
        has_text = any(c0 == "Textbox" for c0, _ in comps)
        if has_text and has_file and ru:
            found.append((name, comps, True))
        elif has_text and has_file and name in ("/predict", "/tts", "/synthesize", "/generate"):
            found.append((name, comps, False))
    return found


import urllib.parse  # noqa: E402

queries = ["xtts", "xtts-v2", "voice cloning", "voice-clone", "tts russian", "russian tts"]
seen = set()
candidates = []
for q in queries:
    try:
        for sp in running_spaces(q):
            if sp not in seen:
                seen.add(sp)
                candidates.append(sp)
    except Exception as e:
        print("поиск '%s' не удался: %s" % (q, e))

print("проверяю %d пространств ..." % len(candidates), flush=True)
good = []
for sp in candidates:
    if not is_running(sp):
        continue
    try:
        res = analyze(sp)
    except Exception as e:
        continue
    for name, comps, ru in res:
        tag = "★РУССКИЙ" if ru else ""
        print("  %-45s %-22s %s" % (sp, name, tag), flush=True)
        print("      " + ", ".join("%s:%s" % (c0, nm) for c0, nm in comps[:6]), flush=True)
        if ru:
            good.append((sp, name, comps))

print()
print("=== ПОДХОДЯЩИЕ (с русским и загрузкой файла): %d ===" % len(good), flush=True)
for sp, name, comps in good:
    print("  " + sp + " → " + name, flush=True)
