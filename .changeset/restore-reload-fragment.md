---
"@jevitate/cli": patch
---

Restore a Journey's final same-document hash route after `reloadThen` when application bootstrap drops only the fragment, so persistence assertions run on the route the replay actually completed without masking server redirects.
