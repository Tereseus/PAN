# The PAN Conversation Calculus

**Formal notation for how PAN decides, turn by turn, whether to speak, what it knows, and how it words it.**

Status: specification, v0.1, 2026-11-22. Written in the style of the Elipsis Calculus. Nothing here
is built yet; the plan of work is `CONVERSATION-ODDS-PLAN.md`.

---

## 0. The one idea

A language model already does arithmetic on every word: it holds odds over every word it could say
next. Conversation goes wrong when we throw those odds away and ask the model to *write* a
judgement instead, or when we bolt a rule on for each bad answer.

So PAN does not ask the model what it thinks. It reads the odds, adds the situation, and decides by
arithmetic. The values enter in one small object, the cost vector `c`, which is the owner's and
nobody else's:

> **Personality is the argument about `c`. Everything else is arithmetic, and the arithmetic is
> scored against what he actually did next.**

---

## 1. Notation is composed, not invented

| Layer | Borrowed from | What it does here |
|---|---|---|
| The model's word odds | softmax language models | `P_θ(next word)`: the raw material |
| Who a line is for | Bayesian filtering in log odds | evidence adds up line by line, and fades |
| How sure it is | Shannon information theory (entropy, surprisal) | spread odds on a fact = guessing |
| Speak or not | Bayes decision rule, expected cost | one bar, set by the costs |
| Fitting and scoring | logistic regression, proper scoring rules (log loss) | weights earned on his real turns |
| Which model round | prediction with expert advice, multiplicative weights | rounds earn trust by track record |

---

## 2. Primitives

| Symbol | Type | Meaning |
|---|---|---|
| `t` | | a turn: one line he (or someone) said |
| `x_t` | words | the line heard |
| `h_t` | words | the talk so far, including PAN's own lines |
| `s_t` | facts | the situation (Intuition's world): place, people, voice, time since PAN spoke, music, dictating, mode. Each fact has a source, a confidence and a fade |
| `θ` | model | the voice model (a Syrinx round) |
| `P_θ(v given h_t, x_t)` | distribution | the odds of every word `v` the model could say next |
| `z_t ∈ {pan, room}` | hidden | who the line is really for. Never observed directly |
| `φ(s_t)` | ℝᵈ | the situation turned into numbers |
| `β` | ℝᵈ | weights on those numbers. **Earned on his turns, never set by hand** |
| `c = (c_I, c_M, c_H, c_G, c_L, c_R)` | costs | talking over him, missing him, holding, guessing, the wait for a lookup, repeating itself. **His values. The machine has no vote** |
| `𝒞` | set | hard rules: lexically prior, never traded for anything |
| `ℬ` | set | the turn book: every real turn, what PAN saw, what it did, what he did next |

---

## 3. The five questions

Every turn decomposes into the same five, as in Elipsis.

| # | Question | Operation | Who may contest it |
|---|---|---|---|
| **Q1** | Where are we? | the situation `s_t` | the sensors and his corrections |
| **Q2** | What do the words say? | the model's odds `P_θ` | a better model round |
| **Q3** | What does he care about, and how much? | the costs `c` | **him only** |
| **Q4** | So speak, hold or stay quiet, and with what words? | a derivation | nobody |
| **Q5** | Were we right? | proper scoring on the turn book | what he did next |

Most bad conversation fixes so far mixed these up: a rule about *his preferences* (Q3) written as
if it were a fact about *the words* (Q2), like "after PAN speaks, the next line is for PAN".

---

## 4. Q2: the evidence in the words

The model is asked to start its reply with who it is talking to. Read the odds of that one word:

```
ℓ_t = log P_θ("pan" given h_t, x_t) − log P_θ("room" given h_t, x_t)
```

`ℓ_t` is the words' evidence, in log odds. Positive means the words point at PAN.

---

## 5. Q1 + Q2: the belief, one running number

The situation and the words are added in log odds, and the last turn's belief carries over but
fades with the time between lines `Δt`:

```
L_t = β₀ + β_ℓ · ℓ_t + βᵀ φ(s_t) + e^(−Δt/τ) · (L_{t−1} − β₀)

p_t = σ(L_t) = 1 / (1 + e^(−L_t))
```

`p_t` is the probability that line `t` is for PAN.

- Evidence **adds**. "PAN just spoke" is one term, with a weight. "Okay Google" or dictating is
  another, with its own weight, and it can outweigh it. No rule wins by default.
- The talk **carries over** (`e^(−Δt/τ)`): a follow-up a second later inherits most of the last
  belief; a line two minutes later inherits almost none. `τ` is fitted too.
- This is a Bayesian filter. Each line is a measurement, and the belief is updated the way a
  robot updates its map: add the log odds, let old evidence fade.

---

## 6. Q3 + Q4: the decision

Three actions: speak `S`, hold `H` (get the answer ready, say it only if the room goes quiet),
quiet `Q`. Expected cost of each:

```
E[cost(S)] = (1 − p_t) · c_I
E[cost(Q)] =      p_t  · c_M
E[cost(H)] = c_H + (1 − p_t) · c_I · q_I + p_t · c_M · q_M
```

`q_I`, `q_M` are how often a hold still ends up talking over him or missing him (measured from the
book). PAN takes the cheapest:

```
a_t = argmin_{a ∈ {S, H, Q}} E[cost(a)]     subject to 𝒞
```

With hold left out, this reduces to one bar:

```
speak  iff  p_t > c_I / (c_I + c_M)
```

**The bar is not a guess. It is his costs.** If talking over him is four times worse than missing
him, PAN speaks only when `p_t > 0.8`. That ratio is the most personal number in the system: the
dial marked *how pushy is PAN?* It is his to set, and it can differ by place (`on_call` at dinner
raises `c_I`).

---

## 7. 𝒞: the hard rules

As in Elipsis, a rule that is a cost can always be bought out by a large enough gain elsewhere. A
rule that is a constraint cannot. These are constraints, checked before any arithmetic:

```
𝒞₁  safety                          → speak
𝒞₂  muted, or dictating to a thread → quiet
𝒞₃  interpreting                    → translate
𝒞₄  strangers present               → no private facts aloud
𝒞₅  his standing wishes             ("quiet at dinner")
```

Everything else is weighed, not ruled.

---

## 8. Q4 continued: the words, and how sure they are

Once PAN speaks, it writes word by word from `P_θ`. Two things are read off the same odds.

### 8.1 Sure: is it guessing?

Let `F` be the positions in the reply that carry facts: places, numbers, temperatures, times,
names. At each, the spread of the odds is the entropy, and the confidence in the chosen word is
its probability:

```
H_j = − Σ_v P_θ(v given y_<j) · log₂ P_θ(v given y_<j)      (bits)

sure(y) = min_{j ∈ F} P_θ(y_j given y_<j)
```

A model that knows a fact puts its odds on one word. A model that is guessing ("New York",
"since dawn") spreads them. Then the same decision rule, with costs:

```
look it up      iff  (1 − sure) · c_G > c_L
say "I don't know"  iff  the lookup has nothing either
```

This replaces every keyword list for lookups. "Will I need a jacket tonight" makes the model reach
for a temperature it does not know; its odds spread; the lookup runs. Any wording, any language.

### 8.2 Worn: the same phrase again

The model's raw scores `u_v` (before the softmax) are pushed down for phrases PAN already used in
this talk, by how many times `n_v`, fading with time:

```
u′_v = u_v − α · n_v · e^(−age_v / τ_R)

P′(v) = e^(u′_v / T) / Σ_w e^(u′_w / T)
```

"Fair enough" stays possible. It just gets less likely each time it is used. `α` is fitted
against `c_R`.

### 8.3 Personality

So "what percentage of what word would have been chosen" is literally `P′`. Personality lives in
three places:

- `θ`: what training taught the model (which words it reaches for at all)
- `α`, `T`: how hard it avoids repeating itself and how adventurous its wording is
- `c`: when it speaks at all

The first is learned. The last is his.

---

## 9. Q5: were we right?

Each turn in the book gets a label `y_t ∈ {0, 1}` from what he did next: followed up on PAN,
repeated himself, carried on to someone else, talked over PAN. The weights are fitted by
minimising the log loss, a proper scoring rule (it rewards honest probabilities, not just right
answers):

```
𝓛(β, τ) = − Σ_{t ∈ ℬ} [ y_t · log p_t + (1 − y_t) · log(1 − p_t) ]

(β̂, τ̂) = argmin 𝓛     on the older 70% of the book; checked on the newest 30%
```

New weights go live only if they beat the old ones on the newest turns.

### 9.1 Model rounds earn their trust

Each voice model round (r15, r24, ...) is a competing model `θ_m`. Its credence is earned the way
Elipsis earns `ω`, by track record on his turns, never by being newest:

```
ω_m ∝ exp(−η · 𝓛_m)
```

A round that scores worse on his real talk does not ship, however good its bench looks.

### 9.2 A decision you can re-run

Every turn in the book carries what was seen (`s_t`, `ℓ_t`), what was decided (`p_t`, `a_t`), the
model round and the weights used. Any decision can be recomputed later with new weights, which is
how a change is tested on his past talks before it touches the live voice.

---

## 10. The honest part

- **The labels are the weak point.** On 2026-11-22, 76 of 123 "missed" turns came while he was
  dictating or music was playing, and only 6 turns showed PAN talking over him, because the book
  only knew "shh". A calculus scored on bad labels learns the wrong thing confidently. Fixing the
  labels comes first.
- **Where the labels are clean, the evidence term already works:** `ℓ_t` alone separates "he
  followed up on PAN" from "the talk went on without PAN" at AUC 0.975 (35 vs 75 turns).
- **Some things the words cannot carry.** His own voice, right after PAN answered, turned to other
  people, reads like a follow-up. That needs new terms in `φ`: which way he faces, how he said it.
  Until then `p_t` is honestly uncertain there, and the costs decide.
- **`c` is a value judgement.** No amount of arithmetic says whether talking over him is three or
  five times worse than missing him. That enters from outside the math, from him.

---

## 11. What kind of math this is

In plain names:

1. **Probability** (the model's softmax): every word has odds.
2. **Bayesian inference in log odds**: evidence from the words and the situation adds up, and old
   evidence fades.
3. **Information theory**: entropy measures how spread the odds are, which is how sure it is.
4. **Decision theory**: choose the action with the lowest expected cost; the bar comes from the costs.
5. **Statistics**: logistic regression fitted by maximum likelihood, checked out of sample with a
   proper scoring rule.
6. **Online learning**: model rounds earn trust by multiplicative weights on their track record.
