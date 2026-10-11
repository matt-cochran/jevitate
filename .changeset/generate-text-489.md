---
"@jevitate/cli": patch
---

Structured model output now uses the AI SDK's `generateText` with an output setting instead of the deprecated `generateObject`, so missions and campaigns no longer print the `AISDK_DEP_GENERATE_OBJECT` warning to stderr (#489).
