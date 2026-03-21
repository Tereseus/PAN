# ΠAN Design System

## The Π Symbol

The Π (Pi) symbol is the core brand mark. It must always be rendered using **Noto Serif Bold (700)** — this gives the classical mathematical look where:
- The top bar extends beyond the columns (like a gate)
- The right leg has a slight curve/serif
- It looks like the traditional mathematical Pi, not a blocky geometric shape

**Never use sans-serif fonts (Roboto, Arial, etc.) for the Π symbol.** They produce a flat, generic look that loses the character.

Google Fonts import: `Noto Serif:wght@700`

## Color Variants

- **Desktop / Web (GitHub Pages):** Π in blue (#58a6ff) on dark background (#0d1117)
- **Mobile (Android app):** Π in white on blue circle background (#1565C0)

These are intentional platform-specific treatments of the same symbol. The goal is to unify them over time so all platforms use the same rendering.

## Current State

The Π symbol currently looks different across platforms:
- **GitHub Pages** — Noto Serif, blue on dark (the best version)
- **Electron tray icon** — Custom SVG, white on blue rounded square with lighter background
- **Android app icon** — Vector drawable, white on blue circle, geometric/blocky
- **Browser extension** — Separate icon files

All should eventually converge on the Noto Serif rendering style.
