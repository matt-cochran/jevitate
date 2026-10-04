---
"@jevitate/cli": patch
"jevitate": patch
---

Clicking an `sms:`, `tel:`, `mailto:` or app deep link is no longer reported as an app defect (`failed-request … net::ERR_ABORTED`): a link the browser hands to the operating system is not a failed request of the app under test. This applies to adversarial runs, `--log-triage` signal timelines and goal-run usability capture alike. A real failed http(s) request is still reported as a defect.
