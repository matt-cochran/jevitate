# Jevitate

[![CI](https://github.com/matt-cochran/jevitate/actions/workflows/ci.yml/badge.svg)](https://github.com/matt-cochran/jevitate/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jevitate/cli.svg)](https://www.npmjs.com/package/@jevitate/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**Jevitate is a local-first browser-automation and testing platform.** It records
real browser sessions into reusable, typed **Journeys** (Screenplay-pattern
actions over Playwright), then replays, load-tests, explores, and reviews them
from a single CLI or an MCP server — with autonomous exploration driven by
[TypeSafe's Jev](https://typesafe.ai) judgment model, kept safe by hard
guardrails.

Website & docs: **[jevitate.com](https://jevitate.com)**

## Why

Most browser testing is either brittle scripts you hand-write or opaque
record-and-replay that breaks on the first UI change. Jevitate makes the browser
flow a **deterministic, typed artifact** you can replay, parameterize, load-test,
and reason about — and adds AI where semantic judgment actually helps (driving
toward a goal, finding defects, reviewing UX) without ever letting the model make
an unsafe or unbounded move.

## Capabilities

- **Record → replay.** Capture a flow by demonstration into a deterministic
  `Recording`; parameterize and promote it to a replayable Journey.
- **Goal-directed exploration.** Drive to a natural-language goal; success is
  judged by an independent assertion, never the model's say-so.
- **Feature, exploratory & adversarial testing.** Capability-scoped path
  discovery, state-coverage exploration, and bounded misuse with a trusted
  hard-signal defect oracle.
- **Regression artifacts.** Turn a reproducible failure into a minimized,
  deterministic, replayable regression.
- **Self-healing.** Repair a broken step under policy — never auto-healing a
  write or irreversible action.
- **UX review.** Ranked, cited, evidence-anchored usability findings (Nielsen +
  cognitive-science heuristics), advisory only.
- **Load testing** of a Journey against an authorized origin.
- **MCP server** exposing only an allowlisted, safe tool surface.
- **Distributed Journey sources** with an explicit trust/run gate.

## Install

```bash
npm i -g @jevitate/cli
# the bare-name alias installs the same `jevitate` command:
npm i -g jevitate
```

## Quick start

```bash
jevitate init                         # collect any missing keys + install agent skills
jevitate record --url https://example.test           # record a flow by demonstration
jevitate journey run <id> --param k=v                # replay a promoted Journey
jevitate explore --url https://example.test --goal "reach the confirmation page" --success urlIncludes:/confirmed
jevitate explore --strategy adversarial --url https://example.test   # try to break it (hard-signal oracle)
jevitate ux <recording.json> --app-class consumer    # ranked, cited UX findings
jevitate mcp                                          # start the allowlisted MCP server
jevitate --help                                       # everything else
```

Autonomous runs are always bounded and restricted to origins you authorize;
credentials are never sent to a model. See [SECURITY.md](./SECURITY.md).

### Mission outcomes and exit codes

A mission never answers with a crash: every run ends in a typed outcome, and its
transcript and Recording are flushed to disk step by step, so they survive even
a run that dies mid-way. A run that could not do its work is never reported as
clean.

| Outcome | Exit code | Meaning |
|---|---|---|
| `clean` | 0 | the run finished its budget and found nothing (goal mission: the success assertion held) |
| `defects-found` | 1 | at least one confirmed defect (goal mission: the success assertion did not hold) |
| `inconclusive` / `crashed` | 2 | the run itself broke (page never rendered, model unavailable, browser/page crash) |
| `hang` | 3 | the app under test hung, and the hang reproduced on replay |
| `intermittent` | 4 | a hang was observed but did not reproduce on every replay |

The MCP tool `get_mission_result` returns the same status and code for a
finished run; a broken run comes back as an error result.

The adversarial mission keeps hunting after a defect until its step, action or
time budget runs out. Defects are deduplicated by a stable fingerprint, and each
one carries its reproduction: the transcript steps that led to it and the
Recording step to replay up to. To check a fix, replay the defect:

```bash
jevitate verify-fix --result ~/.jevitate/recordings/adversarial-<stamp>.result.json --fingerprint <fp>
# exit 0 fixed (signal absent) · 1 still reproduces · 2 inconclusive (replay could not reach the step)
```

The MCP tool `verify_fix` (`{ id, fingerprint }`) does the same.

## How it's packaged

`@jevitate/cli` is a single bundled package — all internal `@jevitate/*`
workspace code is compiled into `dist/bin.js` via esbuild, and only native/heavy
dependencies (`playwright`, `better-sqlite3`, …) install alongside it. `jevitate`
is a thin bare-name wrapper that re-execs the same binary. Every other
`packages/*` is `private` and internal.

## Development

```bash
pnpm install
pnpm -r build
pnpm exec vitest run
pnpm lint
```

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) (feature branch →
PR into `dev`; TDD; security invariants preserved). Releases are documented in
[RELEASING.md](./RELEASING.md).

## License

MIT — see [LICENSE](./LICENSE).
