#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""
check-key.py — проверить ключ DeepSeek и узнать, какие модели доступны.

Запуск (PowerShell):
    cd путь\к\masha-fixed
    $env:DEEPSEEK_API_KEY="sk-твой-ключ"
    python tools/check-key.py

Скрипт НЕ сохраняет ключ никуда: он только отправляет его в DeepSeek и печатает ответ.
"""
import json
import os
import sys
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
KEY = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("DEEPSEEK_KEY") or ""

MODELS_TO_TRY = ["deepseek-chat", "deepseek-reasoner", "deepseek-flash", "deepseek-v4.1-flash"]


def request(path, payload=None, method="GET"):
    url = BASE + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def main():
    if not KEY:
        print()
        print("Ключ не задан. Запусти так:")
        print('   $env:DEEPSEEK_API_KEY="sk-..."; python tools/check-key.py')
        print()
        return 2

    print()
    print("Ключ: %s...%s (длина %d символов)" % (KEY[:6], KEY[-4:] if len(KEY) > 10 else "", len(KEY)))
    print()

    # 1. Проверка ключа и баланса
    status, body = request("/user/balance")
    if status == 200:
        try:
            data = json.loads(body)
            avail = data.get("is_available")
            print("[OK] Ключ рабочий. Баланс доступен: %s" % avail)
            for b in data.get("balance_infos", []) or []:
                print("     %s: остаток %s %s (подарено %s, пополнено %s)" % (
                    b.get("currency"), b.get("total_balance"), b.get("currency"),
                    b.get("granted_balance"), b.get("topped_up_balance")))
        except Exception:
            print("[OK] Ключ рабочий, ответ:")
            print(body[:500])
    elif status in (401, 403):
        print("[ОШИБКА] Ключ НЕ принят (%s). Он неверный, отозван или скопирован не полностью." % status)
        print("         Создай новый: platform.deepseek.com → API keys → Create new API key")
        print("         Ответ DeepSeek: %s" % body[:300])
        return 1
    elif status == 0:
        print("[ОШИБКА] Нет связи с api.deepseek.com: %s" % body[:200])
        return 1
    else:
        print("[?] Неожиданный ответ %s: %s" % (status, body[:300]))

    # 2. Какая модель реально отвечает
    print()
    print("Проверяю модели...")
    working = []
    for model in MODELS_TO_TRY:
        status, body = request("/chat/completions", {
            "model": model,
            "messages": [{"role": "user", "content": "ответь одним словом: привет"}],
            "max_tokens": 10,
            "temperature": 0,
            "stream": False,
        }, method="POST")
        if status == 200:
            try:
                text = json.loads(body)["choices"][0]["message"]["content"].strip()
            except Exception:
                text = body[:60]
            print("  [OK] %-20s ответ: %s" % (model, text[:60]))
            working.append(model)
        else:
            short = ""
            try:
                err = json.loads(body)
                short = (err.get("error") or {}).get("message") or body[:120]
            except Exception:
                short = body[:120]
            print("  [--] %-20s не работает (%s): %s" % (model, status, short[:120]))

    print()
    if working:
        print("ИТОГ: рабочие модели — %s" % ", ".join(working))
        print("В релей можно оставить (или указать в настройках воркера):")
        print('   DEEPSEEK_TEXT_MODEL = "%s"' % working[0])
        if len(working) > 1:
            print('   DEEPSEEK_VISION_MODEL = "%s"' % working[-1])
    else:
        print("ИТОГ: ни одна модель не ответила — проверь баланс и название модели в личном кабинете DeepSeek.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
