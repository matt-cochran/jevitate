# Jevitate documentation

Start with the [README](../README.md) for what Jevitate is and a first run. These pages are the
reference. Every command shown here exists in the CLI: run `jevitate <command> --help` for the
full flag list, or see the generated [CLI reference](./cli.md).

**Understand it**

- [Demo](./demo.md): a 2-minute, no-key walkthrough that finds a bug, proves it, commits a
  regression and verifies the fix.
- [How it works](./how-it-works.md): the pipeline, who decides what, and the package map.
- [Safety model](./safety.md): the guardrails that hold whatever a model proposes.

**Run missions**

- [Exploration](./exploration.md): adversarial scope and coverage, hangs, settling, page timing,
  viewport emulation.
- [Success checks](./success-checks.md): every `--success` kind, rich-text edits, find-out goals.
- [Invariants](./invariants.md): app-declared rules checked around every action, and spend budgets.
- [Backend logs](./backend-logs.md): correlate server logs to steps, and treat matches as defects.
- [Authenticated and stateful apps](./authentication.md): storage state, bound secrets, TOTP,
  sequential runs.
- [Fixtures](./fixtures.md): known state before every run and every replay.
- [Browser extensions](./extensions.md): load an unpacked extension (`--extension`) and drive its
  side panel, popup or options page.
- [Repeats, personas and actors](./multi-run.md): vote across runs, diff roles, check cross-tenant
  isolation.
- [Sweeps](./sweeps.md): many targets × personas from one targets file, with concurrency,
  resume and one aggregated, cross-target deduped result.

**Use the results**

- [Outcomes and exit codes](./outcomes.md): every `outcome`, `stop` and `missionOutcome` value.
- [Result schema](./results.md): the one versioned result shape every strategy writes.
- [UX findings](./ux-findings.md): how a usability finding is made (claims verified by code), the
  product facts file, guard probes, screenshots and what still needs real-model calibration.
- [Verification](./verification.md): `verify-fix`, `regression capture`, `regression run`, and
  exact replay.
- [CI, reports and baselines](./ci.md): `jevitate check`, `report`, `diff`, `baseline`.
- [Operations](./operations.md): build identity, usage and cost, killed runs, crash attribution,
  issue drafts, packaging.

**Other surfaces**

- [Journeys](./journeys.md): author, record, replay, self-heal, load-test and share flows.
- [Coding agents and MCP](./agents.md): skills, the MCP server and its tool allowlist, queued
  missions.

The website, [jevitate.com](https://jevitate.com), has guides and the same reference in a
browsable form.

**Related:** [Journeeze](https://journeeze.dev) (coming soon) adds human comprehension feedback
(likes, dislikes, "I don't understand") to the same journeys, clustered into GitHub issues.
[Early access](mailto:contact@journeeze.dev?subject=Journeeze%20early%20access). Demo guides end
with one line about it; turn that off with `JEVITATE_PROMOTIONS=0` or `"promotions": false` in
`~/.jevitate/config.json`.
