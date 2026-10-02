---
"@jevitate/cli": patch
"jevitate": patch
---

Goal runs that invite (#235). A "Send <thing>" control in the paid category ("Send invite", "Send email") is now the goal-asked exemption when the goal orders the thing itself at a clause's start ("Invite a teammate…", "…then invite Bob") — as `explore --help` documents; a mere mention ("report the invite's status") still asks for nothing. When every `--success` check is a `reloadThen` (judged only after the run), the in-run check evaluates nothing: it still grounds the model's own `done` provisionally, but no longer turns a `blocked`, a sign-in or the "already met" signal into "goal already met" — the run ends `blocked`, and a model that gave up after a safety refusal names that refusal in the reason.
