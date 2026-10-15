---
name: jevitate-promotion-ready
description: Hand a Journey to its owner only when the review sheet is clean — `jevitate journey review <id> --strict` (MCP `review_journey` with `strict: true`) exits 0 — and give them the ordered approval commands. Use when you authored or recorded a Journey and are about to say it is done, or when asked to get one ready to promote.
---

"Done" for a Journey is NOT "lint 0/0, run green, `verify --mutate` proven". It is
`jevitate journey review <id> --strict` passing: the owner reads that same sheet, and every
⚠ you leave on it costs them a review-fix-review round. `--strict` exits 1 on any ⚠
attention item (weak or missing proof, no goal or success criteria, no job or persona link,
an unapproved catalog link, a stale proof) and runs the code-only job/persona link checks
without `--readiness`. ○ items (such as a skipped Jev review) never fail it.

## The workflow (in this order)

1. **Author** the Journey (`explore-author-journey` in `jevitate-explore`, or
   `jevitate-record`). Read `journey lint <id>`; fix errors.
2. **Link a job and a persona.** Set `metadata.job` / `metadata.persona` in the Journey file
   to ids listed in `.jevitate/personas.json` / `.jevitate/jobs.json` (`jevitate catalog status` shows them). `journey lint` warns
   `missing-job` / `missing-persona` with the fix. If none fits, add a DRAFT (never approved):
   `jevitate catalog draft persona <id> --name "<who they are>" [--description "<text>"]` and
   `jevitate catalog draft job <id> --name "I want to …" [--description "<goal>"]
   [--trigger "When …"] [--outcome "so I can …"]` (MCP `catalog_draft`). Fill any
   `(draft: …)` placeholder with real text. An existing id is refused (exit 64).
3. **Draft the annotation:** `jevitate journey annotate <id> --env <non-production> --real`
   (MCP `annotate_journey`) writes a draft only. Review it with the owner or edit the JSON;
   applying it (`--approve`) is the owner's step, listed below.
4. **Run it on a non-production environment:** `jevitate journey run <id> --env <name>`.
   Never prove or annotate against production.
5. **`jevitate journey verify <id> --mutate --env <name>` LAST** (MCP `verify_journey`).
   The proof is keyed on executable content only (steps, targets, assertions, end state), so
   rewording goal, success criteria, objectives or expected results (what `annotate --approve`
   writes) does not stale it. Exception: annotating drops a success criterion's code `check`
   when that criterion is reworded, which does stale it. Any edit to a step or assertion
   stales it: re-run `verify --mutate` after the last such edit.
6. **`jevitate journey review <id> --strict`** (add `--json` for `strict: { passed, warnings }`).
   Fix every ⚠ it names and rerun until it exits 0. Do not hand over before then.
   `--stale --strict` is refused.
7. **Hand the owner the ordered command list**, each with `--reviewed-hash`.

## The owner's commands (human-only)

Get each hash from the sheet the owner will read: `journey review <id> --markdown` ("Approve"
section), `persona review <id>` and `job review <id>` (each shows its content hash). Approve
in this order, because a Journey whose linked job or persona is unapproved cannot promote:

```bash
jevitate persona approve <persona-id> --reviewed-hash <hash>
jevitate job approve <job-id> --reviewed-hash <hash>
jevitate journey annotate <id> --approve          # applies the reviewed wording draft
jevitate journey review <id> --strict             # re-check, then read the sheet; note the new hash
jevitate journey promote <id> --reviewed-hash <hash>
```

Approving annotation text changes the Journey's content hash, so the hash for `promote` is the one
from the review AFTER `annotate --approve`. Persona, job and promote approvals each need an
interactive terminal. You NEVER run `persona approve`, `job approve`, `journey annotate
--approve` or `journey promote`, never pass `--non-interactive-approval`, and never use
`promote_journey` unless the human tells you to (it is recorded as an agent's approval and never
counts as sign-off). Say plainly in the handoff which of these are theirs.

## Repo-wide gate

`jevitate catalog status --strict` (MCP `catalog_status` with `strict: true`) exits 1 on a stale
persona/job approval, or on a promoted Journey that links an unapproved or unknown catalog entry
or no job/persona (`--json`: `strict.violations`). Use it in CI beside `jevitate check`
(`jevitate-ci-check`); it does not replace `--require-approvals`.

## MCP equivalents

`review_journey` (`strict`), `lint_journey`, `annotate_journey`, `verify_journey`,
`catalog_draft`, `catalog_status`. Approvals have no MCP form except `promote_journey`, which you
do not call on your own. For promotion details see `jevitate-run-journey` ("Promoting a Journey").
