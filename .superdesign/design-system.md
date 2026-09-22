---
version: "superdesign-alpha"
name: "Jevitate Terminal Neobrutal"
description: "Jevitate.com's near-black brutalist terminal DNA adapted to a local-first, single-user approval dashboard. Magenta/cyan/yellow neon offset-shadow duotone, square edge-to-edge geometry, JetBrains Mono readouts under oversized italic Archivo display type."
---

# Jevitate Local UI — Design System

Applies jevitate.com's visual language to the **local approval dashboard** (`jevitate ui`) — a localhost web app where one human reviews human-in-the-loop items handed back by agent/CLI runs. Dark theme only, no auth, single-user.

## Colors

```
background        #050505   (ink, page)
surface           #18181B   (cards, panels)
surface-alt       #0A0A0A   (nested wells, code blocks)
text-primary      #FFFFFF
text-secondary    #99A1AF   (mono labels, metadata)
text-tertiary     #D1D5DC
accent-magenta    #FF00FF   (primary action glow, headline underlines)
accent-cyan       #00FFFF   (links, secondary emphasis, focus rings)
accent-yellow     #FFFF00   (review/attention state)
status-green      #00C950   (approved / shipped LED)
status-yellow     #F0B100   (pending / paused LED)
status-red        #FB2C36   (rejected / error LED)
```

Radial-dot background: 1px `#18181B` dots on `#050505`, ~24px grid, behind all content.

## Typography

- **display** — Archivo, 900, italic, skewed −4°, letter-spacing −1.9px. Page titles ("PENDING QUEUE"), neon magenta/cyan text-shadow glow.
- **headline** — Archivo 900, −1px. Card titles, section heads.
- **label** — JetBrains Mono, uppercase, in `[BRACKETS]`, color `#99A1AF`. Every metadata key (run id, Journey, step, agent).
- **body** — Public Sans, 400–700. Prompts, reasons, descriptions.
- **mono-value** — JetBrains Mono 400. URLs, ids, step names, timestamps.

## Geometry & components

- **radius 0px everywhere.** No rounded corners. Ever.
- **Borders**: heavy 2px `#FFFFFF` on cards; 2px accent border on active/primary.
- **Offset shadow**: `8px 8px 0 0` in the accent color (magenta primary, cyan secondary) — no blur.
- **Buttons**
  - *primary (Approve/Resume)*: chrome/metallic gradient (white→#D1D1D1→white), black text, 2px magenta border, magenta 8px offset shadow, height 54px, uppercase Archivo 900 label.
  - *secondary (Reject)*: transparent, white text, 2px white border → red border+glow on hover.
  - *ghost (Provide input / View)*: transparent, cyan text, 2px cyan border.
- **Status-LED badge**: small pill, `[STATUS]` mono text preceded by a glowing 8px dot (green/yellow/red) with a matching box-shadow halo.
- **Item card**: surface #18181B, 2px white border, magenta offset shadow on hover; top row = type LED badge + `[RUN 4a1c]` mono id; title = the paused step; body = prompt/reason (Public Sans); footer = `[JOURNEY]`, `[AGENT]`, `[STEP]` mono metadata + action button row.

## Screens

1. **Pending queue** — skewed display title "PENDING QUEUE" with count badge; vertical stack of item cards (handback / approval / review types, each color-keyed: cyan / magenta / yellow LED). Each card carries inline Approve / Reject / Resume / Provide-input actions.
2. **Item detail** — full-width panel: target URL (mono, cyan), the paused step, a screenshot well (surface-alt, 2px border, "no screenshot" placeholder), the requesting agent, the prompt/reason in body type, and the full action control row + a `[PROVIDE INPUT]` textarea (mono, ink well, cyan focus ring).
3. **Empty state** — centered, radial-dot field, large skewed "NO PENDING ITEMS" in dim white, one mono line `[ waiting for handbacks… ]` with a slow-blinking cyan cursor.

## DESIGN SYSTEM FIDELITY

Reproduce jevitate.com's exact tokens above — do not invent new hues, radii, or fonts. Square corners, heavy borders, hard offset shadows, neon glow on display type, `[BRACKETED]` mono labels, and status-LED dots are non-negotiable identity marks. Local-first: no login, no avatars, no multi-tenant chrome.
