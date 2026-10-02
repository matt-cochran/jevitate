---
"@jevitate/cli": minor
"jevitate": minor
---

Vertical-clipping signal (#302). Viewport runs now flag text that no scroll position shows: text cut off by its nearest `overflow: hidden`/`clip` box whose content is taller than the box (`overflow-hidden`, attributed to the box), and text that spilled out of a too-short container above the page top (`above-page-top`, attributed to the text's element — e.g. a `flex-wrap` chip centred in a fixed-height header). It runs alongside horizontal overflow under the same gate (`--viewport`/`--device` narrower than 1024px, or `--check-overflow`) and is reported the same way: a `vertical-clipping` defect in coverage/exploratory/adversarial runs and a `signal-vertical-clipping` finding in the usability review, one per element (route + element fingerprint). Intentional truncation (`line-clamp`, `text-overflow: ellipsis`), sr-only/collapsed/invisible text, skip links, scroll containers and the page root are not reported; `--ignore-overflow <selector>` excludes the rest. See docs/exploration.md.
