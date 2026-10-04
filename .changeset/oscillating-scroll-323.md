---
"@jevitate/cli": patch
"jevitate": patch
---

A goal run that scrolls back and forth beside its target now stops as `no-progress` (#323). On a page whose rendered controls change with the scroll position (a virtualized list, a capped control set), every scroll changed the page signature. That reset the moving-scroll bound (#172), so a run could scroll up and down for 58 steps until its wall-clock cap. Scrolls that only revisit states the current scroll streak has already seen now count toward the bound. Past it, they count as no progress even though the signature changed. A scroll that reveals a new state is still progress.
