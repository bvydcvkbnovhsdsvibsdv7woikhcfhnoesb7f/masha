#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""analyze-archive.py — разбор экспорта Telegram «Маши»: стиль речи, темы, ритуалы.
Запуск:  python tools/analyze-archive.py <chat1.json> [chat2.json ...]
Отчёт пишется в tools/style-report.txt
"""
import json, io, os, re, sys, collections

FILES = sys.argv[1:] or [
    r"C:\Users\Эдуард\Downloads\рпрп\chat1.json",
    r"C:\Users\Эдуард\Downloads\тма\chat2.json",
]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "style-report.txt")

EMOJI_RE = re.compile(
    "[" "\U0001F300-\U0001FAFF" "\U00002600-\U000027BF" "\U0001F000-\U0001F2FF"
    "\U00002190-\U000021FF" "\U00002B00-\U00002BFF" "\U0000FE0F" "\U00002764" "]"
)

STOP = set("""и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по
только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или
ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где
есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда
кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были
куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас
про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть
том нельзя такой им более всегда конечно всю между это ты я мы вы они оно она он ах ох ух эх
кстати вообще просто очень короче типа типо вроде кажись значит вообще-то блин ну-ну ага угу
да-да нет-нет ладно ок окей понял поняла ясно ясненько спс спасибо пожалуйста привет пока
""".split())

# Слова, которые важны как факты о ней (не убираем)
KEEP = set("""кот кошка брат мама папа отчим школа колледж пары уроки контрольная экзамен
голова тошнота паничка сон спать бравл роблокс майнкрафт тикток вб wildberries сырники
квадроцикл лошади речка полина ксюша вика красноярск обиделась прости ссора помирились
люблю скучаю зай коть муж мальчик любимый солнышко родной""".split())

PETNAMES = ["зай", "зая", "зайка", "зааай", "коть", "кот", "муж", "муууууж", "мужчина",
            "любимый", "мальчик", "мой мальчик", "солнышко", "родной", "люблю", "люб",
            "скучаю", "ангел", "малыш", "дорогой", "хороший мой", "будущий муж"]
MARKERS = ["-_-", "чо", "чё", "щас", "типо", "типа", "вообще", "пипец", "жесть", "капец",
           "блин", "хз", "ага", "хаха", "ахах", "ахаха", "хах", "ор", "угараю", "смешно",
           "дурак", "отстань", "не трогай", "заебал", "бля", "пиздец", "ужас", "кошмар",
           "скучно", "спать", "голова", "болит", "устала", "обидно", "прости", "сорри",
           "доброе утро", "спокойной ночи", "сладких снов", "пока", "целую", "обнимаю"]
SWEARS = ["бля", "блять", "пиздец", "хуй", "ебат", "заебал", "нахуй", "пизд", "ахуе",
          "сука", "мразь", "долбоеб", "жопа", "срать"]
TOPICS = {
    "кот/кошка": ["кот", "кошк", "котенок", "котёнок", "мурк"],
    "мама": ["мама", "мам ", "маме", "маму"],
    "брат": ["брат", "малой", "мелкий", "мини бро"],
    "школа/колледж": ["школ", "колледж", "пар ", "пары", "урок", "контрольн", "учител", "зачёт", "экзамен"],
    "голова/самочувствие": ["голов", "тошн", "болит", "паничк", "темпер", "простыл", "болею"],
    "сон/режим": ["спать", "сон", "сплю", "ложусь", "встал", "выспат", "не спал"],
    "Brawl Stars": ["бравл", "brawl", "брaвл"],
    "Роблокс/Майнкрафт": ["роблокс", "майнкрафт", "roblox", "minecraft"],
    "TikTok/лента": ["тикток", "tik tok", "лент", "рилс", "reels"],
    "Wildberries/покупки": ["вб", "wildberries", "корзин", "заказ", "посылк", "ozon", "озон"],
    "сырники/еда": ["сырник", "поел", "куша", "еда", "кушать", "голодн", "чай"],
    "Тренировки/похудение": ["похуд", "вес", "трениров", "зал", "качал", "диет"],
    "внешность/одежда": ["волос", "ногт", "крашу", "макияж", "палетк", "платье", "шмот"],
    "отношения/чувства": ["любл", "любим", "скуча", "ревну", "обид", "прости", "ссор", "расста", "целу"],
    "работа/деньги": ["работ", "деньг", "зарплат", "подработ", "долг", "кредит"],
    "игры вместе": ["играть", "игру", "поигра", "катк", "тим"],
    "гитара/музыка": ["гитар", "песн", "музык", "слуша", "плейлист"],
    "поездки/мечты": ["квадроцикл", "лошад", "речк", "поеха", "отпуск", "мечт"],
}


def is_her(m, her_ids):
    return str(m.get("from_id")) in her_ids


def text_of(m):
    t = m.get("text")
    if isinstance(t, str):
        return t
    if isinstance(t, list):
        parts = []
        for p in t:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                parts.append(p.get("text", ""))
        return "".join(parts)
    return ""


def main():
    her, him, service = [], [], 0
    her_ids = set()
    for path in FILES:
        with io.open(path, encoding="utf-8") as f:
            data = json.load(f)
        peer = "user" + str(data["id"])
        her_ids.add(peer)
        for m in data["messages"]:
            if m.get("type") == "service":
                service += 1
                continue
            txt = text_of(m).strip()
            if not txt:
                continue
            rec = {"t": txt, "ts": int(m.get("date_unixtime") or 0), "from": m.get("from")}
            (her if is_her(m, her_ids) else him).append(rec)

    out = io.open(OUT, "w", encoding="utf-8")
    w = out.write
    w("=" * 72 + "\nСТИЛЬ И ЖИЗНЬ «ЕЁ» ПО 265К СООБЩЕНИЙ\n" + "=" * 72 + "\n")
    w("Всего её сообщений: %d\nВсего его сообщений: %d\nСлужебных: %d\n" % (len(her), len(him), service))
    w("Идентификаторы её аккаунта: %s\n" % ", ".join(sorted(her_ids)))

    her.sort(key=lambda r: r["ts"])

    # --- длина и оформление ---
    lens = [len(r["t"]) for r in her]
    words = [len(r["t"].split()) for r in her]
    lens.sort()
    words_sorted = sorted(words)
    n = len(lens)

    def pct(cond, seq):
        return 100.0 * sum(1 for x in seq if cond(x)) / max(1, len(seq))

    w("\n--- ФОРМА СООБЩЕНИЙ ---\n")
    w("длина в символах: медиана %d, среднее %.1f, 90%% <= %d\n" % (
        lens[n // 2], sum(lens) / n, lens[int(n * 0.9)]))
    w("длина в словах:   медиана %d, 90%% <= %d\n" % (words_sorted[n // 2], words_sorted[int(n * 0.9)]))
    w("доля сообщений из 1-3 слов: %.0f%%\n" % pct(lambda x: x <= 3, words))
    w("доля сообщений >15 слов:    %.0f%%\n" % pct(lambda x: x > 15, words))
    w("начинается со строчной:     %.0f%%\n" % pct(lambda r: r["t"][:1].islower(), her))
    w("заканчивается точкой:       %.0f%%\n" % pct(lambda r: r["t"].rstrip().endswith("."), her))
    w("заканчивается вопросом:     %.0f%%\n" % pct(lambda r: r["t"].rstrip().endswith("?"), her))
    w("заканчивается воскл.:       %.0f%%\n" % pct(lambda r: r["t"].rstrip().endswith("!"), her))
    w("совсем без знаков в конце:  %.0f%%\n" % pct(
        lambda r: not r["t"].rstrip()[-1:] in ".?!…", her))
    w("есть эмодзи:                %.0f%%\n" % pct(lambda r: bool(EMOJI_RE.search(r["t"])), her))
    w("есть мат:                   %.0f%%\n" % pct(
        lambda r: any(s in r["t"].lower() for s in SWEARS), her))

    # --- эмодзи ---
    emo = collections.Counter()
    for r in her:
        for ch in EMOJI_RE.findall(r["t"]):
            emo[ch] += 1
    w("\n--- ТОП-25 ЭМОДЗИ (всего %d вхождений) ---\n" % sum(emo.values()))
    w("  " + "  ".join("%s%d" % (e, c) for e, c in emo.most_common(25)) + "\n")

    # --- слова ---
    tok = collections.Counter()
    for r in her:
        for word in re.findall(r"[а-яёa-z0-9\-_]+", r["t"].lower()):
            if len(word) < 3:
                continue
            if word in STOP and word not in KEEP:
                continue
            tok[word] += 1
    w("\n--- ТОП-120 ЕЁ СЛОВ ---\n")
    top = tok.most_common(120)
    for i in range(0, len(top), 6):
        w("  " + ", ".join("%s(%d)" % (x, c) for x, c in top[i:i + 6]) + "\n")

    # --- биграммы и триграммы ---
    for size, label, limit in ((2, "ДВУХСЛОВНЫЕ ОБОРОТЫ", 40), (3, "ТРЁХСЛОВНЫЕ ОБОРОТЫ", 30)):
        grams = collections.Counter()
        for r in her:
            ws = [x for x in re.findall(r"[а-яёa-z\-]+", r["t"].lower()) if len(x) > 1]
            for i in range(len(ws) - size + 1):
                g = " ".join(ws[i:i + size])
                if all(x in STOP for x in ws[i:i + size]):
                    continue
                grams[g] += 1
        w("\n--- %s ---\n" % label)
        for g, c in grams.most_common(limit):
            if c < 25:
                break
            w("  %s (%d)\n" % (g, c))

    # --- маркеры речи ---
    w("\n--- ХАРАКТЕРНЫЕ СЛОВА/МАРКЕРЫ ---\n")
    low = [r["t"].lower() for r in her]
    for m in MARKERS:
        c = sum(1 for t in low if m in t)
        if c:
            w("  %-16s %5d\n" % (m, c))

    # --- обращения к нему ---
    w("\n--- КАК ОНА ЕГО НАЗЫВАЕТ ---\n")
    for p in PETNAMES:
        c = sum(1 for t in low if p in t)
        if c:
            w("  %-16s %5d\n" % (p, c))

    # --- темы ---
    w("\n--- ТЕМЫ (сколько её сообщений) ---\n")
    for name, keys in sorted(TOPICS.items(), key=lambda kv: -sum(
            1 for t in low if any(k in t for k in kv[1]))):
        c = sum(1 for t in low if any(k in t for k in keys))
        if c:
            w("  %-26s %5d  (%.1f%%)\n" % (name, c, 100.0 * c / len(her)))

    # --- активность по часам ---
    hours = collections.Counter()
    for r in her:
        if r["ts"]:
            hours[(r["ts"] // 3600 + 7) % 24] += 1   # UTC -> Красноярск
    w("\n--- В КАКОЙ ЧАС ОНА ПИШЕТ (Красноярск) ---\n")
    peak = max(hours.values() or [1])
    for h in range(24):
        w("  %02d:00 %s %d\n" % (h, "#" * int(40 * hours.get(h, 0) / peak), hours.get(h, 0)))

    # --- реакции на «люблю» ---
    w("\n--- ЧТО ОНА ОТВЕЧАЕТ НА ЕГО «люблю/скучаю» (примеры) ---\n")
    merged = sorted(her + him, key=lambda r: r["ts"])
    shown = 0
    for i, m in enumerate(merged):
        if m in him and re.search(r"любл|скуча", m["t"].lower()) and len(m["t"]) < 40:
            nxt = [x for x in merged[i + 1:i + 3] if x in her]
            if nxt:
                w("  он: %s\n  она: %s\n\n" % (m["t"][:70], " / ".join(x["t"][:70] for x in nxt[:2])))
                shown += 1
                if shown >= 25:
                    break

    # --- ночной ритуал ---
    w("\n--- НОЧНОЙ РИТУАЛ (её сообщения со «сладких снов/спокойной ночи», 40 примеров) ---\n")
    nights = [r["t"] for r in her if re.search(r"сладких снов|спокойной ночи|доброй ночи", r["t"].lower())]
    w("всего таких сообщений: %d\n" % len(nights))
    for t in nights[:40]:
        w("  %s\n" % t.replace("\n", " ")[:110])

    # --- утренние ---
    morns = [r["t"] for r in her if re.search(r"доброе утро|добрый день", r["t"].lower())]
    w("\n--- УТРЕННИЕ (всего %d, 20 примеров) ---\n" % len(morns))
    for t in morns[:20]:
        w("  %s\n" % t.replace("\n", " ")[:110])

    # --- её рассказы (длинные сообщения) ---
    w("\n--- ЕЁ ДЛИННЫЕ СООБЩЕНИЯ (25 примеров, >120 символов) ---\n")
    longs = [r["t"] for r in her if len(r["t"]) > 120]
    w("всего длинных: %d (%.1f%%)\n" % (len(longs), 100.0 * len(longs) / len(her)))
    import random
    random.seed(42)
    for t in random.sample(longs, min(25, len(longs))):
        w("  • %s\n" % t.replace("\n", " ")[:300])

    # --- первые и последние ---
    w("\n--- НАЧАЛО ПЕРЕПИСКИ (первые 20 её и его) ---\n")
    for m in merged[:40]:
        w("  %s: %s\n" % ("она" if m in her else "он", m["t"].replace("\n", " ")[:100]))
    w("\n--- КОНЕЦ ПЕРЕПИСКИ (последние 30) ---\n")
    for m in merged[-30:]:
        w("  %s: %s\n" % ("она" if m in her else "он", m["t"].replace("\n", " ")[:110]))

    # --- сводка по эмоциям ---
    w("\n--- КОНТЕКСТ ОТНОШЕНИЙ ---\n")
    total_days = len({(r["ts"] // 86400) for r in her if r["ts"]})
    w("дней с её сообщениями: %d\n" % total_days)
    first = merged[0]["ts"] if merged else 0
    last = merged[-1]["ts"] if merged else 0
    import datetime
    w("период: %s — %s\n" % (
        datetime.datetime.utcfromtimestamp(first + 7 * 3600).strftime("%d.%m.%Y") if first else "?",
        datetime.datetime.utcfromtimestamp(last + 7 * 3600).strftime("%d.%m.%Y") if last else "?"))

    out.close()
    print("отчёт: " + OUT)
    print("её сообщений: %d, его: %d" % (len(her), len(him)))


if __name__ == "__main__":
    main()
