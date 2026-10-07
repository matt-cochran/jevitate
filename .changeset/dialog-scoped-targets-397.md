---
"@jevitate/cli": patch
"jevitate": patch
---

Adversarial and other missions on a page with an open dialog now act on the dialog's own controls (#397). Controls below the fold that a fixed backdrop would cover once scrolled into view are left out of the inventory, so a `role=dialog` without `aria-modal` no longer ends a run with 0 actions and every step "obscured by" the backdrop.
