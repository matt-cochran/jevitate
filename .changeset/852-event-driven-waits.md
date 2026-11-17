---
"@jevitate/cli": patch
---

Journey runs wait less, with the same verdicts (#852).
- **Done-check "before" reading:** it expects the check not to hold yet. It now reads the page once after the page settles (network and DOM quiet), instead of polling for the full timeout. A done state that the page renders after `load` is still seen.
- **Assertion re-checks:** they now wake on page activity (a DOM change, a finished request, a navigation). The polling interval remains the fallback for changes no event reports. A page that changes every frame is re-checked at most every 25 ms.
- **Idle browsers:** a finished command closes the browsers nobody holds, instead of waiting out the pool's 1 s idle timer.

On a 3-step Journey with a done check, a run takes about 2.0 s instead of 5.6 s. Without a done check it takes about 1.2 s instead of 2.4 s.
