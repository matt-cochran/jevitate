---
"@jevitate/cli": patch
"jevitate": patch
---

The repeated-side-effect guard counts only the app's own writes (#274, #284). A write to a third-party origin (a vendor's telemetry or `csp-report` beacon, Stripe.js's `POST https://m.stripe.com/6`) or a request matched by `--settle-ignore` is still listed in `sideEffects` (third-party ones marked `thirdParty`), but it no longer makes a safe control (a menu, a nav link) unclickable a second time. A repeated first-party write is still refused.
