# Dashboard CSS Scoping — Svelte + `{@html}` Trap

**One-line rule:** Any CSS rule targeting an element created by `{@html ...}` or `document.createElement(...)` will be **silently stripped** from the production bundle unless you wrap it in `:global(...)`. The selector compiles fine, the source looks correct, the rule just **never reaches the browser**.

This is the root cause of bug #484 (markdown table rendering) and almost certainly the reason for every "markdown looks weird in chat" complaint we've had. **All** `.md-bullet`, `.md-codeblock`, `.md-h1`, `.md-h2`, `.md-h3`, `.md-table`, `.md-code` rules in `terminal/+page.svelte` were being stripped — they have been **dead CSS** for an unknown amount of time. Tables looked broken; everything else just rendered as browser defaults so nobody filed bugs about it.

---

## Why it happens

Svelte's CSS scoper walks your component template, sees every element class, then **removes any CSS rule whose selector doesn't match an element in the template**. This is the "unused CSS" pruner.

It cannot see:
1. HTML injected via `{@html something}` (the markdown renderer's `<table>`, `<div class="md-bullet">`, etc.)
2. DOM created imperatively via `document.createElement('div')` and `appendChild` (e.g. the center terminal panel's `.term-scrollback` container is built this way at runtime)
3. Anything added by third-party JS

To Svelte these elements don't exist at compile time → "the rule is unused" → **rule deleted from bundle**.

### How to confirm a rule was stripped

```bash
# After `npm run build`, grep the built CSS bundles:
grep -l "your-class-name" service/public/v2/_app/immutable/assets/*.css
```

If your class is in the `.svelte` source but **does not appear** in any `.css` file in `_app/immutable/assets/`, Svelte stripped it. That's the signature.

---

## The fix

Three patterns, pick based on whether you also need to scope to a Svelte-visible parent.

### Pattern A — parent is in the template, child is `{@html}`-injected

Use `.parent :global(.child)`. Svelte keeps `.parent` scoped (so it only matches *this* component's instances of `.parent`) and makes `.child` global (so it survives stripping and reaches the injected HTML).

```css
/* GOOD — .chat-bubble is in the template, .md-table comes from renderMarkdown */
.chat-bubble :global(.md-table) { border-collapse: collapse; }
.chat-bubble :global(.md-table th),
.chat-bubble :global(.md-table td) {
  border: 1px solid #45475a;
  padding: 6px 10px;
  white-space: nowrap;
}
```

Compiles to: `.chat-bubble.svelte-HASH .md-table { ... }` — scoped + global, both win.

### Pattern B — parent is also imperatively created (Svelte can't see it either)

The whole selector must be `:global(...)`. Svelte cannot reach in to scope either half.

```css
/* GOOD — .term-scrollback is created via document.createElement,
   .md-table comes from renderMarkdown. Both invisible to Svelte. */
:global(.term-scrollback .md-table) { ... }
:global(.term-scrollback .md-table th),
:global(.term-scrollback .md-table td) { ... }
```

Compiles to: `.term-scrollback .md-table { ... }` — unscoped, applies anywhere the class combo appears. Use class names unique enough (`.md-*`, `.term-*`) to not collide.

### Pattern C — DO NOT do this

```css
/* BAD — entire selector is global, applies to ANY .md-table on the page,
   including unrelated rendering surfaces. This is what made the transcript
   look "weirder" in the first iteration of #484. */
:global(.md-table) { ... }
```

Use Pattern A or B with an ancestor selector. Bare `:global(.md-table)` will smash every markdown table on the page including in unrelated panels.

---

## The Inline-Style Trap (separate gotcha)

Even after fixing scoping, the **center TERMINAL panel** had another gotcha: `.term-scrollback` is built with inline styles in JS:

```js
// terminal/+page.svelte ~line 1890
scrollbackDiv.style.cssText = 'padding:6px 10px 12px 10px;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;...';
```

`white-space` and `word-break` **inherit** to descendants. So even after my `.md-table td` CSS landed, the cells inherited `word-break: break-word` from the scrollback div, causing character-by-character breaking inside table cells.

Fix: always set explicit `white-space: normal; word-break: keep-all; overflow-wrap: normal` on `.md-table-wrap` AND `.md-table` AND `td/th` to defeat inheritance at every level.

---

## The two rendering paths in `terminal/+page.svelte`

The dashboard has **two separate markdown-rendering surfaces** that both need CSS to be styled. Forgetting one is why bug #484 came back: the transcript looked good, the center terminal didn't.

| Panel | Source | Container | Rendered by | Markdown? |
|---|---|---|---|---|
| Left "Transcript" side panel | line ~6965 (`leftSection === 'transcript'`) | `<div class="chat-bubble">` (in Svelte template) | `{@html renderMarkdown(text)}` | yes |
| Right "Transcript" side panel | line ~9539 (`rightSection === 'transcript'`) | `<div class="chat-bubble">` (in Svelte template) | `{bubble.text}` (RAW) | **no — bug or intentional?** |
| Center "TERMINAL" panel | line ~3060 `renderTranscriptToTerminal()` | `<div class="term-scrollback">` (`document.createElement`) | `${renderMarkdown(text)}` (string concat into innerHTML) | yes |

If you add a new `.md-*` style class, you must scope it for BOTH `.chat-bubble` AND `.term-scrollback`:

```css
.chat-bubble :global(.md-newthing) { ... }
:global(.term-scrollback .md-newthing) { ... }
```

(Future cleanup: deduplicate by factoring all `.md-*` rules into `service/dashboard/src/app.css` as plain global CSS. That file isn't subject to component scoping. Tracked separately.)

---

## Checklist before shipping any markdown/dashboard CSS

1. [ ] Does the selector match an element built by `{@html}`, `innerHTML`, or `document.createElement`?
   - If YES → wrap the dynamic part in `:global(...)`. Use Pattern A or B above.
2. [ ] Are there multiple rendering surfaces (chat bubble + terminal scrollback + maybe more)?
   - If YES → write a rule for each container.
3. [ ] Does the container have inline styles with `white-space`, `word-break`, `overflow-wrap`, `font`, `color`?
   - If YES → override explicitly in your rule. Inheritance will fight you.
4. [ ] After `npm run build`, run `grep -l "your-class" public/v2/_app/immutable/assets/*.css`.
   - Class **must** appear in at least one bundled CSS file. If not, Svelte stripped it — go back to step 1.
5. [ ] Ship via Craft swap (`POST /api/carrier/swap`) — not Carrier restart (`/api/carrier/restart` kills this session, see nightmare bug #753).
6. [ ] Verify in BOTH the side-panel transcript AND the center terminal panel. They use different containers.

---

## Related

- Bug #484 (table rendering) — fixed by adopting the patterns above
- Bug #753 (nightmare) — Carrier restart kills assistant session, why you must ship dashboard via Craft swap
- `docs/TRANSCRIPT_SYSTEM.md` — how messages flow into the chat bubbles
- `service/dashboard/src/routes/terminal/+page.svelte` lines ~11050-11160 — the markdown CSS block
- `service/dashboard/src/routes/terminal/+page.svelte` line ~1421 — markdown table HTML construction
- `service/dashboard/src/routes/terminal/+page.svelte` line ~3060-3220 — `renderTranscriptToTerminal()` for the center panel
