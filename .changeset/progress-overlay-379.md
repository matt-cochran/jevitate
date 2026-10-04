---
"@jevitate/cli": patch
"jevitate": patch
---

Goal runs no longer end fail-closed with "no interactive controls" when a busy/progress overlay (a fullscreen spinner, `aria-busy`, a `role=status` "Preparing…") covers or replaces every control after an action. Such a page is now treated as a job in progress: it is waited out within the render wait and then `--job-wait-ms`, and declared `--ignore-no-progress` patterns also match the indicator's own text. An overlay that is still up once the job-wait budget is spent ends the run as the stuck-status no-progress outcome naming it; a genuinely blank page still fails closed as before.
