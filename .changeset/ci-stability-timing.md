---
"@jevitate/cli": patch
"jevitate": patch
---

Two timing fixes that also made CI flaky. A backend log line that a click's request writes just after the step settles now stays on that click when the run's next step is `done` or `blocked`; before, under load it could move to that ending step and be missing from the click's evidence (#653). An adversarial run no longer counts a form submit as "blocked by validation" when no field is invalid and the request is only slow to be reported; it waits up to a second for the request first (#657).
