---
version: "superdesign-alpha"
name: "Terminal Neobrutal"
description: "Near-black brutalist terminal system with magenta/cyan offset-shadow duotone, square edge-to-edge geometry, and JetBrains Mono readouts under oversized italic Archivo display type."
colors:
  background: "#050505"
  surface: "#18181B"
  surface-alt: "#0A0A0A"
  text-primary: "#FFFFFF"
  text-secondary: "#99A1AF"
  text-tertiary: "#D1D5DC"
  accent-magenta: "#FF00FF"
  accent-cyan: "#00FFFF"
  accent-green: "#22C55E"
  status-red: "#FB2C36"
  status-yellow: "#F0B100"
  status-green: "#00C950"
typography:
  display-lg:
    fontFamily: "Archivo"
    fontSize: "96px"
    fontWeight: 900
    lineHeight: "1.1"
    letterSpacing: "-1.9px"
  headline-md:
    fontFamily: "Archivo"
    fontSize: "48px"
    fontWeight: 900
    lineHeight: "1.1"
    letterSpacing: "-1px"
  body-md:
    fontFamily: "Public Sans"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: "1.38"
  label-md:
    fontFamily: "Archivo"
    fontSize: "18px"
    fontWeight: 900
    lineHeight: "1.1"
    letterSpacing: "-0.4px"
  body-mono:
    fontFamily: "JetBrains Mono"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "1.5"
    color: "#99A1AF"
spacing:
  base: "8px"
  gap-sm: "12px"
  gap-md: "16px"
  gap-lg: "24px"
  section-padding: "64px"
rounded:
  control: "0px"
  card: "0px"
  pill: "0px"
components:
  button-hero-primary:
    background: "linear-gradient(rgb(255, 255, 255), rgb(209, 209, 209) 45%, rgb(255, 255, 255) 50%, rgb(229, 229, 229))"
    text-color: "#000000"
    radius: "0px"
    height: "54px"
    border: "2px solid #FF00FF"
    shadow: "rgb(255, 0, 255) 8px 8px 0px 0px"
  button-outline:
    background: "transparent"
    text-color: "#FFFFFF"
    radius: "0px"
    height: "54px"
    border: "2px solid #00FFFF"
    shadow: "rgb(255, 0, 255) 4px 4px 0px 0px, rgb(0, 255, 255) -2px -2px 0px 0px"
  button-nav-cta:
    background: "linear-gradient(rgb(255, 255, 255), rgb(209, 209, 209) 45%, rgb(255, 255, 255) 50%, rgb(229, 229, 229))"
    text-color: "#000000"
    radius: "0px"
    height: "54px"
    border: "2px solid #00FFFF"
  card-feature:
    background: "#18181B"
    radius: "0px"
    padding: "28px"
    border: "1px solid #303030"
  card-panel:
    background: "#0A0A0A"
    radius: "0px"
    padding: "64px"
    border: "1px solid #303030"
  card-tag-available:
    background: "transparent"
    text-color: "#22C55E"
    radius: "0px"
    border: "1px solid #22C55E"
    padding: "4px 10px"
  card-step-active:
    background: "transparent"
    text-color: "#F0B100"
    radius: "0px"
    border: "2px solid #F0B100"
    shadow: "rgba(0,0,0,0) 0px 0px 0px 0px, rgb(255, 0, 255) 6px 6px 0px 0px"
---
# Terminal Neobrutal
Source: https://jevitate.com

## Overview
This is a dark-mode-default neobrutalist system built on a near-black stage (#050505, 77.7% declared area, confirmed by the 79%-black pixel field) and carried by two rationed high-voltage signal colors — magenta (#FF00FF) and cyan (#00FFFF) — used almost exclusively as hard offset shadows, borders, and glitch outlines rather than fills. Every rectangle is unrounded (0px radius everywhere, confirmed across nav, buttons, and all six card families), every heading is set in a heavy italic condensed grotesque (Archivo 900) rendered with a duotone drop-shadow that reads as a CRT/glitch artifact, and body copy runs in JetBrains Mono at 14px, giving the whole page the register of a terminal readout wrapped in a poster.

## Composition
The first screen opens on a sticky, edge-to-edge square navbar, then a status pill and two green-outlined "shipping" badges establish a monospace status-log rhythm before the oversized three-line italic headline lands. A left-rule pull-quote block (cyan vertical bar) and a two-CTA row close the hero. Below the fold, the page runs as a strict stack of full-bleed banded sections (padding 64px), alternating pure-black bands with #0A0A0A panel bands, each opened by a small-caps bracketed eyebrow `[ LIKE THIS ]` in cyan or magenta and an "AVAILABLE" status chip. Feature content is delivered almost entirely as unrounded bordered grids — never as illustrations or photography — keeping density high and decoration low. The deliberate choice is a chip/badge-driven state system (AVAILABLE tags scattered through every section) over a single hero explainer graphic; this rejects a conventional marketing "hero visual + feature icons" approach in favor of a build-log aesthetic where every module is individually labeled.

## Colors
`#050505` is the background on ~78–79% of pixels and is the true stage color — never let a rebuild lighten it. `#18181B` (~12% of the field) is the raised card surface for the two "1×3" feature-triptych grids; `#0A0A0A` is a second, deeper panel surface used for full-width text bands. Text ink is `#FFFFFF` primary, `#D1D5DC` secondary, `#99A1AF` tertiary/mono-body — a three-step gray ramp with no color in body copy. `#22C55E` (green) is the semantic "available/shipping" signal, always as a 1px outline chip, never a fill. `#FF00FF` (magenta) and `#00FFFF` (cyan) are the accent pair: rationed to shadows, borders, and the display-heading duplicate-outline effect — they cover a measured 17.1% of the page via the dot-grid background texture alone, but as fills they touch almost nothing (0.1%), confirming they are a linework/shadow accent, not a background color. Yellow (`#F0B100`) and red (`#FB2C36`) appear only as isolated status tokens (e.g., an active step highlight). Large mid-page bands are left entirely uncolored gray-on-black, letting the magenta/cyan pair register as electric precisely because it is scarce.

## Typography
Archivo 900 (display-lg 96px/1.1, ls -1.9px; headline-md 48px/1.1, ls -1px; label-md 18px/1.1, ls -0.4px) carries every heading in italic, always duplicated with a magenta+cyan offset stroke — the system's signature move. Public Sans 700 at 24px/1.38 is used for the single hero lede/pull-quote paragraph beneath the headline — bold, larger than standard body, reserved for one emphasis block per section. JetBrains Mono 400 at 14px/~1.5, colored `#99A1AF` with `#D1D5DC` for emphasized spans, is the actual workhorse body face — it sets card copy, list items, code blocks, and labels, giving the page its console-log texture. All-caps monospace labels at small sizes (eyebrows, nav items, badges) use loose tracking for a technical, tagged feel.

## Layout
Content is capped at a 768px measure for prose blocks but grids run wider within full-bleed 64px-padded sections. Card grids are strictly uniform, never masonry or bento: a 3-column × 2-row grid (gap 24px, 6 items, rows [32/32/32 | 32/32/32]) delivers the feature-triptych band twice; a 4-column grid (gap 40px, 5 items, rows [22/22/22/22 | 93]) spans a code/spectrum band with one full-width spanner row beneath four equal columns; a 2-column even split (rows [50/50]) pairs long-form text blocks. Spacing is tight and grid-locked at 8/12/16/24/64px — no soft whitespace breathing room. The navbar is an edge-to-edge square bar at 110px tall spanning ~99% of viewport width with an 8px inset on each side, zero corner radius on all four corners (0/0/0/0), sticky on scroll, background `#050505`, holding 10 nav items plus its CTA.

## Components
- **Navbar**: top of every screen, edge-to-edge square bar, 110px tall, ~1904px wide at capture (99% viewport, 8px/8px side inset), all four corners 0px radius, sticky, fill `#050505`, 10 total items (logo + text-link items + external-link item + CTA). Its CTA is transparent-bordered with a gradient fill `linear-gradient(rgb(255, 255, 255), rgb(209, 209, 209) 45%, rgb(255, 255, 255) 50%, rgb(229, 229, 229))`, black text, 0px radius, 54px height, cyan-bordered — a nav utility button, distinct from the hero primary.
- **Hero primary CTA**: below the headline, an observed near-white/off-white solid rectangle (same gradient family as the nav CTA, `linear-gradient(#fff, #d1d1d1 45%, #fff 50%, #e5e5e5)`), black text, square ~0px corners, paired with a magenta hard-offset shadow (`8px 8px 0px 0px #FF00FF`) — the single most emphasized control on the first screen. Sits beside a secondary outline button: transparent fill, cyan 2px border, dual-tone offset shadow (`4px 4px 0 #FF00FF, -2px -2px 0 #00FFFF`), same 0px radius and height.
- **Status/badge chips**: scattered across every section (hero, feature bands, spectrum table) — small rectangular tags, transparent fill, 1px `#22C55E` border, green mono-caps text ("AVAILABLE"/"SHIPPING") — signal semantic state, never decorative.
- **Feature-triptych card grid** ×2 instances (6 cards each): 3-per-row × 2 rows, `#18181B` fill, 0px radius, 28px padding, no visible corner treatment beyond a thin border; anatomy is heading (mono-caps bold) over one paragraph of JetBrains Mono body — no imagery, no icons.
- **Full-width panel band** ×5 stacked: `#0A0A0A` fill, 0px radius, 64px padding, full-bleed row (rows [99|99|99|99|99]) — each is a single heading + body-text block, used for the "loop," "reframe," and "regression" narrative bands.
- **Direction-spectrum list**: a 4-row numbered table (magenta numerals 01–04), each row a bordered mono input-style rectangle containing a short label — reads as a form/table hybrid, right column of a 2-col 50/50 split against a left text column.
- **Process step row**: 8 small square cards in a horizontal rail (OBSERVE→REPEAT), `#18181B`-style fill, bold mono-caps heading + small gray caption; the final "REPEAT" card is distinguished with a yellow 2px border and magenta hard shadow — an active/looping state indicator.
- **Checklist/tag row**: a horizontal cluster of 6 bordered pill-less rectangles (EXPLORE, DISCOVER FAILURE, REPRODUCE, MINIMIZE TRACE, GENERATE TEST, FIX & VERIFY) — white 1–2px borders, transparent fill, functioning as a labeled pipeline diagram rather than buttons.
- **Terminal/code block**: a bordered black rectangle with a magenta vertical bar accent on its right edge, containing monospace command lines in white/gray with `$` prompts and inline comments — the CLI-install centerpiece near the page end.
- **Small utility card row** ×4 (near page end): `#18181B` fill, 0px radius, 16px padding, body-text only — short safety/constraint statements in a 4-across row.
- **Bare text row** ×3 (near page end): transparent fill, 0px padding, body-text only — unboxed statements, likely a closing FAQ-like or legal-adjacent strip.
- **Footer**: `#050505` background, 13 links, unrounded, flush against the bottom edge with a thin white top divider matching the navbar's hairline treatment.

## Graphics & Effects
A magenta dot-grid texture (`radial-gradient(rgb(255, 0, 255) 1px, rgba(0,0,0,0) 1px)`) covers roughly 17.1% of total page area as a subtle repeating dot pattern over the black stage — not a wash, a texture; keep it faint and confined, never a full-color background fill. Hard-edged, zero-blur "sticker" shadows substitute for soft elevation throughout: `4px 4px 0 #FF00FF, -2px -2px 0 #00FFFF` (dual offset) on outline buttons, `8px 8px 0 #FF00FF` (single offset) on the hero primary and code block, and a five-layer shadow stack collapsing to one visible `6px 6px 0 #FF00FF` on the active process step. Headline type carries its own duotone drop-shadow (white base type with a magenta+cyan doubled outline) simulating chromatic-aberration/glitch — this is the page's dominant "graphic," standing in for illustration or photography entirely; there is no hero image, product screenshot, or mockup anywhere in the system. A small solid-fill geometric triangle sits isolated in the hero's top-right dead space as the only non-typographic shape on the page.

## Motion
Interaction motion is fast and mechanical: `transform, box-shadow 0.2s` and `0.2s ease-out` govern hover lifts on bordered buttons and cards (consistent with the hard-shadow "press" aesthetic — shadow likely shifts or shortens on hover/active to imply a physical button press). Border-color transitions run at `0.2s ease` for chip/tag hover states. General UI transitions use `all 0.15s cubic-bezier(0.4, 0, 0.2, 1)` for snappy, near-instant state changes. Two named keyframe animations, `status-pulse` (a looping opacity/scale pulse on the green "available" status dot) and `glitch-reveal` (a stepped-offset reveal echoing the duotone headline treatment), supply the system's only ambient/looping motion — reserved for status indicators and heading entrances, never continuous background animation.

## Guardrails
- Never round any corner — every surface, button, and card is a hard 0px rectangle; a single rounded element breaks the brutalist identity.
- Never fill a large area with magenta or cyan — they are shadow/border/texture accents rationed to under ~1% as solid fill; keep backgrounds black.
- Never substitute the nav's glass/gradient utility button for the hero primary — the hero CTA is the observed off-white gradient rectangle with the magenta hard-shadow, a distinct role.
- Never replace JetBrains Mono body copy with a humanist sans — the monospace voice is the system's texture, not a substitute face.
- Never soften the shadow language into blurred drop-shadows — shadows are always hard-edged, zero-blur, offset duplicates in magenta/cyan.
- Never introduce imagery, illustration, or photography — the system communicates entirely through type, borders, chips, and monospace text.