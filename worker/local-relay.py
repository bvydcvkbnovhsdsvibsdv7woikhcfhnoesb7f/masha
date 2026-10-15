#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
local-relay.py — релей «Маши» на твоём компьютере. Нужен только Python (он у тебя есть).

Запуск (PowerShell, из папки проекта):
    $env:DEEPSEEK_API_KEY="sk-твой-ключ"; python worker/local-relay.py

Потом в приложении: Настройки → 🛰️ Серверы Маши → добавить строку
    http://127.0.0.1:8787
→ «Сохранить серверы» → «Проверить» (должна быть зелёная галочка).

Релей слушает только этот компьютер — ключ наружу не уходит.
Остановить: Ctrl+C в окне терминала.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# В консоли Windows кодировка cp1251 — переключаем вывод на UTF-8,
# иначе печать эмодзи/спецсимволов роняет скрипт.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/chat/completions")
TEXT_MODEL = os.environ.get("DEEPSEEK_TEXT_MODEL", "deepseek-flash")
VISION_MODEL = os.environ.get("DEEPSEEK_VISION_MODEL", "deepseek-flash")
TIMEOUT = int(os.environ.get("RELAY_TIMEOUT_MS", "30000")) / 1000.0
MAX_TOKENS = int(os.environ.get("RELAY_MAX_TOKENS", "350"))
THOUGHTS = os.environ.get("DEEPSEEK_THOUGHTS", "1") != "0"
SOFT_REPLY = "блин, у меня чето связь пропала, давай еще раз?"

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400",
}


def api_key():
    return os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("DEEPSEEK_KEY") or ""


def soft_error(code, message):
    return {"ok": False, "error": code, "message": message, "reply": SOFT_REPLY}


def ask_deepseek(messages, model):
    """Запрос к DeepSeek. Никогда не бросает исключение: возвращает (ok, reply|код)."""
    key = api_key()
    if not key:
        return False, "no_api_key"
    body = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": MAX_TOKENS,
        "temperature": 0.9,
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        BASE_URL, data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        print("[relay] DeepSeek HTTP", e.code, detail, flush=True)
        return False, "deepseek_%s" % e.code
    except Exception as e:  # таймаут, нет сети и т.п.
        print("[relay] DeepSeek недоступен:", e, flush=True)
        return False, "deepseek_unreachable"

    try:
        data = json.loads(raw)
    except Exception:
        print("[relay] DeepSeek вернул не JSON", flush=True)
        return False, "deepseek_bad_response"
    try:
        content = data["choices"][0]["message"]["content"]
    except Exception:
        content = None
    if not content or not str(content).strip():
        return False, "deepseek_empty"
    return True, str(content).strip()


def sanitize_history(history):
    clean = []
    for m in history or []:
        if not isinstance(m, dict):
            continue
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        role = "assistant" if m.get("role") == "bot" else m.get("role")
        if role not in ("user", "assistant"):
            continue
        if clean and clean[-1]["role"] == role:
            clean[-1]["content"] += "\n" + content
        else:
            clean.append({"role": role, "content": content})
    while clean and clean[-1]["role"] == "user":
        clean.pop()
    return clean[-15:]


def handle_initiative(body):
    st = body.get("state") or {}
    now = time.strftime("%d.%m.%Y %H:%M")
    since = 999
    if st.get("lastUserMessageTime"):
        since = int((time.time() * 1000 - st["lastUserMessageTime"]) / 60000)
    msgs = st.get("messages") or []
    last = msgs[-1].get("content", "ничего") if msgs else "ничего"
    prompt = (
        "Ты Маша, 16 лет, Красноярск, ты девушка Эдуарда. Сейчас: %s.\n"
        "Твоё состояние: %s. Отношения: %s/100.\n"
        "Он не писал: %s мин. Он сейчас: %s.\n"
        "Последнее обсуждали: %s.\nТвоя прошлая мысль: %s.\n\n"
        "Хочешь написать ему прямо сейчас? Пиши коротко, 1-3 слова, как в переписке: "
        "без точки в конце, без эмодзи.\n"
        "Формат ответа ТОЛЬКО: \"ХОЧУ: <текст>\" или \"НЕ ХОЧУ: <почему>\"."
        % (now, st.get("currentState", "calm"), st.get("relationship", 80), since,
           st.get("userStatus", "awake"), str(last)[:100], str(st.get("lastThought", "ничего"))[:100])
    )
    ok, out = ask_deepseek([{"role": "user", "content": prompt}], TEXT_MODEL)
    if not ok:
        data = {"ok": False, "initiative": False, "message": "не смогла придумать сообщение", "reply": SOFT_REPLY}
        return 200, data
    up = out.upper()
    if up.startswith("ХОЧУ"):
        return 200, {"ok": True, "initiative": True, "text": out.split(":", 1)[-1].strip()}
    if up.startswith("НЕ ХОЧУ"):
        return 200, {"ok": True, "initiative": False, "reason": out.split(":", 1)[-1].strip()}
    return 200, {"ok": True, "initiative": False, "reason": out[:120]}


def handle_chat(body):
    text = (body.get("text") or "").strip()
    image = body.get("image") or ""
    if not text and not image:
        return 400, soft_error("empty_message", "в запросе нет ни текста, ни фото")

    history = sanitize_history(body.get("history"))

    thought = ""
    if THOUGHTS:
        hist = "\n".join(("Он: " if m["role"] == "user" else "Ты: ") + m["content"] for m in history[-5:])
        tp = ("Ты Маша, девушка Эдуарда. Контекст:\n%s\nОн написал: %s\nТвоя прошлая мысль: %s\n"
              "Напиши ОДНУ мысль до 15 слов про себя, lowercase, не для него."
              % (hist or "нет", text or "[фото]", str(body.get("lastThought", "ничего"))[:80]))
        ok_t, thought = ask_deepseek([{"role": "user", "content": tp}], TEXT_MODEL)
        if not ok_t:
            thought = ""

    if image:
        user_content = [
            {"type": "text", "text": text or "Отреагируй на это фото."},
            {"type": "image_url", "image_url": {"url": image}},
        ]
    else:
        user_content = text

    system = {"role": "system",
              "content": str(body.get("systemPrompt") or "Ты Маша, девушка Эдуарда.")
                         + "\n\nТы сейчас думаешь: " + (thought or "ничего особого")}
    model = VISION_MODEL if image else TEXT_MODEL

    ok, out = ask_deepseek([system] + history + [{"role": "user", "content": user_content}], model)
    if not ok and history:
        print("[relay] повтор без истории, причина:", out, flush=True)
        ok, out = ask_deepseek([system, {"role": "user", "content": user_content}], model)
    if not ok:
        data = soft_error(out, "AI не ответил")
        data["thought"] = thought
        return 200, data
    return 200, {"ok": True, "reply": out, "thought": thought, "model": model}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # не засоряем консоль

    def _send(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_empty(self, status):
        self.send_response(status)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_OPTIONS(self):
        self._send_empty(204)

    def do_GET(self):
        key = api_key()
        self._send(200, {
            "ok": True,
            "service": "masha-relay",
            "version": "2.0.0",
            "host": "python-local",
            "hasKey": bool(key),
            "models": {"text": TEXT_MODEL, "vision": VISION_MODEL},
            "thoughts": THOUGHTS,
            "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "hint": "релей жив, ключ на месте" if key else "не задан DEEPSEEK_API_KEY",
        })

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8", "replace") if length else ""
            if not raw.strip():
                self._send(400, soft_error("bad_json", "пустое тело запроса"))
                return
            try:
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError("ожидался объект")
            except Exception:
                self._send(400, soft_error("bad_json", "некорректный JSON в теле запроса"))
                return

            if not api_key():
                self._send(500, soft_error("no_api_key", "не задан DEEPSEEK_API_KEY"))
                return

            if body.get("checkInitiative"):
                status, data = handle_initiative(body)
            else:
                status, data = handle_chat(body)
            self._send(status, data)
        except Exception as e:  # никаких HTML и стектрейсов наружу
            print("[relay] ошибка:", e, flush=True)
            self._send(500, soft_error("server_error", "внутренняя ошибка релея"))


def main():
    if not api_key():
        print()
        print("НЕ ЗАДАН КЛЮЧ DeepSeek. Запусти так:")
        print('   PowerShell:  $env:DEEPSEEK_API_KEY="sk-..."; python worker/local-relay.py')
        print("   cmd:         set DEEPSEEK_API_KEY=sk-... && python worker/local-relay.py")
        print()
        return 2
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print()
    print("  [OK] Локальный релей «Маши» запущен (Python)")
    print("  Адрес для приложения:  http://%s:%d" % (HOST, PORT))
    print("  Проверка в браузере:   http://%s:%d/   (ждём JSON с \"hasKey\":true)" % (HOST, PORT))
    print("  Остановить:            Ctrl+C")
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстанавливаю релей.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
