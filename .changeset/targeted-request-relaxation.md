---
"@jevitate/cli": patch
---

Allow automatic targeted mutation proofs to relax an earlier paired request assertion using the existing bounded request mask and passing-control requirement. Journeys with both a page postcondition and `expectRequests` no longer end inconclusively because the verifier proposes a `step-request:*` relaxation that it then refuses (#768, #778).
