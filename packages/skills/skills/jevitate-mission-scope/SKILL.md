---
name: jevitate-mission-scope
description: Reads a diff, pull request, changelog, or user story and scopes change-driven testing — identifies at-risk routes/features, maps them to existing promoted Journeys, runs the most relevant ones, and recommends which newly-discovered repros to promote. Use when a user wants to know "what should I test" after a code change, rather than testing everything or picking targets blindly.
---

You scope testing to what actually changed. You never drive a browser yourself —
Jev (the judgment gateway) makes browser-driving decisions inside the
exploration engine, and the deterministic Journey runner executes promoted
Journeys; your job is entirely the "what and why," spending tokens once to
target instead of on every click.

## 1. Read the change

Given a diff, PR description, changelog entry, or user story, identify:
- Which routes/pages/features it plausibly touches (file paths → routes is a
  judgment call — a change to `src/checkout/*` plausibly affects the checkout
  flow even if no route string literally appears in the diff).
- Whether it's additive (a new feature, lower regression risk to *existing*
  Journeys but a candidate for a *new* exploration goal) or modifying existing
  behavior (higher regression risk — prioritize existing promoted Journeys that
  exercise the touched area).
- Anything explicitly called out as risky (auth, payment, data deletion) —
  weight these higher regardless of diff size.

State your reasoning in one or two sentences before acting — "what changed" and
"why this is (or isn't) at risk" — so the human reviewing your output can
sanity-check the judgment, not just the commands you ran.

## 2. Map to existing promoted Journeys first

- `jevitate journey find "<term>" --json` (or MCP `find_capabilities`) once per
  at-risk area you identified in step 1. Try more than one query term per area
  if the first returns nothing plausible — a Journey's `name`/`description`
  might not use the same words as the diff.
- For each match, run it: `jevitate journey run <id> --param k=v ... --json` (or
  MCP `run_journey`). Read the `outcome` field; treat only `"ok"`/`"healed"` as
  a pass, never a non-success outcome.
- If a promoted Journey exists for an at-risk area and it passes, that area has
  regression coverage — say so plainly; you do not need to additionally explore
  it from scratch.

## 3. Where no promoted Journey covers an at-risk area

This is exactly the gap the exploration engine and `queue_exploration` exist
for. Prefer `jevitate-explore` (see that skill) or the `queue_exploration` MCP
tool to scope a **bounded** mission at the specific at-risk area:
- For a concrete end state, a goal-based mission: `jevitate explore --url <authorized-url>
  --goal "<goal>" --success <assertion>` — the `--success` assertion written
  from the diff/story's stated intent (e.g. `urlIncludes:/confirmation`), never
  a vague "test everything" goal.
- For a named capability with route scoping: `jevitate explore --feature <name>
  --route <glob> --url <authorized-url>` (model-free capability coverage).
- For "try to break the changed area": `jevitate explore --strategy adversarial
  --url <authorized-url>` (bounded misuse + a trusted hard-signal defect oracle).
- For state coverage of the changed area: `jevitate explore --strategy coverage
  --url <authorized-url>`.
- Only if you cannot reach an authorized target at all (or `jevitate explore`
  is genuinely absent from your environment) do you stop and report the gap —
  never fall back to a generic browser-automation tool; that would bypass every
  guardrail (bounded budget, independent assertion, redaction, deterministic
  Recording output) this platform exists to provide.

## 4. Recommend promotion of new repros

After a `jevitate explore` mission produces a new `Recording` (a "discovered
repro"), you do not promote it yourself — promotion is a human-approval gate.
Two additive paths help here: `jevitate explore-author-journey` writes an
UNPROMOTED, parameterized Journey (still human-gated), and `jevitate regression
capture --from <recording.json> --id <id>` turns a failing Recording into a
committed regression artifact. Recommend, with reasoning: which discovered
repros are worth promoting into the durable regression suite (does it cover a
genuinely new, at-risk path? did it reveal a defect worth a permanent
prove-broken/prove-fixed test?), and which are one-off exploratory noise not
worth keeping. Narrow the regression set to what matters — quality over
quantity.

## What you must never do

- Never test everything indiscriminately when a diff/story is available to
  scope from — that defeats the entire purpose of this skill.
- Never invent a Journey id, route, or param value — every id you run must have
  come from a `find`/`find_capabilities` result you saw in this session.
- Never promote anything yourself — recommend, and let a human decide.

## Registering and promoting a mission target (for queue_exploration)

`queue_exploration` runs against a PROMOTED mission target, never a raw URL.
When you want to queue a scoped mission at an at-risk area via MCP:
- `jevitate mission target add <id> --name <name> --authorized-origin
  <authorized-origin> --base-url <url> [--description <text>] --json`
  registers the target (unpromoted). Note the target's own registration takes
  NO `--goal`/`--route` — those are `queue_exploration` call arguments
  (`target`, `goal`, `feature`, `route`, ...), supplied per-enqueue, not baked
  into the target itself.
- `jevitate mission target list --json` shows registered targets and their
  promoted/unpromoted state.
- `jevitate mission target promote <id> --json` promotes it — a human-gated act,
  same as Journey promotion (`jevitate journey promote <id>`). Only a promoted
  target is enqueueable.

Then `queue_exploration({ target: "<id>", ... })` (via the `jevitate mcp`
server, registered with `jevitate mcp --print-config ...` or `jevitate init`)
enqueues a bounded mission and returns a `missionId`.

## Known gaps

- Offline only: `queue_exploration` enqueues but does not itself run the
  mission — treat the returned `missionId` as "accepted," not "finished."
