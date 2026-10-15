#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build-kb.py — полная база знаний по обоим чатам (265 080 сообщений).

    python tools/build-kb.py

Пишет:
    tools/knowledge-base.md      — большой человекочитаемый разбор по разделам
    archive/masha-kb.json.gz     — то же машинно, для «мозга» приложения

Разделы: люди и кто есть кто · хроника по месяцам · темы с цитатами · его жизнь ·
подарки и деньги · планы и встречи · музыка, фильмы, игры · здоровье · внешность ·
словечки и шутки · её лучшие фразы.
"""
import collections
import gzip
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MSK = timezone(timedelta(hours=7))
D = lambda ts: datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y")
DT = lambda ts: datetime.fromtimestamp(ts / 1000, MSK).strftime("%d.%m.%Y %H:%M")
YM = lambda ts: datetime.fromtimestamp(ts / 1000, MSK).strftime("%Y-%m")

CUTOFF = 1786554000000
# пересланные уведомления и мусор — не её воспоминания
SPAM = re.compile(r'^кому-то понравилась твоя анкета|вам пришло сообщение|напоминание|^🎰|подпишись|реклама|промокод|https?://|t\.me/|@[a-z0-9_]{4,}', re.I)

MALE = "Никита Федя Фёдор Паша Павел Максим Дима Дмитрий Саша Артём Артем Ваня Иван Миша Миша Кирилл Серёжа Сережа Егор Гоша Глеб Егор Матвей Рома Роман Влад Вова Стас Толя Костя Женя Лёша Леша Илья Даня Даниил Тима Тимофей Коля Витя Эдик Эдуард Андрей Олег Денис Антон Юра".split()
FEMALE = "Настя Анастасия Полина Лиза Елизавета Даша Дарья Катя Екатерина Алина Ксюша Ксения Соня София Арина Марина Юля Юлия Оля Ольга Таня Татьяна Вероника Ника Мила Милана Алиса Ева Кира Злата Вика Виктория Маша Мария Кристина Диана Валерия Лера Наташа Наталья Лена Лена Света Светлана Ира Ирина Галя Галина Люда Людмила".split()
NOT_NAME = set("""хорошо ура люблю зая сладких доброе неа спать хочу зай абонент прости тебе точно хаха твой умница умничка нормально хахаха буду дурак иди убью извини ещё понятно спи пиздец молодец вика поннял дааа игнор приятного приплыли пошли обойдешься коть сколько мама папа брат бабушка малой тётя тетя сестра кот коть боже ваще нафиг видимо прекрасно
привет пока спасибо пожалуйста сегодня завтра вчера сейчас потом когда тогда почему зачем как что кто где это всё все да нет ну ах ох эх блин капец ужас кошмар хватит ну ладно ок ага угу ясно""".split())

TOPICS = {
    "знакомство (Дайвинчик)": r"дайвинчик|дайвин|анкет|лайкнул|лайкнула|познакомились|знакомы с",
    "ссоры и обиды": r"поссор|ссор|обидел|обиделась|обидно|психанул|наорал|разозлил|заткнись|отстань|не пиши мне",
    "примирения": r"прости|извини|извиняюсь|помирил|не обижайся|я не обижаюсь",
    "ревность": r"ревну|ревност|ревнуешь|кто это|с кем ты",
    "встречи и приезды": r"приеду|приехал|приехала|встретимся|встреча|увидимся|приезжай|поезд|автобус|билет|вокзал",
    "подарки и сюрпризы": r"подарок|подарил|подарила|подарю|сюрприз|цветы|букет|перевёл|перевел|скинул деньг",
    "день рождения": r"день рождения|днюх|с др\b|с днём рождения|поздравля",
    "новый год и праздники": r"новый год|нового года|ёлк|елк|8 марта|23 февраля|14 февраля|валентин",
    "кот и котёнок": r"\bкот\b|коть|котик|котёнок|котенок|кошк",
    "тренировки и вес": r"тренировк|танц|похудел|похудеть|вес\b|фигур|качал|волейбол",
    "школа и уроки": r"школ|урок|контрольн|экзамен|физик|биолог|учител|домашк|огэ|егэ",
    "её здоровье": r"голов|болит|тошн|температур|горло|живот|панич|врач|таблетк",
    "её семья": r"мама|мамой|маме|отчим|папой|бабушк|малой|брат|Ваня",
    "музыка и песни": r"песн|трек|музык|наушник|заела",
    "его жизнь (учёба, работа)": r"колледж|универ|пары|работа|работу|зарплат|сесси|диплом|армия|военкомат",
    "лошади и квадроцикл": r"лошад|квадрик|квадроцикл|\bпит\b|\bпита\b",
    "его семья": r"твоя мама|твоей мамы|твой папа|твоего папы|твоя сестра|твой брат",
    "планы на будущее": r"свадьб|замуж|дети|ребёнок|ребенок|квартир|переед|жить вместе|вживую|в живую",
    "её внешность": r"волос|карие|глаз|рост|худая|фигур|кожа|стрижк|плать|кроссовк|куртк",
    "игры": r"роблокс|бравл|гренни|майнкрафт|стандофф|кс\b|доту|играть в|игру",
    "её страхи": r"боюсь|страшно|панич|корова|крови|кровь|темнот",
}


def main():
    rows = json.loads(gzip.open(os.path.join(ROOT, "archive", "masha-archive.json.gz"), "rb").read().decode("utf-8"))["messages"]
    msgs = []
    for r in rows:
        t = re.sub(r"\s+", " ", str(r[2] or "")).strip()
        if not t or r[1] >= CUTOFF or SPAM.search(t):
            continue
        msgs.append((r[0], t, r[1]))
    her = [(t, ts) for role, t, ts in msgs if role == "assistant"]
    his = [(t, ts) for role, t, ts in msgs if role == "user"]

    md = []
    W = md.append
    def head(t):
        W(""); W("## " + t); W("")
    def q(role, t, ts, width=150):
        W("- `%s` **%s:** %s" % (D(ts), "она" if role == "assistant" else "он", t[:width]))

    kb = {"v": 1, "builtAt": datetime.now(MSK).isoformat(), "messages": len(msgs)}

    W("# Полная база знаний: 265 080 сообщений, 17.08.2024 — 18.08.2026")
    W("")
    W("Собрано автоматически из двух экспортов Telegram (основной аккаунт + твинк). "
      "Расставание (13–18.08.2026) в память не включено.")

    # ---------- 1. ЛЮДИ ----------
    head("1. ЛЮДИ — кто есть кто")
    names = collections.Counter()
    name_roles = collections.defaultdict(collections.Counter)
    name_ex = collections.defaultdict(list)
    SOCIAL = {"подруга": "подруга", "подруги": "подруга", "друг": "друг", "друга": "друг", "друзья": "друзья",
              "парень": "парень", "парня": "парень", "мальчик": "мальчик", "одноклассник": "одноклассник",
              "одноклассница": "одноклассница", "брат": "брат", "сестра": "сестра", "мама": "мама", "папа": "папа",
              "тётя": "тётя", "дядя": "дядя", "крёстная": "крёстная", "крестная": "крёстная", "бывшая": "бывшая", "бывший": "бывший"}
    allnames = set(MALE) | set(FEMALE)
    for role, t, ts in msgs:
        for m in re.finditer(r"\b([А-ЯЁ][а-яё]{2,12})\b", t):
            w = m.group(1)
            base = w.rstrip("аяуюеиоы").capitalize()
            if w in allnames or base in allnames:
                key = w
                names[key] += 1
                low = t.lower()
                for k, v in SOCIAL.items():
                    if re.search(r"\b" + k + r"\w*\b", low):
                        name_roles[key][v] += 1
                if len(name_ex[key]) < 3:
                    name_ex[key].append((role, t, ts))
    people_out = []
    for w, n in names.most_common(40):
        roles = ", ".join("%s(%d)" % (k, v) for k, v in name_roles[w].most_common(3)) or "без роли"
        W("**%s** — %d упоминаний · %s" % (w, n, roles))
        for role, t, ts in name_ex[w]:
            q(role, t, ts)
        W("")
        people_out.append({"name": w, "count": n, "roles": [k for k, _ in name_roles[w].most_common(3)],
                           "quotes": [{"date": D(ts), "text": t[:200]} for _, t, ts in name_ex[w]]})
    kb["people"] = people_out

    # ---------- 2. ХРОНИКА ПО МЕСЯЦАМ ----------
    head("2. ХРОНИКА ПО МЕСЯЦАМ")
    by_month = collections.defaultdict(list)
    for role, t, ts in msgs:
        by_month[YM(ts)].append((role, t, ts))
    months_out = []
    for ym in sorted(by_month):
        items = by_month[ym]
        hern = sum(1 for r, _, _ in items if r == "assistant")
        W("### %s — всего %d сообщений (она %d, он %d)" % (ym, len(items), hern, len(items) - hern))
        hits = []
        for title, rx in TOPICS.items():
            pat = re.compile(rx, re.I)
            cnt = sum(1 for r, t, _ in items if r == "assistant" and pat.search(t))
            if cnt >= 5:
                hits.append((cnt, title))
        hits.sort(reverse=True)
        if hits:
            W("Темы: " + ", ".join("%s (%d)" % (t, c) for c, t in hits[:6]))
        # самые «событийные» её сообщения месяца
        scored = []
        for r, t, ts in items:
            if r != "assistant":
                continue
            words = len(t.split())
            if 4 <= words <= 22:
                score = 1 + (words - 4) * 0.2
                if re.search(r"(люблю|скучаю|прости|обидел|поссор|приеду|подар|болит|боюсь|расстат|навсегда|важно)", t, re.I):
                    score += 2
                scored.append((score, ts, t))
        scored.sort(key=lambda x: (-x[0], x[1]))
        seen = set()
        picked = []
        for s, ts, t in scored:
            k = t.lower()[:24]
            if k in seen:
                continue
            seen.add(k)
            picked.append((ts, t))
            if len(picked) >= 4:
                break
        for ts, t in picked:
            q("assistant", t, ts, 160)
        W("")
        months_out.append({"ym": ym, "count": len(items), "her": hern,
                           "topics": [t for _, t in hits[:6]],
                           "quotes": [{"date": D(ts), "text": t[:220]} for ts, t in picked]})
    kb["months"] = months_out

    # ---------- 3. ТЕМЫ ----------
    head("3. ТЕМЫ — что она говорила по каждой")
    topics_out = {}
    for title, rx in TOPICS.items():
        pat = re.compile(rx, re.I)
        items = [(t, ts) for t, ts in her if pat.search(t)]
        W("### %s — %d её сообщений" % (title, len(items)))
        scored = []
        for t, ts in items:
            words = len(t.split())
            if 3 <= words <= 24:
                scored.append((1 + (words - 3) * 0.2 + (1 if re.search(r"[❤💋🫶🥰😭]", t) else 0), ts, t))
        scored.sort(key=lambda x: (-x[0], x[1]))
        seen = set()
        picked = []
        for s, ts, t in scored:
            k = t.lower()[:24]
            if k in seen:
                continue
            seen.add(k)
            picked.append((ts, t))
            if len(picked) >= 12:
                break
        for ts, t in picked:
            W("- `%s` %s" % (D(ts), t[:170]))
        W("")
        topics_out[title] = {"count": len(items), "quotes": [{"date": D(ts), "text": t[:220]} for ts, t in picked]}
    kb["topics"] = topics_out

    # ---------- 4. ЕГО ЖИЗНЬ ----------
    head("4. ЕГО ЖИЗНЬ (по её и его словам)")
    for label, rx in [("учёба, колледж, пары", r"колледж|универ|пары|сесси|диплом|училище"),
                      ("работа и деньги", r"работа|работаю|смена|зарплат|подработ|деньг|рубл|перевёл|перевел"),
                      ("армия", r"арми|военкомат|повестк|служб"),
                      ("его техника: пит, квадрик, машина", r"пит\b|квадрик|машин|мото|байк|права"),
                      ("его семья", r"твоя мама|твоей мамы|твой папа|твоего папы|твоя сестра|твой брат|твои родител"),
                      ("его здоровье", r"ты (боле|забол)|фгс|врач|больниц|аллерг"),
                      ("его друзья", r"друг|друзья|кореш|пацан")]:
        W("### " + label)
        pat = re.compile(rx, re.I)
        items = [(r, t, ts) for r, t, ts in msgs if pat.search(t) and (r == "user" or re.search(r"ты|твой|тебе", t, re.I))]
        for r, t, ts in items[:14]:
            q(r, t, ts)
        W("")

    # ---------- 5. ПОДАРКИ И ДЕНЬГИ ----------
    head("5. ПОДАРКИ, СЮРПРИЗЫ, ДЕНЬГИ")
    pat = re.compile(r"(подар\w*|сюрприз\w*|цвет\w*|букет\w*|перевёл|перевел|скинул\w* деньг|перевод\w*|кошел\w*|на карту)", re.I)
    for r, t, ts in msgs:
        if pat.search(t):
            q(r, t, ts)

    # ---------- 6. ПЛАНЫ ----------
    head("6. ПЛАНЫ: ВСТРЕЧИ, БУДУЩЕЕ")
    pat = re.compile(r"(приеду к тебе|приезжай|встретимся|увидимся|вживую|в живую|жить вместе|свадьб|замуж|дети|ребёнок|ребенок|квартир|переед)", re.I)
    for r, t, ts in msgs:
        if pat.search(t):
            q(r, t, ts)

    # ---------- 7. МУЗЫКА, ФИЛЬМЫ, ИГРЫ ----------
    head("7. МУЗЫКА, ФИЛЬМЫ, СЕРИАЛЫ, ИГРЫ")
    pat = re.compile(r"(песн\w*|трек\w*|музык\w*|исполнител\w*|альбом\w*|фильм\w*|сериал\w*|аниме|мульт\w*|тикток\w*|ютуб\w*|роблокс\w*|бравл\w*|сталкер\w*|гренни|майнкрафт\w*)", re.I)
    for t, ts in her:
        if pat.search(t):
            q("assistant", t, ts)
    latin = collections.Counter()
    for role, t, ts in msgs:
        for w in re.findall(r"\b[A-Z][A-Za-z0-9'&.]{3,}\b", t):
            latin[w] += 1
    W("")
    W("**Латинские названия (исполнители, игры, сервисы):** " + ", ".join("%s(%d)" % (w, n) for w, n in latin.most_common(25)))

    # ---------- 8. ЗДОРОВЬЕ ----------
    head("8. ЕЁ ЗДОРОВЬЕ — эпизоды")
    for t, ts in her:
        if re.search(r"(голов\w* бол\w*|болит голов\w*|тошн\w*|температур\w*|горл\w* бол\w*|живот\w* бол\w*|таблетк\w*|врач\w*|больниц\w*|панич\w*)", t, re.I):
            q("assistant", t, ts)

    # ---------- 9. ВНЕШНОСТЬ ----------
    head("9. ЕЁ ВНЕШНОСТЬ")
    for r, t, ts in msgs:
        if re.search(r"(карие|чёрные волос|черные волос|рост\w* 1\d\d|худая|худеньк\w*|миниатюрн\w*|фигур\w*|стрижк\w*|косичк\w*|брекет\w*)", t, re.I):
            q(r, t, ts)

    # ---------- 10. СЛОВЕЧКИ ----------
    head("10. СЛОВЕЧКИ, ШУТКИ, ПРИВЫЧКИ РЕЧИ")
    wher, whis = collections.Counter(), collections.Counter()
    for t, ts in her:
        for w in re.findall(r"[а-яё]{4,}", t.lower()):
            wher[w] += 1
    for t, ts in his:
        for w in re.findall(r"[а-яё]{4,}", t.lower()):
            whis[w] += 1
    uniq = sorted([(w, n, whis.get(w, 0)) for w, n in wher.items() if n >= 25], key=lambda x: -(x[1] / (x[2] + 3)))[:35]
    for w, n, o in uniq:
        W("- **%s** — она %d, он %d" % (w, n, o))
    W("")
    jokes = {}
    for label, rx in [("лошади", r"лошад\w*"), ("пит и квадрик", r"\bпит\b|квадрик\w*|квадроцикл\w*"),
                      ("мууж", r"муу+ж"), ("игра в имя", r"не вика|какая вика|я вика|виктория"),
                      ("«обойдешься»", r"обойдешься"), ("«приплыли»", r"приплыли")]:
        W("### Шутка: %s" % label)
        pat = re.compile(rx, re.I)
        ex = [(r, t, ts) for r, t, ts in msgs if pat.search(t)][:6]
        for r, t, ts in ex:
            q(r, t, ts)
        W("")
        jokes[label] = [{"date": D(ts), "text": t[:200]} for _, t, ts in ex]
    kb["jokes"] = jokes
    kb["uniqueWords"] = [{"word": w, "her": n, "him": o} for w, n, o in uniq]

    # ---------- 11. ЕЁ ЛУЧШИЕ ФРАЗЫ ----------
    head("11. ЕЁ ЛУЧШИЕ ФРАЗЫ (по одной на каждую тему/эмоцию)")
    best = collections.defaultdict(list)
    for t, ts in her:
        words = len(t.split())
        if not (4 <= words <= 18):
            continue
        for key, rx in [("нежность", r"люблю|обнимаю|целую|скучаю"),
                        ("злость", r"дурак|обойдешься|хватит|бесит|отстань|нафиг"),
                        ("обида", r"обиделась|игнор|не пишу|зачем ты"),
                        ("радость", r"ура|круто|кайф|вау|наконец"),
                        ("школа", r"школ|урок|экзамен"),
                        ("тренировка", r"тренировк|танц|похуде"),
                        ("семья", r"мама|малой|бабушк|отчим"),
                        ("кот", r"кот|коть|котик|котёнок"),
                        ("сон", r"спать|сплю|выспал"),
                        ("еда", r"сырник|банан|кофе|куша|чипсик"),
                        ("ревность", r"ревну|с кем|кто это"),
                        ("здоровье", r"голов|болит|тошн|устала")]:
            if re.search(rx, t, re.I) and len(best[key]) < 12:
                best[key].append((ts, t))
    for key in best:
        W("### " + key)
        for ts, t in best[key]:
            W("- `%s` %s" % (D(ts), t[:170]))
        W("")
    kb["bestPhrases"] = {k: [{"date": D(ts), "text": t[:220]} for ts, t in v] for k, v in best.items()}

    text = "\n".join(md) + "\n"
    with open(os.path.join(HERE, "knowledge-base.md"), "w", encoding="utf-8") as f:
        f.write(text)
    blob = json.dumps(kb, ensure_ascii=False, separators=(",", ":"))
    dst = os.path.join(ROOT, "archive", "masha-kb.json.gz")
    with open(dst, "wb") as f:
        f.write(gzip.compress(blob.encode("utf-8"), 9))
    print("knowledge-base.md: %d строк, %.0f КБ" % (len(md), os.path.getsize(os.path.join(HERE, "knowledge-base.md")) / 1024))
    print("masha-kb.json.gz: %.0f КБ" % (os.path.getsize(dst) / 1024))
    print("людей: %d | месяцев: %d | тем: %d | шуток: %d" % (len(people_out), len(months_out), len(topics_out), len(jokes)))


if __name__ == "__main__":
    main()
