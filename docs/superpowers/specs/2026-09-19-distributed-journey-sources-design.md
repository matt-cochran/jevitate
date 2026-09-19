# Distributed Journey Sources (Catalog Federation) — Design

**Status:** Proposed (north star agreed in brainstorming 2026-09-19; FMECA-vetted below). **Sequenced after Slice 1** — depends on the `Journey` + `JourneyRegistry`. Plan follows when Slice 1 is complete.
**Date:** 2026-09-19
**Product name:** **Jevitate**. Engine repo: `github.com/matt-cochran/jevitate`. Content repos: `jevitate-<tool>` (e.g. `jevitate-gmail`). (Monorepo packages remain `@doit/*` for now — renaming is deferred, out of scope here.)
**Extends:** `2026-09-19-unified-journey-automation-and-testing-design.md` (the `Journey`/`JourneyRegistry`, the six hard floors, the origin-binding secret invariant). Guardrails there remain binding; this doc adds feature-specific binding rules (§9) that compose with them.

---

## 1. Goal

Make the dynamically-built **Journeys** collaborative: host them in **external git repos** (never the engine repo), cloned/pulled to the local filesystem under a convention, so people co-develop automations per tool. The engine (`jevitate`) is the runtime; the `jevitate-*` repos are the shareable content. Consuming (pull/discover/run) **and** publishing (author locally → contribute back) are both in scope.

## 2. Core model — sources, lockfile, addressing

- A **`JourneySource`** yields Journeys to the `JourneyRegistry`. Two impls: **`LocalSource`** (the Slice-1 `FsJourneyStore`) and **`RemoteSource`** (a pinned git clone).
- Remote sources are git clones under a managed dir (e.g. `<data>/sources/<name>/`). Each is **pinned to an exact commit** recorded in a shareable **`jevitate.lock`** (`{ sources: [{ name, gitUrl, pinnedCommit }] }`) — a team reproduces the same catalog by sharing the lockfile.
- **Addressing:** a capability is `<source>/<id>` (e.g. `gmail/archive-thread`) to avoid cross-source id collisions. Source **names are namespaced by git URL** (anti-typosquat); `source add` shows the full URL and requires an ack.
- Operations: `source add <git-url> [name]`, `source list`, `source pull` (fetch, keep pin), `source update <name>` (advance the pin, explicit), `source remove <name>`.

## 3. Repo convention (`jevitate-*`)

- Root **`jevitate.json`** manifest: `{ source: string, sites: [{ origin, automationPolicy: "allowed", touBasis: string }] }` — declares the source name and, per target origin, that automation is authorized plus a human `touBasis` justification (see §8).
- A **`journeys/`** dir of `<id>.journey.json` files, each matching `JourneySchema` (closed schema) plus source metadata: `declaredOrigins: string[]` (every origin the Journey may touch). The engine scans the pinned clone.
- **Risk is engine-derived, never author-declared** (§6) — the manifest cannot downgrade a Journey's risk.

## 4. Federated discovery

`JourneyRegistry` composes N sources. `find(query)` / `find_capabilities` merges across all of them, tagging each result with **source, pin (commit), engine-derived riskClass, and trust status**. Ranking is deterministic now; Jev-rankable when the judgment gateway lands (umbrella Slice 4).

## 5. Tiered trust

- **Source trust** — established by `source add` + pin (+ the URL ack). Covers **discovery** and running **read-only** Journeys within their declared origins.
- **Per-Journey review** — required before running any **risky** Journey (§6). `journey trust <source>/<id>` records a **`TrustRecord { sourceId, journeyId, contentHash, approvedBy, approvedAtIso }`** bound to the exact **content hash** of the reviewed Journey.
- At run time: verify the pinned content's hash == the trusted hash. **Any mismatch (a source update changed the bytes) ⇒ fail-closed, re-review required** — closes the time-of-check/time-of-use gap.

## 6. Risk classification (engine-derived poka-yoke)

The engine computes `riskClass` by scanning the Journey's steps — the author cannot set or downgrade it:
- **read-only:** only `navigate` / `waitFor` / `extract` / `assert` steps, all within `declaredOrigins`.
- **risky:** anything else — any `click` / `fill` / `select` / `press` / `handback` (secret), or any action that could leave `declaredOrigins`.

Conservative by design: anything that *acts* is risky and needs per-Journey review; only pure reads run under source trust. Reuses the self-heal read/write split and the origin-binding secret invariant.

## 7. Reproducibility

Runs resolve against the **pinned commit** only; `jevitate.lock` is the record; `source update` is the sole way to advance a pin and is explicit. "What you reviewed is what runs" holds end-to-end (pin + content-hash trust record).

## 8. ToU authorization (honest enforcement)

The engine cannot verify a site's terms of use. So it makes authorization **declared + acknowledged + fail-closed**:
- The manifest declares, per origin, `automationPolicy: "allowed"` + a human `touBasis`.
- `source add` **surfaces** these declarations and requires an explicit **ack**; the ack is recorded.
- A target origin with **no declared authorization ⇒ its Journeys cannot be promoted or run** (fail-closed).
This turns "only tools without a 'no-automation' clause" from an honor-system README into a visible, recorded gate — the human still owns the ToU judgment, but the engine forces the declaration and blocks undeclared targets.

## 9. Feature-specific hard floors (compose with the umbrella's six)

7. **Secret references only.** A shared Journey carries secret **references** (manager key + origin + field), never values — enforced on **both** publish and import; any embedded/materialized secret value hard-blocks.
8. **Reviewed, pinned, in-origin, or refuse.** A Journey runs only its exact **hash-pinned, reviewed** content **within its declared origins**. Unknown source, hash mismatch, undeclared origin, untrusted risky Journey, or undeclared-ToU target ⇒ **fail-closed**.
9. **Flat sources.** No transitive/auto-added sources; adding a source is always an explicit, acknowledged act.

## 10. Publish (contribution loop)

`journey publish <local-id> --to <source> [--as <id>]`:
- Validate: closed schema; **secrets references-only** (a materialized/real secret value hard-blocks); `declaredOrigins` present and covering the Journey's steps.
- Write `journeys/<id>.journey.json` into the source clone on a **new branch**, commit, push, and open a **PR** (via `gh` if present).
- **Explicit per-id, with a preview/diff — never auto-publishes**, never pushes to a source's default branch directly.

## 11. Surfaces

- **CLI:** `source add|list|pull|update|remove`, `journey trust <source>/<id>`, `journey publish <id> --to <source>`; `journey find|run` are already federated (find across sources; run `<source>/<id>`).
- **MCP:** `find_capabilities` federated + source-tagged; `run_journey("<source>/<id>", params)` enforces the full gate — trust + pin + hash + risk + declared-origin + ToU — behind the existing allowlist boundary.

## 12. FMECA (focused supply-chain vetting)

| # | Failure mode | Cause | Effect | S | P | Mitigation (Prevent / Detect / Fail-fast) | Res S | Res P |
|---|---|---|---|---|---|---|---|---|
| 1 | Journey steers to attacker origin (phish/exfiltrate) | Steps navigate/fill outside declared origins | Credential/data theft | H | M | **P:** engine-derived `declaredOrigins`; pre-nav/pre-fill origin check; secret fill origin-bound (umbrella #3). **D:** off-origin action detected. **F:** refuse | H | L |
| 2 | TOCTOU — source changes after review | Bytes change under the pin/trust | Unreviewed code runs | H | M | **P:** `TrustRecord` bound to content hash; **D:** run verifies pinned-hash == trusted-hash; **F:** mismatch → re-review | H | L |
| 3 | Secret value smuggled into a shared Journey | Author embeds a credential/materialized value | Credential leak in a shared repo | H | M | **P/F:** publish + import guards reject any non-reference / materialized secret value (references only) | H | L |
| 4 | ToU violation via a shared Journey | Automating a no-automation site | ToS breach | M | M | **P:** manifest per-site declared authorization + ack at `source add`; **F:** undeclared origin → no run | M | L |
| 5 | Typosquat / impersonating source | `jevitate-gmial` etc. | User adds a hostile source | M | M | **P:** names namespaced by gitUrl; `source add` shows full URL + ack; `<source>/<id>` addressing | M | L |
| 6 | Author self-downgrades risk to skip review | Manifest claims read-only | A write Journey runs unreviewed | H | M | **P:** `riskClass` is **engine-derived** from steps, not author-declared | H | L |
| 7 | Publish leaks a private/local Journey | Accidental over-share | Private automation exposed | M | M | **P:** explicit per-id publish with preview/diff; never auto-publish; validated before push | L | L |
| 8 | Non-reproducible run (source drift) | "Latest"/unpinned source | Different run than reviewed | M | H | **P:** commit-pinned lockfile; explicit `update`; run resolves the pinned commit only | L | L |
| 9 | Supply chain via transitive sources | A source auto-adds others | Unbounded trust | M | L | **P:** flat sources; no transitive auto-add | L | L |

Residual: modes 1,2,3,6 keep inherent High severity (credential/exfiltration/unreviewed-execution) driven to Low probability + made permanent tested contracts; 4,5 Medium-severity accepted at Low probability; the rest Low. No further severity reduction without removing the collaboration capability.

## 13. Composition & sequencing

- **Reuses:** `Journey`/`JourneyMetadata`/`JourneySchema`, `JourneyRegistry`, `find_capabilities`/`run_journey`, the promotion gate, `RunPolicy`, and the origin-binding secret invariant — all from Slice 1.
- **New:** `JourneySource`/`RemoteSource`, `jevitate.lock` + source manager (git clone/pin), the manifest/convention loader, engine-derived risk classifier, `TrustStore`/`TrustRecord`, the ToU declaration+ack gate, and the `publish` contribution flow.
- **Sequencing:** a **new slice after the umbrella roadmap's Slices 1–6** (a Journey artifact + registry must exist first). Pairs naturally with promotion and the 2-level MCP find. Publish can be split into its own sub-slice if the consume path should land first.

## 14. Open decisions / deferred
- **Lockfile + sources dir location:** project-root `jevitate.lock` + `<data>/sources/` vs a user config dir — resolve at planning; must be shareable and reproducible.
- **Content-hash canonicalization:** the exact canonical JSON form hashed for `TrustRecord` (stable key ordering) — pin at planning.
- **PR mechanism:** `gh` CLI when present, else emit branch+push instructions; degrade gracefully.
- **Manifest schema versioning:** `jevitate.json` needs its own `version` for forward compat.
- **Trust revocation / audit:** listing + revoking trust records (later).

## 15. Honest hard parts / risks
- **The whole feature is a new trust boundary** — the FMECA modes above are the load-bearing contracts; each becomes a fail-fast invariant with an "asserts-it-refuses" test (same discipline as the umbrella §9a).
- **Engine-derived risk** must be conservative and not fooled by the author (mode 6) — the classifier reads steps, never the manifest's claims.
- **ToU is human judgment** — the engine enforces *declaration + ack + fail-closed on undeclared*, but cannot certify a site's terms; the spec is honest that this is the boundary of what software can do.
- **Publish must never leak secrets or over-share** — explicit, previewed, validated, references-only.
- **Reproducibility hinges on pinning + hashing** — a run that can't resolve its pinned commit fails closed rather than falling back to latest.
