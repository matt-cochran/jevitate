---
"@jevitate/cli": patch
"jevitate": patch
---

Runs check their AI keys at startup (#291). A run that uses the live AI (`explore --real`, `check`, `journey run/annotate/demo --real`, `demo`, `ux`, `mission run`) makes the same live, non-billable auth call as `ai status`, once per key per process, and stops with `E_AI_SETUP_REQUIRED` (exit 64) when a provider rejects a key, naming the key, its provider and a misplaced-key hint (never the value). An unreachable provider does not block; `JEVITATE_NO_KEY_VERIFY=1` skips the check for offline CI; `--fake-ai` never makes it.
