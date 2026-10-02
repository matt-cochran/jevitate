---
"@jevitate/cli": minor
"jevitate": minor
---

API keys, capture and run fixes. `init` and `ai status` name each key, its provider and its source (env var or `~/.jevitate/credentials.json`) and check it with the provider (a live, non-billable auth call: valid / invalid / unreachable; `--no-verify` for offline/CI); `ai setup` verifies a key before storing it, and `ai setup <feature> --replace` / `init --replace-keys` replace a stored key (#268, #291). Key entry is masked with `•` and its instructions stay on screen (#269). Screenshots and videos also mask secrets the app reveals mid-run: elements marked as secret and credential-shaped values (#298). A multi-run forwards a bare `--screenshots`/`--record-video` correctly (#290); `explore --hang-replays <n>` no longer crashes (#275); `visible:<d>` holds when any of several matches is visible (#299); typing into a textarea keeps newlines (#285); model-invented sign-up emails/usernames are unique per run (#271).
