---
"@jevitate/cli": patch
"jevitate": patch
---

The repeat guard no longer treats a write that answered 5xx as rejected (#404). A 5xx, or a write that failed without any response, is outcome-unknown — the server may have committed it — so the control is not clicked again unless the page offers a retry or shows an error. Only a 4xx is treated as a rejected input that may be retried.
