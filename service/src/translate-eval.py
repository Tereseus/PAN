"""Score the live hub translator on the held-out Tatoeba phrases (the baseline before fine-tuning).

Calls the running service (127.0.0.1:7784, the same path PAN uses) one line at a time, English
to each language and back, on test-split lines only. chrF as in bench.py.

Usage (hub): python -I translate-eval.py --phrases FILE --langs el,ja,es --per 100 --out res.json
  --model DIR loads that model in this process instead (the translate venv's python).
"""
import argparse
import collections
import json
import os
import statistics
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ap = argparse.ArgumentParser()
ap.add_argument("--phrases", required=True)
ap.add_argument("--langs", required=True, help="comma list, or 'all' for every language with --per test lines")
ap.add_argument("--per", type=int, default=100, help="test lines per direction")
ap.add_argument("--port", type=int, default=7784)
ap.add_argument("--model", help="load this model in-process instead of calling the service")
ap.add_argument("--server", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "translate-server.py"))
ap.add_argument("--threads", type=int, default=4)
ap.add_argument("--out", required=True)
a = ap.parse_args()


def chrf(hyp, ref, n=6, beta=2.0):
    h, r = "".join(str(hyp).split()), "".join(str(ref).split())
    if not h or not r:
        return 0.0
    precs, recs = [], []
    for k in range(1, n + 1):
        hg = collections.Counter(h[i:i + k] for i in range(len(h) - k + 1))
        rg = collections.Counter(r[i:i + k] for i in range(len(r) - k + 1))
        if not hg or not rg:
            continue
        match = sum((hg & rg).values())
        precs.append(match / sum(hg.values()))
        recs.append(match / sum(rg.values()))
    if not precs:
        return 0.0
    p, rc = sum(precs) / len(precs), sum(recs) / len(recs)
    return 0.0 if p + rc == 0 else round(100 * (1 + beta ** 2) * p * rc / (beta ** 2 * p + rc), 1)


ENGINE = None


def translate(text, src, tgt):
    if ENGINE:
        return ENGINE.translate(text, src, tgt)  # the server's own defaults per model
    body = json.dumps({"text": text, "src": src, "tgt": tgt}).encode("utf-8")
    req = urllib.request.Request(f"http://127.0.0.1:{a.port}/translate", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))["text"]


if a.model:
    import importlib.util
    spec = importlib.util.spec_from_file_location("translate_server", a.server)
    ts = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ts)
    ENGINE = ts.Engine(a.model, threads=a.threads)
    info = {"kind": ENGINE.kind, "model": a.model, "in_process": True, "threads": a.threads}
else:
    with urllib.request.urlopen(f"http://127.0.0.1:{a.port}/", timeout=10) as r:
        info = json.loads(r.read().decode("utf-8"))
print("service:", info, flush=True)

test = [json.loads(l) for l in open(a.phrases, encoding="utf-8")]
test = [c for c in test if c["split"] == "test"]
have = collections.Counter(l for c in test for l in c["tr"])
langs = [l for l, n in have.most_common() if n >= a.per] if a.langs == "all" else a.langs.split(",")
print(f"{len(test)} test concepts; languages: {', '.join(f'{l} {have[l]}' for l in langs)}", flush=True)

result = {"service": info, "per": a.per, "dirs": {}}
t0 = time.time()
for lang in langs:
    lines = [c for c in test if lang in c["tr"]][:a.per]
    for src, tgt in (("en", lang), (lang, "en")):
        rows, ms = [], []
        for c in lines:
            # Into the language: scored against its best reference. Out of it: its first line.
            refs = c["tr"][lang]
            text, ref = (c["en"], refs) if src == "en" else (refs[0], [c["en"]])
            t = time.time()
            try:
                out = translate(text, src, tgt)
            except Exception as e:
                out = f"ERROR {type(e).__name__}: {e}"
            ms.append(round((time.time() - t) * 1000))
            rows.append({"id": c["id"], "cat": c["cat"], "text": text, "ref": ref, "out": out, "chrf": max(chrf(out, r) for r in ref)})
        d = f"{src}-{tgt}"
        result["dirs"][d] = {"n": len(rows), "chrf": round(statistics.mean(r["chrf"] for r in rows), 1) if rows else None,
                             "median_ms": statistics.median(ms) if ms else None, "rows": rows}
        print(f"{d:6} n={len(rows):3} chrF {result['dirs'][d]['chrf']}  median {result['dirs'][d]['median_ms']} ms  ({time.time() - t0:.0f}s)", flush=True)
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
print("wrote", a.out)
