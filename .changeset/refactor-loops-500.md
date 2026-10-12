---
"@jevitate/cli": patch
"jevitate": patch
---

Internal refactor, no behaviour change (#500). The mission loops (`runUsabilityMission`, the goal mission's `adjudicatedRun`, and `createRunContext`) are split into short orchestrators plus phase and per-concern modules. A real-model dogfood comparison against the build before the refactor (15 missions on a live app, 3 runs each) showed no regression.
