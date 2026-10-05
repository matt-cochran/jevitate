---
"@jevitate/cli": patch
"jevitate": patch
---

After a send that started nothing, or any action with nothing of its own in flight, the page's own background requests no longer keep a `wait` "still working" (#383). A read the page repeats on a timer (a balance or notification poll), or one it starts on its own more than 1.5 s after the run's last action, is not counted as the app working on what the run did, so quiet waits end the run as #241 intended. Writes, reads the action itself started, and any visible busy indicator still count.
