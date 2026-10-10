---
"@jevitate/cli": minor
"jevitate": minor
---

Approved demos now travel to Journeeze with their media, masked under Journeeze's `jz-mask-v1`
policy (#471). An environment can declare `"synthetic": true` in `.jevitate/environments.json` (a
seeded, synthetic tenant). `demo approve` on such an environment renders the final demo under
jz-mask-v1. Form fields, editable text and `[data-jz-mask]` are painted over with their subtree,
embeds (`iframe`, `video`, `canvas`, …) become placeholders, and `[data-jz-block]` is left out.
Every screenshot is proven before and after the capture, down to its pixels. The video is proven on
every frame. The media proven masked is kept in `<journeys>/.demos/<id>/`, and anything unproven is
left out: a screenshot that fails takes the video with it. `catalog export --format
journeeze-bundle` then writes `demos[]` (with `renderedFrom` and the privacy attestation) and
`files[]`, with the media under `media/<id>/`. It re-verifies every file's sha256 and leaves out
anything over the contract's limits with a warning. `publish journeeze` uploads such a bundle as a
deterministic ZIP. A draft demo, a demo of an older Journey version, or one approved on a
non-synthetic environment is never exported.
