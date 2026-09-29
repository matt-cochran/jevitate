---
"@jevitate/cli": minor
"jevitate": minor
---

Journeys are environment-free (#247). Name the places your app runs in a committed `.jevitate/environments.json` (`{ "<name>": { "baseUrl", "allow"?, "fixtures"?, "hooks"? } }`; `jevitate init` writes an example once and never overwrites it) and choose one at run time with `--env <name>` or `--base-url <origin>` on `journey run`, `regression run` and `load run`, or with `env`/`baseUrl` on a check-suite Journey item. The Journey's recorded same-origin URLs move onto the environment's `baseUrl`, and the run's allowlist is the environment (`baseUrl` + `allow`): a step on any other origin is refused with exit 64 before any browser opens, and so is an unknown `--env` (the message lists the known ones). The file never holds secrets or sessions: a `storageState`/`secret`/`password`/`token`/`cookie`/`credential` key is refused. Per-environment sessions and secret fields stay in `~/.jevitate/targets.json`, keyed by the environment's origin (`storageState`, `secretFields`, and new `personas: { "<name>": { storageState?, secretFields? } }`). Without `--env`/`--base-url` a Journey runs on its recorded site exactly as before.
