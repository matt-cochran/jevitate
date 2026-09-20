# Site availability updates (jevitate-site #10–#17)

**Repo under change:** `~/working/jevitate-site` (separate git repo, `matt-cochran/jevitate-site`, currently on branch `dev`, working tree clean). This repo's commits/PRs/branches are entirely independent of the main `doit` repo's gitflow — do not touch `doit` git state for this work.

**Trigger model:** each of #10–#17 is a *declarative site-state* ticket, paired to a *code* ticket. When the code ticket ships (merges to the code repo's `dev`), do the matching site edit(s) below, build, verify, and commit+push in `jevitate-site`. These are content/status flips only — no new components, no new pages, no design work. Never claim more than the paired code ticket actually delivered (see per-ticket "verify against code" note).

## Ticket → capability → code ticket mapping

| Site ticket | Capability | Paired code ticket(s) | Landing surface | Docs surface |
|---|---|---|---|---|
| #10 | Goal-directed testing | #1 (exploration engine) | `TestingModes.astro` (`goal` card), `Loop.astro` | `testing-modes.astro`, `getting-started.astro` |
| #11 | Feature testing | #2 | `TestingModes.astro` (`feature` card) | `testing-modes.astro`, `getting-started.astro` |
| #12 | Exploratory testing | #3 | `TestingModes.astro` (`explore` card) | `testing-modes.astro` |
| #13 | Adversarial testing | #4 | `TestingModes.astro` (`adversarial` card) | `testing-modes.astro`, `getting-started.astro` |
| #14 | Regression & CI | #5 | `TestingModes.astro` (`regression` card), `Regression.astro` | `regression.astro` |
| #15 | LM-driving | #6 | `Unified.astro` (LM-driving row + spectrum note) | `journeys.astro` (LM-driving section) |
| #16 | In-flight self-healing | #7 | `AvailableNow.astro` (self-healing bullet copy) | `journeys.astro` (Self-healing section) |
| #17 | LLM-directed mission scoping | #8, #9 | (no dedicated landing card found — see risk below) | `mcp-cli.astro` (`queue_exploration` callout) |

Cross-cutting, fire only once the *last* ticket in its group lands:
- `Hero.astro`'s aggregate badge and `docs/index.astro`'s aggregate banner/lists track the **whole** goal+feature+explore+adversarial group (#10–#13), not any single ticket — see "Cross-cutting surfaces" below.

## The mechanism: how "Available" is represented

There is **no single config flag** (`config.ts` only holds site metadata/nav — no status field). Status is represented three different ways depending on surface; all three must be checked per ticket:

1. **Data-driven landing cards** — `src/components/TestingModes.astro`, lines 4–53: a `modes` array where each entry has a `status: "roadmap" | "shipped"` field, keyed by `tag` (`"goal"`, `"feature"`, `"explore"`, `"adversarial"`, `"regression"`, `"automate"`). The render logic at line 75–77:
   ```astro
   <span class={`badge ${mode.status === "shipped" ? "badge-shipped" : "badge-roadmap"}`}>
     {mode.status === "shipped" ? "Available" : "Roadmap"}
   </span>
   ```
   Flipping a capability to Available on the landing grid = change that one entry's `status: "roadmap"` → `status: "shipped"`. This is the cleanest, most declarative lever and covers #10, #11, #12, #13, #14's landing card.

2. **Hand-authored badges** — several components hardcode a `<span class="badge badge-roadmap">Roadmap</span>` (or `badge-shipped`) inline rather than deriving it from data: `Loop.astro:20`, `Regression.astro:26`, `Unified.astro:38`, `Hero.astro:19`. These must be edited by hand (swap `badge-roadmap`→`badge-shipped` and the label text) — there's no array to flip.

3. **Docs prose callouts** — `src/pages/docs/*.astro` use a `<div class="callout roadmap wip">...</div>` block (styled in `src/styles/global.css:494-505`, classes `.callout.roadmap` / `.callout.roadmap.wip`) to mark whole sections as unshipped: `testing-modes.astro:19-23`, `regression.astro:43-47`, `getting-started.astro:53-56`, `journeys.astro:69-72` (self-healing) and `:75-80` (LM-driving), `mcp-cli.astro:71-75` (`queue_exploration`), and `docs/index.astro:23-30`. Shipping a capability means either deleting the callout (if the whole section is now shipped) or narrowing its copy (if only part of the section shipped — e.g. one of four testing modes).

Badge CSS classes for reference: `src/styles/global.css:485` (`.badge-shipped`), `:489` (`.badge-roadmap`).

## Per-ticket edits

### #10 — Goal-directed testing (ships with code #1)
- `src/components/TestingModes.astro`: entry with `tag: "goal"` (line 6-12) → `status: "shipped"`. Update `body` copy if needed to drop hedging language ("Jev drives toward the goal..." can stay, it's already present-tense).
- `src/components/Loop.astro`: remove the `<span class="badge badge-roadmap">Roadmap</span>` at line 20 (this section, "How exploratory testing will work," is explicitly called out by the ticket as losing its badge when goal-directed ships — even though the section is framed around the shared Observe→Verify loop, not goal-mode specifically). Update the `[ How exploratory testing will work ]` label and the "in active development" paragraph (lines 25-29) to present tense, and the section `id="how"` heading copy as appropriate.
- `src/pages/docs/testing-modes.astro`: the top roadmap banner (lines 19-23) currently reads "The Jev-driven testing engine is in active development." Narrow it to name only the still-unshipped modes (feature, exploratory, adversarial after this ticket — fewer as #11-#13 land). Do not remove the banner yet; other modes are still roadmap.
- `src/pages/docs/getting-started.astro`: the "In development" callout (lines 53-56) currently bundles `--goal` and `--strategy adversarial` into one roadmap line. Split it: add a new "live" code block demonstrating `jevitate explore --goal "..."` (verify the exact flag name against the shipped CLI — issue #10 says "matching the real CLI"), and narrow the roadmap callout to the flags that remain unshipped.
- Verify against code: confirm shipped CLI flag is literally `--goal` before publishing the live example; if the CLI ticket landed a different flag/verb, use that instead — do not invent syntax.

### #11 — Feature testing (ships with code #2)
- `TestingModes.astro`: `tag: "feature"` entry (line 13-20) → `status: "shipped"`.
- `testing-modes.astro`: Feature testing section (`<h2>Feature testing</h2>`, lines 35-41) — no roadmap-specific callout inline, just the shared top banner; narrow that banner further to drop "feature". Add a live CLI example if the ticket's "or the shipped verb" resolves to something concrete (issue #11 explicitly hedges on the exact flag — check the shipped CLI help output before writing copy).
- `getting-started.astro`: add `jevitate explore --feature <x>` (or the real shipped verb) to the live examples block; the current roadmap callout doesn't mention a feature flag today, so this is an addition, not a narrowing.

### #12 — Exploratory testing (ships with code #3)
- `TestingModes.astro`: `tag: "explore"` entry (line 21-28) → `status: "shipped"`.
- `testing-modes.astro`: Exploratory testing section (lines 43-49) currently only shows the maximize-new-states objective snippet. Add the real `jevitate explore` invocation and describe coverage-report output (issue #12 is explicit about this) — pull the actual output shape from the shipped CLI/coverage artifact rather than inventing a schema.
- Narrow the top banner further (drop "exploratory").

### #13 — Adversarial testing (ships with code #4)
- `TestingModes.astro`: `tag: "adversarial"` entry (line 29-36) → `status: "shipped"`.
- `testing-modes.astro`: Adversarial testing section (lines 51-60) — add a live CLI snippet showing `--strategy adversarial` as a working flag.
- `getting-started.astro`: move `--strategy adversarial` out of the roadmap callout (lines 53-56) into the live examples block (paired with #10's `--goal` move, this callout may become fully empty — see below).
- Narrow/likely retire the top banner in `testing-modes.astro` (lines 19-23): once #10-#13 have all landed, all four Jev-driven modes are shipped — delete the banner entirely rather than narrowing it to nothing. Regression (#14) has its own separate banner in `regression.astro`, so it doesn't block deleting this one.
- `getting-started.astro`: once both `--goal` and `--strategy adversarial` (and feature's flag, if it landed) have moved to the live block, delete the now-empty "In development" callout (lines 53-56) entirely, unless mission-scoping (#17) or another still-unshipped flag needs it kept.

### #14 — Regression & CI (ships with code #5)
- `TestingModes.astro`: `tag: "regression"` entry (line 37-44) → `status: "shipped"`.
- `src/components/Regression.astro`:
  - Line 26: `<span class="badge badge-roadmap">Roadmap</span>` → `badge-shipped` / "Available".
  - Lines 13-18 (`cli` const): drop the `# planned interface — see the roadmap` comment; replace with the real `jevitate` reproduce/run commands and real output.
  - Lines 31-36: rewrite "The planned flow..." to describe the shipped flow.
  - Lines 64-68: "Direct Playwright export is a candidate for a later slice" — resolve per whether Playwright export actually shipped in #5; if it did, describe it as shipped; if not, keep this line honest (still a candidate).
- `src/pages/docs/regression.astro`:
  - Delete the roadmap callout (lines 43-47).
  - Update description/lede (lines 35-41) to drop "designed regression flow" framing.
  - Resolve the Playwright-export sentence in the callout the same way as above before deleting — make sure the replacement prose (if any) still carries an accurate export status.

### #15 — LM-driving (ships with code #6)
- `src/components/Unified.astro`:
  - Lines 34-41 (LM-driving row): swap `badge-roadmap`/"Roadmap" → `badge-shipped`/"Available"; update body copy from "Jev makes typed driving decisions" (future-toned) to present tense.
  - Lines 69-73 (direction-spectrum note): per issue #15, mark **both** the Jev-directed and goal-based ends of the spectrum as shipped in this note's copy (the ticket ties both ends to this one code ticket — take that literally even though "goal-based" also reads like #10's territory; the site copy for this note is scoped by #15, not #10).
- `src/pages/docs/journeys.astro`: LM-driving section (lines 74-80) — replace the roadmap callout with shipped usage instructions (real command/verb for letting Jev drive; confirm against the shipped code before naming a command).

### #16 — In-flight self-healing (ships with code #7)
- `src/pages/docs/journeys.astro`: Self-healing section (lines 64-72) — currently states fail-closed is the *only* behavior today, then roadmap-callouts hybrid/full. Rewrite to present hybrid/full scoped re-learn + splice as shipped, and describe the policy gates (`SelfHealPolicy: fail-closed | hybrid | full`, already listed at line 5 of the `policy` const) — explain what each gate now does now that hybrid/full exist.
- `src/components/AvailableNow.astro`: the "Fail-closed self-healing" bullet (lines 10-14) implies fail-closed is the only mode. Update body copy so it doesn't imply fail-closed is exclusive (e.g. mention hybrid/full are available under policy) — this is a copy-only fix since `AvailableNow.astro` has no status field (everything in its `shipped` array is presented as already-shipped).
- Also check for any other landing copy implying fail-closed-only (issue #16 calls this out explicitly) — none found elsewhere in the current source at the time of this plan, but re-grep before editing in case other tickets' interim copy introduced new mentions.

### #17 — LLM-directed mission scoping (ships with code #8, #9)
- `src/pages/docs/mcp-cli.astro`:
  - Move `queue_exploration` from the roadmap callout (lines 71-75) into the live tools table (lines 48-61) as a new row, with its real shipped signature (confirm parameter names against code — the roadmap copy's `{ goal|feature|route, successAssertion, strategy, budget }` shape is a design sketch, not guaranteed final).
  - Document the "change-driven test-targeting agent skill" mentioned in the ticket — this doesn't exist anywhere in the current site copy; add a short paragraph/section once the shipped skill's real name and behavior are known from the code ticket.
- Landing copy: search for "hone in on what to test" or equivalent phrasing before editing — it does not currently appear anywhere in `~/working/jevitate-site/src` (confirmed by full-source grep during planning). If code ticket #8/#9 lands with new landing copy expectations, this may require a small new landing sentence rather than a flip of existing text; flag this to the requester rather than inventing marketing copy.

## Cross-cutting surfaces (fire on the last ticket in the #10–#13 group)

- `src/components/Hero.astro:19`: `<span class="badge badge-roadmap">Autonomous testing · in active development</span>` — flip to `badge-shipped` / "Autonomous testing · shipping now" only once goal+feature+explore+adversarial (#10-#13) have **all** landed. Don't flip early; the badge is a single aggregate claim.
- `src/pages/docs/index.astro`:
  - Lede (line 20): "...and, on the roadmap, drive autonomous testing" — update once #10-#13 are done.
  - Top callout (lines 23-30): the "In active development" list (goal, feature, exploratory, adversarial, regression emission) should shrink as each of #10-#14 lands, mirroring the narrowing done in `testing-modes.astro`'s own banner. Regression can drop off this list independently on #14 even before #10-#13 finish.
  - `<h2>The loop (roadmap)</h2>` (line 40) — drop the "(roadmap)" suffix once #10-#13 are all done.
  - "Available today" / "On the roadmap" lists (lines 52-63): move the `Testing Modes` link (line 61) from roadmap to available once #10-#13 are all done; move the `Regression & CI` link (line 62) from roadmap to available on #14 independently.

## Build & verify

From `~/working/jevitate-site`:
```bash
npm install          # first time / after dependency changes only
npm run build         # runs `astro build`; fails on broken Astro/TS syntax or bad imports
npm run preview       # optional local smoke check of the built output
```
`npm run build` is the authoritative check — Astro will fail the build on template errors in any of the `.astro` files touched above. There is no separate lint/test script in `package.json` (only `dev`, `build`, `preview`, `astro`), so a clean `npm run build` is the bar for "done" on each ticket.

## Commit & push (site repo, independent of `doit`)

The site repo is currently on branch `dev` (clean, tracking `origin/dev`), with `main`/`dev` both present locally and remotely, and past work merged into `dev` via PR (see `ca8ca3c`, `0a4982b` in `git log`). Follow that existing pattern per ticket:
```bash
cd ~/working/jevitate-site
git checkout -b site/<ticket-slug> dev        # e.g. site/10-goal-directed-available
# make the edits above
npm run build                                  # verify before committing
git add <files>
git commit -m "$(cat <<'EOF'
feat(site): present goal-directed testing as Available (closes #10)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
git push -u origin site/<ticket-slug>
gh pr create --repo matt-cochran/jevitate-site --base dev --title "..." --body "..."
```
One PR per site ticket keeps the pairing with its code ticket traceable; merge to `dev` only after the paired code ticket has actually merged and the claimed behavior is verified against it (flags, tool signatures, output shapes — see "Verify against code" notes above). Use the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer on every site commit, per instruction — this differs from the main repo's Claude Sonnet 5 trailer; don't mix them up.

## Risks / open questions

1. **No dedicated landing card for #17.** Unlike #10-#15, "LLM-directed mission scoping" has no `TestingModes.astro` entry or `Unified.astro` row — its only current site surface is the `mcp-cli.astro` roadmap callout. If the requester wants a landing-page presence for this capability, that's new content, not a flip, and should be scoped separately (or explicitly declared out of scope for #17).
2. **CLI flag/verb names are placeholders in several docs** (`--goal`, `--feature <x>`, `queue_exploration`'s parameter shape, the LM-driving "drive" verb). Each must be confirmed against the actually-shipped CLI/MCP surface before publishing — the plan flags every spot where this matters so the mechanical edit doesn't silently ship guessed syntax as fact.
3. **Playwright export ambiguity in #14** — both `Regression.astro` and `regression.astro` hedge on whether Playwright export shipped ("under consideration" / "a candidate for a later slice"). The site edit branches on that fact; get a definitive answer from code ticket #5 before writing final copy.
4. **Self-healing copy for #16 is a "don't imply fail-closed-only" bullet-copy fix, not a status flip** — `AvailableNow.astro` has no roadmap/shipped field, so this ticket is pure prose editing, easy to under-scope if treated like the badge-flip tickets.
5. **Aggregate surfaces (`Hero.astro`, `docs/index.astro`) span multiple tickets** — if #10-#13 ship out of order or with gaps, don't flip the aggregate badge/lists until literally the last one of the four lands; flipping early overclaims.
