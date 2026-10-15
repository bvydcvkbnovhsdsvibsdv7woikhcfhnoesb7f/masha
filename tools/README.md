# Инструменты проекта «Маша»

Все скрипты лежат в `tools/`. Запуск — из корня проекта.

## Разбор переписки (что я вытащил из 265 080 сообщений)

| Скрипт | Что делает | Результат |
|---|---|---|
| `mine-everything.py` | все измерения сразу: вопросы, истории, конфликты, ответные цепочки, его речь, редкие слова, даты, места, статистика по времени | `все-вопросы.txt`, `истории.txt`, `конфликты-и-примирения.txt`, `ответные-цепочки.txt`, `его-речь.txt`, `редкие-слова.txt`, `даты-и-события.txt`, `места-и-бренды.txt`, `время-и-статистика.txt` |
| `chronicle.py` | хроника по каждому из 726 дней + первые упоминания + книга цитат | `chronicle.md`, `quotebook.md` |
| `deep-dossier.py` | хронология, паузы, люди, семья, быт, конфликты, внешность, эволюция | `dossier-full.txt` |
| `deep-facts.py` | факты с доказательствами: имя, родные, возраст, даты, привычки | `facts-report.txt`, `archive/masha-facts.json.gz` |
| `build-kb.py` | база знаний: люди, темы, месяцы, подарки, планы, музыка, шутки | `knowledge-base.md`, `archive/masha-kb.json.gz` |
| `build-brain.py` | «мозг»: профиль, темы, хроника, ассоциации | `archive/masha-brain.json.gz` |
| `mine-style.py` | её речь в цифрах: частоты фраз, ритуалы, обороты | `style-dossier.txt` |
| `analyze-pairs.py` | что она отвечает на каждую ситуацию, её серии сообщений | `pairs-report.txt` |
| `mine-names.py` | добыча имени: обращения, самоидентификации, споры об имени | вывод в консоль |
| `full-export.py` | выгружает **каждое** сообщение текстом + медиа по месяцам | `полная-переписка.txt`, `её-сообщения.txt`, `статистика.txt` |
| `inspect-exports.py` | разбор экспортов Telegram и сверка с архивом | вывод в консоль |

## Сборка и обслуживание памяти

| Скрипт | Что делает |
|---|---|
| `build-archive.mjs` | собрать архив из JSON-экспортов (`node tools/build-archive.mjs --in source/*.json`) |
| `rebuild-index.mjs` | пересобрать индекс ключевых слов по архиву (нужно после смены стемминга) |
| `check-archive.mjs` | проверить память на живых вопросах |
| `check-all.mjs` | полная ревизия проекта: файлы, синтаксис, архив, индекс, приложение, адреса, готовность APK |
| `apply-prompt.mjs` | вставить текст из `prompt-new.txt` в `index.html` и `PROMPT.md` |
| `make-adapters.mjs` | сгенерировать релей для Deno/Netlify/Vercel/Node из `worker/worker.js` |
| `check-key.py` | проверить ключ DeepSeek, баланс и доступные модели |
| `test-vision.py` | проверить, видит ли модель фото |
| `analyze-archive.py` | старый отчёт по стилю (до `mine-style.py`) |

## Порядок пересборки памяти после новых данных

```
python tools/build-brain.py        # профиль, темы, хроника, ассоциации
python tools/build-kb.py           # люди, темы, месяцы, шутки
node   tools/rebuild-index.mjs     # индекс по архиву
node   tools/check-all.mjs         # ревизия
node   --test test/*.test.mjs      # 53 теста
```

## Приложение: что куда загружать

- `index.html`, `sw.js`, `manifest.json`, `js/*` — корень сайта/репозитория;
- `archive/masha-archive.json.gz`, `archive/masha-index.json.gz`, `archive/masha-brain.json.gz`, `archive/masha-kb.json.gz` — папка `archive/`;
- `worker/worker.js` — код для Cloudflare Worker (секрет `DEEPSEEK_API_KEY`).
