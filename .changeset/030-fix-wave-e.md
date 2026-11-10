---
"@jevitate/cli": patch
"jevitate": patch
---

Over MCP, a site policy that adds or lowers a pause or reading ceiling (`max`, `maxReadingMs`) is now refused as looser, even where the effective policy set none. The queue drain also recovers a mission or Journey call left `queued` by a drain that died right after claiming it, and no longer mistakes a reused PID for the claimant (claims record the process start time and a per-drain nonce). The root export no longer includes the test fake `fakeDoneJudge`.
