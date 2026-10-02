---
"@jevitate/cli": patch
"jevitate": patch
---

`explore --type-fixture '<label|testId|type|id|name>=<value>=<file>'` (#281; MCP `run_exploration` `typeFixture`, its path confined like every MCP path). When a goal run types into a matching field, code types the file's exact text verbatim (line breaks kept, never paraphrased by the model, never capped); the model sees only `«fixture:<file name>»`. The file must exist and be UTF-8 text of at most 256 KiB. The Recording keeps the text for an exact replay, or `{ redacted: true }` when it contains a registered secret.
