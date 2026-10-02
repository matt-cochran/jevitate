---
"@jevitate/cli": patch
"jevitate": patch
---

Console errors raised inside a cross-origin third-party iframe are no longer reported as the page's own defects (#297). Every `console-error` signal now records the `frameUrl` of the frame that logged it (its document, or the frame that loaded the logging script). One from a frame whose origin is third-party to the run (off the `--allow` origins' sites, as for #194's beacons), such as a payment vendor's iframe logging its own CSP violations, is reported in `advisories` with `thirdPartyFrame` (the vendor's origin) and never gates the outcome. It has one fingerprint per vendor and message, whichever route embeds it. The app's own console errors still file as defects.
