# `allowedOrigins`: enforce at the browser, or retire the TODO (#521)

Status: proposal for the maintainer's decision. No code changes yet.

## Where things stand

- `OpenOptions.allowedOrigins` (`packages/playwright/src/browser-port.ts:94-95`) says it is "inert until route-level
  enforcement lands". That is not quite true. `PlaywrightBrowserPort` uses it to scope the `geolocation`
  permission grant (`playwright-browser-port.ts:200`, #329). It just never blocks a request. The `TODO(M3)` at
  `playwright-browser-port.ts:233-235` is stale.
- The origin boundary is checked after each action settles, and each mission handles a departure itself:
  - **Goal loop** (goal, find-out, author, usability): `checkSettled` stops the run as `blocked` as soon as the
    settled URL is off the allowlist (`packages/explore/src/goal-loop/settled-checks.ts:17-21`).
  - **Adversarial**: `observeAfter` records `{step, url, action}` in `departures`, adds a `scope-reset`
    transcript entry, opens a fresh page and restarts at the seed
    (`packages/explore/src/missions/adversarial-hunt/start.ts:286-316`). `inScope` is
    `scopePredicate(allowlist, routeGlobs)`, so another origin is out of scope (fails closed,
    `adversarial/scope.ts:78`, `adversarial-hunt/context.ts:303`).
  - **Coverage/exploratory (induction frontier)**: the departure is recorded and never expanded, and the next
    pop resets to the seed (`missions/induction-frontier/hang-departure.ts:82-90`, `context.ts:224`). The
    feature mission does the same (`missions/feature.ts:456`, `:500`).
- Write guards that already act at the network, through `page.route("**/*")` (`explore/src/read-only.ts:315`):
  - `ReadOnlyGuard` in `read-only` mode holds a find-out goal's first-party writes.
  - In `off-allowlist` mode (#403, adversarial) it aborts a misuse write to any origin outside `--allow`
    (`read-only.ts:332-350`, `#offAllowlist` at `:399`).
  - A held write that is a main-frame navigation is answered `204` instead of aborted, because "aborting it would
    leave the page on the browser's error page" (`read-only.ts:363-371`, #253/#402).
- `journey run` checks no live origin. With `--env` it refuses, before launch, any recorded step on an origin
  outside the environment (`cli/src/environments.ts:383`). During the replay it only *observes* off-allowlist
  writes (`watchOffAllowlistWrites`, `cli/src/journey-api.ts:598`, `:692`, #485).

## Every caller of `PlaywrightBrowserPort.open` (production)

`graft callers open --depth 2` returns 31 definitions named `open`, and it drops ambiguous cross-file edges. The
list below is therefore graft plus a grep for `.open(` call sites outside tests.

| Caller | What opens it | May it legitimately leave the allowlist? | Enforce under A? |
|---|---|---|---|
| `cli/src/explore-goal.ts:470` (+ `explore-author.ts`, `ux-usability/setup.ts:114`) | goal / find-out / author / usability missions | No. It already stops `blocked`. A `--success` goal of "sign in with Google" needs the IdP in `--allow` today too | Yes |
| `cli/src/explore-coverage.ts:266`, `explore-feature.ts:217` | coverage / exploratory / feature | No. It records the departure and resets | Yes |
| `cli/src/explore-adversarial.ts:254` | adversarial | No. It records the departure and resets | Yes |
| `cli/src/explore-shared.ts:181` `freshSessionOpener` | fresh pages for the missions above | Same as its mission | Yes |
| `cli/src/mission-actors.ts:71` `observerSessions` (+ `verify-fix-api.ts:537`) | observer personas in multi-actor missions | No | Yes |
| `cli/src/verify-fix-api.ts:545` | verify-fix replay of a mission finding | No (mission semantics) | Yes |
| `cli/src/defect-evidence.ts:221` | evidence re-run (video/screens) | Replays a mission path: no | Optional |
| `cli/src/persona-login.ts:713`, `:763`, `:863` | `jevitate login` and persona sign-in / verify | **Yes.** An SSO `/authorize` hop through an IdP. Credentials are typed only on an allowlisted page (`assertPageAuthorized`, `:449-455`), but a pass-through hop with no typing needs no `--allow` today | **No (exempt)** |
| `cli/src/journey-api.ts:588` | `journey run`, campaigns, `check` suites | **Yes.** A recorded Journey may cross to checkout, an IdP or OAuth. Without `--env` the list is just `[site]` (`:517`) | **No.** It would break recorded Journeys |
| `cli/src/source-run-api.ts:81` | trusted remote Journey | Yes, through `declaredOrigins` (`:76`) | No (Journey semantics) |
| `cli/src/load-api.ts:110` | load actors replaying a Journey | Same as a Journey | No |
| `cli/src/cli-shared.ts:263` `makeRealBrowserActor` | regression capture/run (`regression-cli.ts:170`, `:296`) | Same as a Journey | No |
| `cli/src/demo-capture.ts:1096`, `journey-demo-api.ts:359` | demo / `journey demo` (wrapping ports) | Yes. A demo may show the checkout or IdP | No |
| `cli/src/record-api.ts:81` | `jevitate record` (headed, human-driven) | Yes. The human drives | **No (exempt)** |
| `explore/src/testkit.ts:26` and `*.served.test.ts` | tests | n/a | n/a |
| `sweep` (`cli/src/sweep-api.ts:1069`) | runs `explore` per target as a subprocess | Same as the strategy it runs | (inherits) |

No caller handles popups (no `on("page")` / `on("popup")` anywhere outside tests). Missions act only on
`session.page`, so an OAuth popup opens a page that nothing ever reads or acts on.

## The four questions

**1. What is blocked?** Only top-level navigations (`request.isNavigationRequest()` in the main frame), and
optionally subframes, to an origin outside the allowlist. Subresources keep loading (CDNs, fonts, analytics,
third-party fetch/XHR). Blocking those would break real apps and contradict `docs/safety.md:26-28`.

Two Playwright facts limit what any route-level guard can do:

- **Redirects are invisible to `route`.** The handler runs only for the first URL of a redirect chain. A server
  `302` from an allowlisted page to an IdP or any other origin still loads. The post-settle URL check therefore
  stays necessary under every option. Route enforcement only catches *initiated* navigations: link clicks,
  `location.href = …`, form GETs.
- **Routing disables the HTTP cache** for the page. Today only adversarial and read-only find-out runs pay that
  cost, because they are the only ones with `ReadOnlyGuard` armed. Arming a route for every goal or coverage run
  changes load timing for all of them, which bears on hang and settle thresholds.

**2. How does a blocked navigation show up?** If it is aborted (`route.abort("blockedbyclient")`), the page does
**not** stay in place. A main-frame abort lands the page on Chromium's error page (`chrome-error://chromewebdata/`).
The repo already depends on this fact (`read-only.ts:363-368`). The consequences:

- The goal loop then sees an unauthorized URL and stops `blocked`. Adversarial and coverage record a departure
  to `chrome-error://…` and lose the real target URL.
- The noise has several readers, and they treat it differently:
  - `PageSignalCollector` drops `ERR_BLOCKED_BY_CLIENT` from both console and `requestfailed`
    (`adversarial/defect-oracle.ts:206`, `:255`), so it never becomes a defect.
  - `blocked-cause.ts:14` links later "Failed to fetch" findings to a blocked *write* only (#484), not to a
    blocked navigation.
  - **`isUnreachableTarget` matches any `net::ERR_*`** (`explore/src/mission-failure.ts:75`). If the seed
    redirects to an IdP via JS, that becomes "target unreachable" instead of today's "session is not
    authenticated" (`seed-redirect.ts`, #82).
  - The **UX friction** pass counts a failed `document` request as an `error` friction unless it is
    `ERR_ABORTED` (`ux/src/friction.ts:160-168`, `cli/src/usability-capture.ts:266`).
  - `observeBrowserSignals` writes it as an error-level `requestfailed` line for log triage
    (`cli/src/signal-triage.ts:136-145`).

Answering the navigation `204` instead (the `ReadOnlyGuard` pattern) keeps the page where it is and emits no
`ERR_BLOCKED_BY_CLIENT` at all. But it is silent: the guard must then record the departure itself (target URL,
step), and every mission must drain that record after the settle. The goal loop must still stop `blocked` on it,
otherwise "never a silent no-op" fails.

**3. Flows that legitimately leave.** Persona login / SSO (pass-through IdP hops), OAuth popups (not acted on
today), `journey run` / `source run` / load / regression replays of recorded cross-origin flows, demo capture,
and the headed recorder. `--allow` origins are simply part of the allowlist.

**4. Who gets enforcement.** At most the mission sessions marked "Yes" above. Never the recorder, persona login,
Journey replays or demos.

## Options

- **(A) Navigation-only enforcement, mission sessions only.** Add an opt-in field (for example
  `blockOffAllowlistNavigation: true`) passed only by the mission launchers. A `context.route` handler (so
  popups are covered) answers off-allowlist main-frame and subframe navigations `204`, records
  `{url, step}` as a departure, and calls `route.fallback()` for everything else so it composes with
  `ReadOnlyGuard`. Benefit: an off-allowlist page never loads or runs scripts. Costs: no HTTP cache on every
  mission; redirects still pass; a new departure channel that all four mission loops must consume.
- **(B) Full route enforcement** (all requests, all sessions). It breaks CDNs, IdPs, Journeys and demos, and
  `docs/safety.md:26-28` promises the opposite. Rejected.
- **(C) Keep it advisory: delete the TODO and document the field truthfully.** Keep the name: `allowedOrigins` is
  accurate, it does scope the geolocation grant, and renaming it touches ~20 production call sites plus their tests for no
  behavioural change. Replace both comments with: "the session's authorized origins: scopes the geolocation
  grant; not a network guard — the acting origin is checked by the caller after each settle (redirects cannot be
  intercepted), and writes by `ReadOnlyGuard`; see docs/safety.md".

## Recommendation: C now, with A kept as a specified follow-up

Choose C. A route guard cannot replace the post-settle check, because redirects bypass it. Every mission already
handles a departure: it stops, or it resets and does not expand. A would add a second departure path, turn off
the HTTP cache on every mission, and still need the `chrome-error`/`204` and `ERR_BLOCKED_BY_CLIENT` handling
above. The only thing it buys is that the off-allowlist page never runs, and that page runs today with no
credentials typed, no actions taken on it, and misuse writes already blocked (#403). If the maintainer wants that
anyway, implement A exactly as specified (`204`, `context.route`, opt-in, mission sessions only).

**Tests for C** (served, in `packages/explore` / `packages/playwright`):
1. The goal mission clicks a link to a second local origin. The run stops `blocked`, and the transcript names the
   landed URL (pins the post-settle guard as *the* enforcement).
2. Adversarial/coverage: the same click is recorded in `scope.departures` with the second-origin URL, the run
   resets, and no finding is produced.
3. A page on the allowed origin loads a script and image from a second origin. Both load, and there is no
   departure (`allowedOrigins` does not block subresources).
4. A `302` from the allowed origin to a second origin is a departure in the mission, the same as a click.
5. The existing #329 geolocation test still grants only to `allowedOrigins` (the field's one browser-side effect).

**Additional tests if A is chosen:**
1. A blocked main-frame navigation is recorded as a departure carrying its target URL. The page URL is unchanged,
   not `chrome-error://`, and the goal loop stops `blocked`.
2. A cross-origin subresource and fetch/XHR still load while the guard is armed.
3. An SSO redirect through an allowlisted IdP completes, and persona login through a non-allowlisted IdP hop
   behaves as it does today (the login session is exempt).
4. With `ReadOnlyGuard` armed too, a held write is still `204`'d or aborted and listed in `blockedWrites`
   (handlers compose through `fallback`).
5. A seed that JS-redirects to a login IdP is still reported with the #82 login-like reason, never "target
   unreachable".
6. There is no `requestfailed`/console defect, no UX `error` friction and no error-level triage signal for the
   blocked navigation.
7. `journey run`, `record`, `demo` and `login` sessions are untouched: a recorded cross-origin step still
   replays.
