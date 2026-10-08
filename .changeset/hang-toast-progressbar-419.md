---
"@jevitate/cli": patch
"jevitate": patch
---

A toast's auto-close countdown is no longer mistaken for a busy indicator (#419). Toast libraries render that countdown as an indeterminate `role="progressbar"`; because toasts pause it whenever the browser window is unfocused (always the case in headless runs), the UI looked permanently busy and a run ended with a false `ui-no-progress` hang. Jevitate now ignores an indeterminate progressbar that sits inside a toast/snackbar/notification region or is itself labelled a timer/countdown, while `aria-busy` and spinner indicators are unchanged.