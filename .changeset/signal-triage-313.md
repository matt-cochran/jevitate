---
"@jevitate/cli": minor
---

Signal triage (#313). With `explore --log-source … --log-triage`, a run records its whole signal timeline to `<run>.signals.jsonl`: backend lines at every level, the browser's console, page errors and failed requests, all redacted and bounded. Each defect then carries only the lines related to it in `defects[].relatedLogs`, and its issue draft gets a `## Related logs` section. Code keeps the lines correlated to the defect's request by id and prefilters its step's window. With `--real`, Jev scores each remaining line's relevance; with `--fake-ai`, only the window's error and warning lines are kept. Jev only selects evidence and never decides whether a defect exists. `jevitate logs triage --result <r>` re-triages a finished run. Sending log text to the model is an operator opt-in, so `--log-triage` is not exposed over MCP. `campaign run` forwards `--log-triage` to its missions.
