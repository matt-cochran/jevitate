---
"@jevitate/cli": patch
"jevitate": patch
---

Screenshots no longer trip a strict Content Security Policy (#336). The demo overlay was hidden for each capture with Playwright's `screenshot({ style })`, which injects an inline `<style>`; an app with `style-src 'self'` blocked it, logged a CSP violation, and the console-error oracle filed jevitate's own style as an app defect (fingerprint `4e8d3c0a976f75ed`). The overlay is now hidden through its closed shadow root's adopted style sheets, which CSP doesn't restrict, without changing the page's DOM. A page with no overlay gets no capture styling at all.
