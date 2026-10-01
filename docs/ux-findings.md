# UX findings: claims verified by code

`jevitate ux <recording>` and `jevitate explore --strategy usability` report usability findings.
Since 0.3.0 (#198) every such finding is a **claim that code verified**. A model never decides on
its own that something is a problem, and it never writes the finding's text.

## How a finding is made

1. **Claims start from what the run observed, not from a checklist.** A claim comes from one of
   three places:
   - a **guard probe**: the live run clicks every control that the shared safety policy calls
     destructive ("Delete", "Remove", "Revoke", "Close account"…), once per page, with every
     write request blocked (see [Guard probes](#guard-probes));
   - the **product facts** in `.jevitate/product.json`: a price or trial length on the screen
     that contradicts them, and each page whose intended next step they name;
   - **observed friction** that no run signal already explains: the run retried, waited, hit a
     dead end, met an error, went back, abandoned a form, or did not finish the job.
2. **Jev categorizes friction.** For each friction point Jev picks a claim type from a closed list
   (or `not-a-problem`). It also picks the control the friction is about from the page's real
   controls. The list is kept under the 255-choice cap, ranking the controls the friction's own
   steps acted on first (#192).
3. **Code verifies every claim.** A claim that fails is dropped. It is counted in the report's
   claim ledger and never shown.
4. **Duplicates merge.** The same claim type on the same page and control merges in code. A
   finding that shares a page or control with an earlier one gets one Jev duplicate choice. A
   merged finding stays visible as `contributing` on the finding it joined.
5. **Two yes/no questions grade it.** Jev answers "Do we need this?" (`need`) and "Do we need this
   to complete and ship this feature?" (`ship`). The feature is the product-facts journey that
   passes through the page, else the run's job. Code maps the two probabilities to a label:

   | need | ship | label |
   |---|---|---|
   | ≥ 0.5 | ≥ 0.5 | `actionable` |
   | ≥ 0.5 | < 0.5 | `relevant-minor` |
   | between 0.2 and 0.5 | any | `generic` |
   | ≤ 0.2 | any | `wrong` |

   The cutoffs live in `packages/ux/src/assets/ux-claims.json`. The raw answers are on the
   finding as `grade: {need, ship}`. As before, the grade labels a finding and hides nothing
   unless you pass `--show`.
6. **The text comes from a template** filled from the verified fields: the control, the page,
   the blocked request, the quoted text and the expected fact. `--polish` is opt-in: it rewrites
   each verified finding's recommendation with one generation call and keeps the citation.

The rubric still supplies each finding's citation. A claim type is cited under the heuristic it
violates, but the rubric no longer produces findings by itself, so `heuristicAppendix` is empty.

## Claim types and what code checks

| Claim type | Source | Verified when | Cited under |
|---|---|---|---|
| `destructive-unguarded` | guard probe, or friction | The guard probe clicked the control, a write request was attempted (and blocked), and no confirm dialog, page dialog or confirmation page came first. | nielsen-5 (Error prevention) |
| `fact-conflict` | product facts | A plan's price or a trial length on the screen differs from every listed value in the same currency and interval. The quote must be on the screen. | nielsen-4 (Consistency) |
| `next-step-unclear` | product facts, or friction | With facts for the page: no control names the intended next step, or it is disabled everywhere, or the run hit navigational friction there and never took it. Without facts: navigational friction (backtrack, abandoned step, dead end, unfinished job). | primary-action |
| `no-feedback` | friction | Retry or long-wait friction, on the chosen control if one was chosen. | nielsen-1 (System status) |
| `blocked-action` | friction | Dead-end friction on the chosen control, or the chosen control is disabled. | nielsen-9 (Error recovery) |
| `error-unrecoverable` | friction | Error friction (a 4xx/5xx or failed request after the user's action). | nielsen-9 |

A friction claim whose type does not match the friction (for example `error-unrecoverable` on a
retry) is refuted. A friction claim that names a control the friction's steps never touched is
refuted too. Both are counted as suppressed with reason `unverified`. Friction that Jev calls
`not-a-problem` is suppressed with reason `not-a-problem`. Both count against a `clean` report,
because the friction was real.

When guard probes exist, a destructive claim on a control they never probed is refuted: the probe
covers every control in the destructive vocabulary, so that control isn't destructive. Offline,
without probes, the claim is **unverifiable**. It is listed under `coverage.skipped`
(`claim:destructive-unguarded`) and is never a finding.

## Guard probes

After the run's loop ends, the live usability run opens a dedicated page in the same browser
context (same session). On that page it:

- loads each analyzed screen that shows a destructive control, and clicks the control once per
  page and control;
- blocks every write request: anything other than GET/HEAD/OPTIONS, plus any request whose path
  names a destructive verb (`/items/1/delete`). Nothing the probe clicks reaches the server;
- dismisses a native `confirm`/`alert` and notes it. It also notes a page dialog
  (`dialog[open]`, `role=dialog`/`alertdialog`, `aria-modal`) and a navigation to another page;
- never clicks a control matching `--deny`. Such a control is recorded as `refused`.

The probes are written to the evidence sidecar (`probes`, redacted), so `jevitate ux` on that
Recording verifies the same claims offline. The probe page's video, if one is recorded, is deleted.

Limits: WebSocket messages and service-worker requests are not blocked. A destructive action that
runs only in the browser, with no request, reads as "no write attempted" and is refuted. A
control that only appears after state the run built up (an open menu, a selected row) may not be
visible on a fresh load. It is then recorded as `not-found` and is unverifiable. At most 25 controls are probed per run; the rest are recorded as not
probed and are unverifiable.

## Product facts (`.jevitate/product.json`)

The file states what the product is. The review reads `--product <file>` if given, otherwise
`.jevitate/product.json` in the project (found by walking up from the working directory). With no
facts file, the report adds an evidence caveat saying prices and next steps went unchecked.

```json
{
  "version": 1,
  "product": "Example",
  "currency": "USD",
  "plans": [
    { "name": "Starter", "prices": [{ "amount": 29, "interval": "month" }], "trialDays": 14 },
    {
      "name": "Pro",
      "aliases": ["Professional"],
      "prices": [
        { "amount": 149, "interval": "month" },
        { "amount": 1490, "interval": "year" }
      ],
      "trialDays": 14
    }
  ],
  "journeys": [{ "name": "Set up a workspace", "routes": ["/onboarding", "/projects/:id"] }],
  "pages": [
    { "route": "/onboarding", "nextStep": "Create project", "alternatives": ["Import", "Skip for now"] }
  ]
}
```

| Field | Meaning |
|---|---|
| `version` | Always `1`. |
| `currency` | ISO 4217 default for every price (default `USD`). A price can set its own `currency`. |
| `plans[].name`, `aliases` | How the plan appears on screen. Names and aliases must be unique, ignoring case. |
| `plans[].prices[]` | `amount` in major units, `interval`: `month`, `year`, `week`, `day` or `once`. |
| `plans[].trialDays` | The free trial's length, if there is one. |
| `journeys[]` | Key journeys: a `name` and the `routes` they pass through. A finding on one of those routes is graded against that journey ("ship this feature"). |
| `pages[]` | `route` (a path; `:param` and `*` match one segment), `nextStep` (the visible name of the intended primary next step), `alternatives` (other options the page should keep; documentation only, never flagged). |

The file is validated strictly. Every problem is reported with its JSON path in one refusal:
`E_UX_PRODUCT_INPUT`, a usage error (exit 64), returned before a browser opens. That includes an
unknown key, a bad route, a negative price, a duplicate plan name or route, and a file that can't
be read.

How prices are matched: an amount counts as a plan's price only when the plan's name or alias is
on the same line before it, or on a heading line just above it (a pricing card). An amount
introduced as a saving or a former price ("Save $240", "was $199") is not a price. An amount in a
currency or interval the facts don't list is not compared. An amount that matches any of the
plan's listed prices is consistent: "$1,490 per year" for Pro is fine.

## Screenshots

On a live run, each verified finding that cites a control or quotes text gets a **cropped**
screenshot with that element **boxed**: `finding.screenshot = {path, target, box}`, written to
`usability-<stamp>.findings/`. `box` is the element's position inside the cropped image. The
capture uses the run's pixel mask (docs/safety.md), so registered secrets, marked elements and
credential-shaped values are masked. If the mask can't be proven, no screenshot is written.

**The judge does not see images.** The Jev judgment API (`@typesafe-ai/sdk` 0.6) takes text state
only, so every Jev question is answered from the redacted page text and controls. Screenshots go
into the report only. If Jev gains image input, visual claims (hierarchy, primary action) are the
ones that should get the cropped image.

## Report fields (additive, `schemaVersion` 1)

- `report.claims`: the claim ledger. It has `candidates`, `verified`, `merged`, `refuted`,
  `unverifiable`, `dismissed` and `budgetTruncated`, plus `items[]`, where each item has `type`,
  `source`, `route`, `screenId`, `target`, `friction`, `status` and `reason`. Every claim is
  accounted for.
- `finding.claim`: `{type, source, verifiedBy, verification, target}`.
- `finding.grade`: `{need, ship}`.
- `finding.screenshot`: `{path, target, box}`.
- `report.suppressed.byReason` gains `unverified` and `not-a-problem`.
- Evidence sidecar: `probes[]`.

## Acceptance fixtures

The fixture set is in `packages/ux/src/claims-fixtures.test.ts` (pure, with scripted evidence) and
`packages/cli/src/ux-claims-served.test.ts` (the same pages in real Chromium, with the real probe).
Each page plants one real problem the review must catch and one look-alike it must not flag:

| Fixture | Must catch | Must not flag |
|---|---|---|
| Admin queue | "Delete user" deletes at once | "Approve"/"Reject" act without confirmation (routine, not destructive) |
| Members | "Remove all members" removes at once | the "…" menu's "Remove", which asks first |
| Pricing | Pro at $129/month (facts: $149) | Starter at $29/month, "Save $240 a year" |
| Danger zone | "Delete workspace" deletes at once | "Delete draft", which opens a confirmation dialog |
| Onboarding | "7-day free trial" (facts: 14 days) | the obvious, taken next step "Create project" |

Both suites check that every planted problem is caught, graded `actionable`, and that no
look-alike appears in any finding. The served suite also checks that not one write reached the
server, that the screenshot is cropped and boxed, and that offline review over the sidecar
reproduces the live findings.

## Still needs real-model calibration

The fixtures run with **scripted** Jev answers. They prove the pipeline and code's verification,
not the model. A real-model pass, one edge case at a time, still needs to check:

- Jev's **friction categorization**: claim type and target control on real friction, and how
  often it says `not-a-problem` for real problems;
- the **two-question grade cutoffs** (`need`/`ship`/`wrong`): whether real-model probabilities
  separate needed-to-ship from nice-to-have at 0.5 and 0.2;
- the **duplicate choice**: whether it merges only true duplicates;
- `--polish`: whether polished wording stays specific.

The report says so in `calibrationCaveats`.
