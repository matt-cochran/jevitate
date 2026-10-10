---
name: jevitate-demo
description: Make narrated product demos with jevitate. Covers one aspect from a one-line request (`jevitate demo "<aspect>" --env`, then the human's `demo approve`), an existing Journey replayed as a WebM video with .vtt subtitles and/or a Markdown guide with screenshots (`jevitate journey demo`), step intent drafts (`journey annotate`), and named environments (`--env`, .jevitate/environments.json). Use for a demo, walkthrough, onboarding video or how-to guide. Not for testing.
---

A jevitate demo is a replayed Journey with an on-page overlay: a title card, a caption per step
(its `objective`), the step's target highlighted, and an outcome card. Secret values are redacted
in text and masked in pixels. Demos are rendered from deterministic replays, so they never show
something the app didn't do.

## Environments first

- Demos and Journey replays run against a named environment from the committed
  `.jevitate/environments.json` (`jevitate init` writes an example with a `local` entry). Each
  entry has `baseUrl` (an origin), an optional `allow` list, `fixtures` and `hooks`. Mark a live
  site with `"production": true`. `demo` refuses one (`E_DEMO_PRODUCTION_ENV`, exit 64). Mark a
  seeded, synthetic tenant with `"synthetic": true`: only a demo approved there ships masked media
  (jz-mask-v1) to Journeeze with `catalog export` / `publish journeeze`. Set it only when the human
  says the environment holds no real customer data.
- The file never holds a secret or a session. Sessions and secret fields live in
  `~/.jevitate/targets.json`, keyed by the environment's origin, with `personas` for named
  sessions. Never write a session or password into the repo.
- `--base-url <origin>` is an ad-hoc environment (e.g. a preview deploy). An unknown `--env` exits
  64 and lists the known ones.

## One aspect from a one-line request (needs keys)

- `jevitate demo "<aspect>" --env <name> --success "<check>" --real --json`, e.g.
  `--success "textIncludes:testId=status|Saved"`. The `--success` check proves the aspect was
  shown. Jev drives, and code decides. Useful options: `--start <path>` (where exploring begins),
  `--persona <name>`, `--id <id>` (default `demo-<aspect slug>`), `--max-actions <n>`.
- Pipeline: explore toward the aspect → minimize to the essential steps (each drop is verified by
  replay) → draft annotations → render a DRAFT video, `.vtt` and guide (watermarked) into `--out`
  or a fresh logs folder. Exit 1 means the check wasn't reached or the path didn't replay, and
  nothing was written. Exit 64 means no `--env`/`--success`, a production env, or an existing id
  (`E_DEMO_EXISTS`).
- MCP: `create_demo({ aspect, env, success, real: true })`.
- Show the human the DRAFT (the video and guide paths from the result) and the drafted
  annotations. `jevitate demo approve <id>` renders the final demo and promotes the Journey.
  It's the human's approval: they run it in their own terminal and type the id to confirm (from
  your shell it is refused, `E_APPROVAL_NEEDS_HUMAN`, exit 64). Never pass
  `--non-interactive-approval` yourself. MCP `approve_demo` works only when they tell you to, and
  it is recorded as an agent's approval (`provenance.channel: "mcp"`), not theirs.

## An existing Journey as a demo

- Draft the step captions first when steps have no `objective` (`journey run` reports
  `intent.withoutObjective`): `jevitate journey annotate <id> --env <name> --real --json` writes
  `.jevitate/journeys/.drafts/<id>.annotations.json` and prints the diff. It never changes the
  Journey. Exit 2 means the replay stopped early and only the reached steps were drafted.
- The human reviews or edits the draft, then approves with
  `jevitate journey annotate <id> --approve`. It's refused if the Journey changed since the draft
  (`E_JOURNEY_ANNOTATIONS_STALE`, 64). If so, draft it again.
- Render: `jevitate journey demo <id> --env <name> --video demos/<id>.webm --guide docs/<id>.md --json`
  (or MCP `demo_journey`). With neither flag, both go to a fresh logs folder. `--pace <ms>` sets how
  long each caption shows (default 1500). `--headed` presents it live (needs a display).
  `--param k=v` and `--storage-state <file>` work as in `journey run`.
- Exit 1 means stale: the Journey no longer replays and nothing was written. Say which step
  stopped (it's in the result). Don't re-record it silently. Exit 2 means an output couldn't be
  produced.
- Playwright records WebM. Suggest ffmpeg if the human needs MP4.

## What you must never do

- Never demo against a production environment or an origin the human didn't name.
- Never approve a demo or annotations yourself, and never promote the Journey behind a demo.
- Never hand-edit a video, guide or caption to hide a failed step. A stale demo is a real signal.
