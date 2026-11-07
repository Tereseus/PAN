"""The hub's own translator (steward service "translate", port 7784).

The interpreter's fallback when the cloud model stalls or is out of quota (router.js
interpretStream, translate-local.js). Runs a CTranslate2 model on the CPU. Only models whose
licence allows commercial use (docs/INTUITION-STATE-ENGINE.md step 1):

  madlad  MADLAD-400 (Apache 2.0), a model folder with spiece.model, e.g. the int8 build
          Nextcloud ships in its own translation app
  m2m     M2M-100 (MIT), a model folder with spm.128k.model and shared_vocabulary.txt

Beside that one model, every quickmt-<src>-<tgt> folder next to it (quickmt, CC-BY-4.0, credit
them) answers its own direction first. See Pairs.

The kind is read from the folder. Languages are ISO 639-1 ("en", "el", "ja"). With MADLAD, an
installed M2M also runs as its referee: M2M rarely adds words, so a MADLAD line that runs far
past M2M's is cut back (referee_check). --referee none turns that off.

  GET  /            {"ok": true, "status": "ok", "kind": ..., "model": ...}  (503 while loading)
  POST /translate   {"text", "src", "tgt", "beam"?}  ->  {"text", "ms"}

Lessons from NLLB-200 on this hub (2026-11-03, removed for its licence):
  - Never set CT2_USE_MKL=1: it ran 50x slower on the Ryzen 5800H.
  - Python's HTTPServer sets SO_REUSEADDR, which on Windows lets a second copy bind the same
    port and steal half the requests. The socket is bound exclusively, before the model
    loads, so a second copy exits at once.

Usage: python -I translate-server.py --model DIR [--port 7784] [--threads 4] [--beam N]
"""
import argparse
import json
import os
import re
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.environ.pop("CT2_USE_MKL", None)

# Scripts with no spaces between words: split on their own full stops, never on ". ".
CJK = {"ja", "zh", "ko", "th", "lo", "km", "my"}
SENTENCE_END = re.compile(r"(?<=[.!?;])\s+(?=\S)")
CJK_END = re.compile(r"(?<=[。！？])")


def split_sentences(text, lang):
    text = text.strip()
    if not text:
        return []
    parts = CJK_END.split(text) if lang in CJK else SENTENCE_END.split(text)
    return [p.strip() for p in parts if p.strip()]


def _terminators(lang):
    # Greek asks with ";" (and U+037E); elsewhere a ";" is mid-sentence. "؟" is Arabic's "?".
    return r"[.!?。！？؟;;]" if lang == "el" else r"[.!?。！？؟]"


def keep_sentences(out, src_sentence, src, tgt):
    """MADLAD was trained on web pages and keeps writing: "Please wait a moment." came back with
    "We'll get back to you shortly." So an output keeps as many sentences as its source had."""
    n = max(1, len(re.findall(_terminators(src) + r"+", src_sentence)))
    count = 0
    for m in re.finditer(_terminators(tgt) + r"+[\"'”’)\]」』]*", out):
        count += 1
        if count >= n:
            return out[:m.end()].strip()
    return out.strip()


# The words that join a tacked-on clause ("...κάθε ημέρα και μιλάω πολύ καλά.").
CONJ = {"en": "and|but|so", "el": "και|αλλά", "es": "y|pero", "it": "e|ma", "fr": "et|mais", "de": "und|aber",
        "tr": "ve|ama", "ru": "и|а|но", "uk": "і|та|а|але", "bg": "и|а|но", "pt": "e|mas", "nl": "en|maar", "pl": "i|ale"}


def _clause_marks(lang):
    # Greek's ";" asks a question (a sentence end, keep_sentences' job); elsewhere it joins clauses.
    punct = r"[,،，、–—　]" if lang == "el" else r"[,،，、;；–—　]"
    conj = CONJ.get(lang)
    return rf"\s*{punct}\s*" + (rf"|\s+(?:{conj})\s+" if conj else "")


# Median characters in a line of each language for one character of English (Tatoeba train split).
LEN_VS_EN = {"ar": 0.8, "az": 0.96, "be": 0.96, "bg": 0.95, "bn": 1.0, "cs": 0.88, "da": 1.0, "de": 1.15, "el": 1.06,
             "en": 1.0, "es": 1.04, "et": 0.92, "fa": 0.93, "fi": 1.03, "fr": 1.18, "he": 0.78, "hi": 1.04, "hu": 0.97,
             "hy": 1.0, "id": 1.07, "is": 1.05, "it": 1.1, "ja": 0.5, "ko": 0.5, "lt": 1.0, "lv": 1.07, "mk": 0.95,
             "mr": 0.96, "nl": 1.08, "no": 1.0, "pl": 1.0, "pt": 1.06, "ro": 1.0, "ru": 1.0, "sk": 0.88, "sl": 0.91,
             "sr": 1.0, "sv": 1.0, "th": 0.85, "tl": 1.15, "tr": 0.95, "uk": 0.97, "vi": 1.0, "zh": 0.32, "yue": 0.32}


def referee_check(out, alt, src_sentence, src, tgt):
    """MADLAD's extra clause ("My name is Andrea, I'm 18 years old."): M2M adds words to 0.9% of
    everyday lines against MADLAD's 9.5%, so when MADLAD's line runs well past both M2M's and the
    length the source would make, it is cut at the comma, dash or "and" nearest M2M's length.
    On 2,400 held-out lines that took overruns from 9.5% to 2.2% and chrF from 75.1 to 76.5.

    M2M drops words itself ("Excuse me, where is the bathroom?" -> "Πού είναι το μπάνιο;", and
    "please" often), so a referee line much shorter than the source would make is no judge, and
    MADLAD's line is never swapped for M2M's: on his bench that turned "温めますか？" into "Is it
    warm?" and cut "s'il vous plaît" off "Please speak more slowly.", 2026-11-04."""
    n = len(alt)
    expected = len(src_sentence) * LEN_VS_EN.get(tgt, 1.0) / LEN_VS_EN.get(src, 1.0)
    if not n or n < 0.6 * expected or len(out) <= 1.3 * n + 6 or len(out) <= 1.4 * expected:
        return out
    best = None
    for m in re.finditer(_clause_marks(tgt), out):
        head = out[:m.start()].rstrip()
        if 0.6 * n <= len(head) <= 1.4 * n + 3 and (best is None or abs(len(head) - n) < abs(len(best) - n)):
            best = head
    if best is None:
        return out
    end = re.search(_terminators(tgt) + r"+[\"'”’)\]」』]*$", out)
    return best + end.group(0) if end and not re.search(_terminators(tgt) + r"$", best) else best


class Engine:
    """One CTranslate2 translator and its tokenizer. Thread safe for translate_batch."""

    def __init__(self, model_dir, threads=4):
        import ctranslate2
        import sentencepiece as spm

        self.model_dir = model_dir
        self.referee = None   # a second Engine (M2M) that checks MADLAD's length, see referee_check
        if os.path.exists(os.path.join(model_dir, "spiece.model")):
            self.kind = "madlad"
            self.sp = spm.SentencePieceProcessor(model_file=os.path.join(model_dir, "spiece.model"))
        elif os.path.exists(os.path.join(model_dir, "spm.128k.model")):
            self.kind = "m2m"
            self.sp = spm.SentencePieceProcessor(model_file=os.path.join(model_dir, "spm.128k.model"))
        else:
            raise SystemExit(f"no known tokenizer in {model_dir} (want spiece.model or spm.128k.model)")
        self.vocab = self._vocab()
        t = time.time()
        self.tr = ctranslate2.Translator(model_dir, device="cpu", compute_type="int8",
                                         intra_threads=threads, inter_threads=1)
        self.load_s = round(time.time() - t, 2)

    def _vocab(self):
        for name in ("shared_vocabulary.json", "shared_vocabulary.txt"):
            p = os.path.join(self.model_dir, name)
            if not os.path.exists(p):
                continue
            with open(p, encoding="utf-8") as f:
                if name.endswith(".json"):
                    return set(json.load(f))
                return {line.rstrip("\n") for line in f}
        return set()

    def tag(self, lang):
        """The token that names a language, or None if the model does not have it."""
        t = f"<2{lang}>" if self.kind == "madlad" else f"__{lang}__"
        return t if (not self.vocab or t in self.vocab) else None

    # Nextcloud runs MADLAD with a repetition penalty of 1.3; M2M needs none.
    DEFAULT_RP = {"madlad": 1.3, "m2m": 1.0}
    # MADLAD keeps writing after short lines: "Good evening." came back "Καλησπέρα, καλημέρα.",
    # on 9.5% of the held-out everyday phrases (M2M 0.9%). Beam 4 with no length bonus
    # (length_penalty 0) cut those overruns by half and scored higher on the lines it already
    # got right, at the same speed (2026-11-04).
    DEFAULT_BEAM = {"madlad": 4, "m2m": 2}
    DEFAULT_LP = {"madlad": 0.0, "m2m": 1.0}

    def translate(self, text, src, tgt, beam=None, repetition_penalty=None, length_penalty=None):
        sentences = split_sentences(text, src) or [text]
        out = self._sentences(sentences, src, tgt, beam, repetition_penalty, length_penalty)
        if self.referee is not None:
            try:
                alt = self.referee._sentences(sentences, src, tgt)
                out = [referee_check(o, a, s, src, tgt) for o, a, s in zip(out, alt, sentences)]
            except ValueError:   # the referee lacks one of the two languages
                pass
        joiner = "" if tgt in CJK else " "
        return joiner.join(o for o in out if o)

    def _sentences(self, sentences, src, tgt, beam=None, repetition_penalty=None, length_penalty=None):
        tgt_tag = self.tag(tgt)
        if not tgt_tag:
            raise ValueError(f"model has no language {tgt}")
        if self.kind == "madlad":
            # T5 style: the target tag leads the source, the source language is not named. Encode
            # the tag WITH the text, the way Nextcloud's app does: sentencepiece then puts a lone
            # "▁" before the tag, and without it the model babbles ("Πό, Π , Π. Π."), 2026-11-04.
            # No "</s>" either (Nextcloud adds none; with it one Japanese line went wrong).
            batch = [self.sp.encode(f"{tgt_tag} {s}", out_type=str) for s in sentences]
            prefix = None
        else:
            src_tag = self.tag(src)
            if not src_tag:
                raise ValueError(f"model has no language {src}")
            batch = [[src_tag] + self.sp.encode(s, out_type=str) + ["</s>"] for s in sentences]
            prefix = [[tgt_tag]] * len(batch)
        longest = max(len(b) for b in batch)
        rp = self.DEFAULT_RP[self.kind] if repetition_penalty is None else repetition_penalty
        beam = self.DEFAULT_BEAM[self.kind] if beam is None else beam
        lp = self.DEFAULT_LP[self.kind] if length_penalty is None else length_penalty
        res = self.tr.translate_batch(batch, target_prefix=prefix, beam_size=beam, length_penalty=lp,
                                      max_decoding_length=min(256, longest * 2 + 10),
                                      repetition_penalty=rp, disable_unk=True)
        out = []
        for s, r in zip(sentences, res):
            toks = [t for t in r.hypotheses[0] if t != tgt_tag]
            out.append(keep_sentences(self.sp.decode(toks).strip(), s, src, tgt))
        return out


class Pairs:
    """quickmt: one small model for each direction (185M, 8 encoder and 2 decoder layers), in
    quickmt-<src>-<tgt> folders beside the main model. One line takes 40 ms on 4 threads where
    MADLAD took 1.2 to 2.7 s, and on everyday lines they beat MADLAD and M2M on facts: M2M changed
    the country in a "from <country>" line to Japan and 7 in the evening to 7 a.m., MADLAD dropped half of a
    sentence (service/src/evals/translate, 2026-11-05). No language tags: the folder is the pair.
    Two languages neither of which is English go through English."""

    BEAM = 4   # 36 of 36 facts into Japanese against 34 with beam 1, for 8 ms more

    def __init__(self, folder, threads=4):
        import ctranslate2
        import sentencepiece as spm

        self.models = {}
        for name in sorted(os.listdir(folder)):
            m = re.fullmatch(r"quickmt-([a-z]+)-([a-z]+)", name)
            d = os.path.join(folder, name)
            if not m or not all(os.path.exists(os.path.join(d, f)) for f in ("model.bin", "src.spm.model", "tgt.spm.model")):
                continue
            # A download in progress is not a model: wait until the file has stopped growing.
            if time.time() - os.path.getmtime(os.path.join(d, "model.bin")) < 120:
                continue
            try:
                tr = ctranslate2.Translator(d, device="cpu", compute_type="int8", intra_threads=threads, inter_threads=1)
                self.models[(m[1], m[2])] = (
                    tr,
                    spm.SentencePieceProcessor(model_file=os.path.join(d, "src.spm.model")),
                    spm.SentencePieceProcessor(model_file=os.path.join(d, "tgt.spm.model")),
                )
            except Exception as e:
                print(f"[translate] {name} did not load: {e}", flush=True)

    def names(self):
        return sorted(f"{s}-{t}" for s, t in self.models)

    def can(self, src, tgt):
        return (src, tgt) in self.models or ((src, "en") in self.models and ("en", tgt) in self.models)

    def _direct(self, text, src, tgt, beam):
        tr, src_sp, tgt_sp = self.models[(src, tgt)]
        if src in ("ja", "zh", "yue"):
            text = text.replace(" ", "")   # SenseVoice's spaces: nobody writes Japanese that way
        sentences = split_sentences(text, src) or [text]
        batch = [src_sp.encode(s, out_type=str) for s in sentences]
        res = tr.translate_batch(batch, beam_size=beam or self.BEAM, disable_unk=True,
                                 max_decoding_length=min(256, max(len(b) for b in batch) * 2 + 10))
        out = [tgt_sp.decode(r.hypotheses[0]).strip() for r in res]
        return ("" if tgt in CJK else " ").join(o for o in out if o)

    def translate(self, text, src, tgt, beam=None):
        if (src, tgt) in self.models:
            return self._direct(text, src, tgt, beam)
        return self._direct(self._direct(text, src, "en", beam), "en", tgt, beam)


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_handler(engine, default_beam, pairs):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.split("?")[0] != "/":
                return self._send(404, {"ok": False})
            if engine[0] is None:
                return self._send(503, {"ok": False, "loading": True})
            # status: the steward's "already serving, reuse it" check reads this field.
            ref = engine[0].referee
            self._send(200, {"ok": True, "status": "ok", "kind": engine[0].kind,
                             "model": os.path.basename(engine[0].model_dir.rstrip("\\/")),
                             "referee": os.path.basename(ref.model_dir.rstrip("\\/")) if ref else None,
                             "pairs": pairs[0].names() if pairs[0] else []})

        def do_POST(self):
            if self.path != "/translate":
                return self._send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(n) or b"{}")
                text, src, tgt = str(req.get("text") or "").strip(), str(req.get("src") or ""), str(req.get("tgt") or "")
                if not text or not src or not tgt:
                    return self._send(400, {"error": "text, src and tgt are required"})
                t = time.time()
                if pairs[0] and pairs[0].can(src, tgt):
                    out = pairs[0].translate(text, src, tgt, beam=int(req["beam"]) if req.get("beam") else None)
                    return self._send(200, {"text": out, "ms": round((time.time() - t) * 1000), "via": "quickmt"})
                if engine[0] is None:
                    return self._send(503, {"error": "loading"})
                beam = req.get("beam") or default_beam
                out = engine[0].translate(text, src, tgt, beam=int(beam) if beam else None)
                self._send(200, {"text": out, "ms": round((time.time() - t) * 1000), "via": engine[0].kind})
            except ValueError as e:
                self._send(422, {"error": str(e)})
            except Exception as e:  # never take the service down on one bad line
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--port", type=int, default=7784)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--beam", type=int, default=None, help="default: per model, MADLAD 4, M2M 2")
    ap.add_argument("--referee", default="auto",
                    help="M2M folder that checks MADLAD's length; auto = m2m100-418m-ct2-int8 beside the model, none = off")
    a = ap.parse_args()

    engine = [None]
    pairs = [None]
    try:
        httpd = Server(("127.0.0.1", a.port), make_handler(engine, a.beam, pairs))
    except OSError as e:
        print(f"[translate] port {a.port} is taken ({e}); another copy is running", flush=True)
        sys.exit(0)
    import threading
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    pairs[0] = Pairs(os.path.dirname(os.path.abspath(a.model)))
    print(f"[translate] pairs: {' '.join(pairs[0].names()) or 'none'}", flush=True)
    eng = Engine(a.model, threads=a.threads)
    if eng.kind == "madlad" and a.referee != "none":
        path = (os.path.join(os.path.dirname(os.path.abspath(a.model)), "m2m100-418m-ct2-int8")
                if a.referee == "auto" else a.referee)
        if os.path.exists(os.path.join(path, "model.bin")):
            eng.referee = Engine(path, threads=4)
    engine[0] = eng
    print(f"[translate] {eng.kind} {a.model} loaded in {eng.load_s}s"
          f"{', referee ' + eng.referee.model_dir if eng.referee else ''}, serving :{a.port}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
