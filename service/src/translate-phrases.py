"""Build PAN's interpreter phrase set from Tatoeba (CC BY 2.0 FR, credit: tatoeba.org).

Everyday lines a traveller says or hears (shop, food, transport, hotel, directions, health and
emergency, small talk, and what staff say back), each with its translations in every language
we keep, so any language pairs with any other through the shared English line. Lines are
split into train and a held-out test set by concept, so a test line's meaning never appears
in training in any language.

Streams the .tar.bz2 exports three times (no full corpus in memory):
  1. English candidates by category and length
  2. links from those candidates to their translations
  3. the text of those translations, in the kept languages

Usage (hub): python -I translate-phrases.py --tatoeba DIR --out DIR [--per-cat 600] [--test 0.1]
  DIR is <PAN local>/translate/data/tatoeba (sentences.tar.bz2, links.tar.bz2 from
  tatoeba.org/downloads); out is <PAN local>/translate/data/phrases (phrases.jsonl, summary.json).
"""
import argparse
import collections
import csv
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
csv.field_size_limit(10_000_000)

# Tatoeba's ISO 639-3 codes -> the ISO 639-1 codes PAN and both models use. Only languages
# M2M-100 and MADLAD-400 both have.
LANGS = {
    "ell": "el", "jpn": "ja", "spa": "es", "fra": "fr", "deu": "de", "ita": "it", "por": "pt",
    "rus": "ru", "cmn": "zh", "kor": "ko", "tur": "tr", "ara": "ar", "heb": "he", "hin": "hi",
    "nld": "nl", "pol": "pl", "swe": "sv", "fin": "fi", "dan": "da", "nob": "no", "ukr": "uk",
    "ces": "cs", "hun": "hu", "ron": "ro", "bul": "bg", "srp": "sr", "hrv": "hr", "vie": "vi",
    "tha": "th", "ind": "id", "zsm": "ms", "tgl": "tl", "pes": "fa", "urd": "ur", "ben": "bn",
    "cat": "ca", "glg": "gl", "eus": "eu", "slk": "sk", "slv": "sl", "lit": "lt", "lvs": "lv",
    "est": "et", "isl": "is", "gle": "ga", "cym": "cy", "mkd": "mk", "sqi": "sq", "bel": "be",
    "kat": "ka", "hye": "hy", "aze": "az", "kaz": "kk", "uzb": "uz", "mar": "mr", "tam": "ta",
    "tel": "te", "kan": "kn", "mal": "ml", "guj": "gu", "pan": "pa", "nep": "ne", "sin": "si",
    "khm": "km", "mya": "my", "lao": "lo", "mon": "mn", "swh": "sw", "afr": "af", "amh": "am",
    "yor": "yo", "zul": "zu", "xho": "xh", "hau": "ha", "som": "so", "bos": "bs", "lat": None,
}
LANGS = {k: v for k, v in LANGS.items() if v}

CATS = {
    "shop": r"\b(?:how much|price|cost|costs|buy|pay|card|cash|receipt|bag|size|cheaper|discount|change|store|shop|sell|sold out|try (?:it|this) on|expensive)\b",
    "food": r"\b(?:menu|order|eat|drink|water|coffee|tea|beer|wine|bill|check, please|table|reservation|vegetarian|allergic|spicy|delicious|restaurant|breakfast|lunch|dinner|hungry|thirsty|waiter|dessert|meat|fish|chicken|bread|salt)\b",
    "transport": r"\b(?:train|station|bus|ticket|taxi|airport|flight|platform|metro|subway|terminal|gate|luggage|suitcase|passport|seat|leave|arrive|departure|delayed|car|drive|ride)\b",
    "hotel": r"\b(?:room|hotel|key|check in|check out|booked|towel|wi-?fi|shower|elevator|lift|floor|breakfast included|stay|night)\b",
    "directions": r"\b(?:where is|where's|where are|how do i get|turn (?:left|right)|straight|corner|street|address|near here|far from|map|lost|left|right|next to|across from|block)\b",
    "health": r"\b(?:help|doctor|hospital|pharmacy|police|sick|hurt|pain|fever|medicine|emergency|ambulance|accident|stolen|headache|dizzy|injured|bleeding|call the)\b",
    "talk": r"\b(?:hello|good morning|good evening|good night|thank you|thanks|please|sorry|excuse me|nice to meet you|my name is|what's your name|where are you from|i'm from|how are you|see you|goodbye|i don't understand|speak (?:english|slowly)|slowly|repeat|what does .{1,20} mean|can you help me|welcome|of course|no problem|i'm (?:tired|hungry|cold|hot|lost))\b",
    "time": r"\b(?:what time|today|tomorrow|yesterday|open|closed|minutes|hours|o'clock|morning|evening|weekend|when does)\b",
}
CAT_RES = {k: re.compile(v, re.I) for k, v in CATS.items()}
# Tatoeba's stock characters make lines nobody says to a shopkeeper; names in general too.
NAMES = re.compile(r"\b(?:Tom|Mary|John|Alice|Bob|Mike|Jim|Ken|Tony|Jack|Bill|Mr|Mrs|Ms)\b")


def stream(path, member_suffix):
    """Yield csv rows of the one .csv inside a .tar.bz2."""
    with tarfile.open(path, "r:bz2") as tar:
        for m in tar:
            if m.name.endswith(member_suffix):
                f = io.TextIOWrapper(tar.extractfile(m), encoding="utf-8", errors="replace", newline="")
                for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
                    yield row
                return
    raise SystemExit(f"{member_suffix} not found in {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tatoeba", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--per-cat", type=int, default=600)
    ap.add_argument("--test", type=float, default=0.1)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    sent_path = os.path.join(a.tatoeba, "sentences.tar.bz2")
    link_path = os.path.join(a.tatoeba, "links.tar.bz2")
    t0 = time.time()

    # 1. English candidates.
    cand = {}
    for row in stream(sent_path, "sentences.csv"):
        if len(row) < 3 or row[1] != "eng":
            continue
        text = row[2].strip()
        words = len(text.split())
        if words < 2 or words > 12 or NAMES.search(text) or not re.search(r"[.?!]$", text):
            continue
        cats = [c for c, r in CAT_RES.items() if r.search(text)]
        if cats:
            cand[int(row[0])] = {"en": text, "cats": cats}
    print(f"1. {len(cand)} English candidates ({time.time() - t0:.0f}s)", flush=True)

    # 2. Their translation links.
    links = collections.defaultdict(set)
    for row in stream(link_path, "links.csv"):
        if len(row) < 2:
            continue
        x, y = int(row[0]), int(row[1])
        if x in cand:
            links[x].add(y)
    wanted = set().union(*links.values()) if links else set()
    print(f"2. {len(links)} candidates with links, {len(wanted)} linked sentences ({time.time() - t0:.0f}s)", flush=True)

    # 3. The translations' text, kept languages only.
    text_of = {}
    for row in stream(sent_path, "sentences.csv"):
        if len(row) < 3:
            continue
        sid = int(row[0])
        if sid in wanted and row[1] in LANGS:
            text_of[sid] = (LANGS[row[1]], row[2].strip())
    print(f"3. {len(text_of)} translations in kept languages ({time.time() - t0:.0f}s)", flush=True)

    # Concepts: an English line with every translation it has, per language, shortest first.
    # All of them: the shortest alone was often casual or dialect ("おおきに！" for "Thank you!"),
    # and a test line is scored against its best match.
    concepts = []
    for sid, c in cand.items():
        tr = collections.defaultdict(set)
        for y in links.get(sid, ()):
            if y in text_of:
                lang, t = text_of[y]
                tr[lang].add(t)
        tr = {lang: sorted(ts, key=lambda t: (len(t), t)) for lang, ts in tr.items()}
        if len(tr) >= 3:
            concepts.append({"id": sid, "cats": c["cats"], "en": c["en"], "tr": tr})

    # The most translated lines per category first: they are the most common things said.
    concepts.sort(key=lambda c: -len(c["tr"]))
    picked, per = [], collections.Counter()
    for c in concepts:
        cat = min(c["cats"], key=lambda k: per[k])
        if per[cat] < a.per_cat:
            per[cat] += 1
            c["cat"] = cat
            picked.append(c)

    # Held out by concept, stable across runs.
    for c in picked:
        h = int(hashlib.sha1(str(c["id"]).encode()).hexdigest(), 16) % 1000
        c["split"] = "test" if h < a.test * 1000 else "train"

    by_lang = collections.Counter(l for c in picked for l in c["tr"])
    with open(os.path.join(a.out, "phrases.jsonl"), "w", encoding="utf-8") as f:
        for c in picked:
            f.write(json.dumps({k: c[k] for k in ("id", "cat", "split", "en", "tr")}, ensure_ascii=False) + "\n")
    summary = {
        "source": "Tatoeba (tatoeba.org), CC BY 2.0 FR",
        "concepts": len(picked), "test": sum(c["split"] == "test" for c in picked),
        "per_cat": dict(per), "languages": len(by_lang),
        "lines_per_language": dict(by_lang.most_common()),
        "seconds": round(time.time() - t0),
    }
    with open(os.path.join(a.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in summary.items() if k != "lines_per_language"}, ensure_ascii=False), flush=True)
    print("top languages:", ", ".join(f"{k} {v}" for k, v in by_lang.most_common(25)))


if __name__ == "__main__":
    main()
