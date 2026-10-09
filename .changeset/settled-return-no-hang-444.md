---
"@jevitate/cli": patch
"jevitate": patch
---

An action that legitimately returns the page to an earlier state is no longer reported as a hang (#444). A click whose own requests all completed with a 2xx and left the page stable is settled (a Refresh re-reading the same data), and Refresh, Done and Got it join the labels whose return to an earlier state is expected. Pending requests or a page that keeps changing are still reported as `ui-no-progress`.
