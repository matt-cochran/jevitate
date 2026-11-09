# Run modes and target trust

A Journey run is in one of two modes. The mode comes from target configuration a person wrote, and from
nothing else. No command flag and no MCP argument sets it. This page says what each mode guarantees, how a
secret comes back over MCP, how holds work, and which `E_` codes the mode and hold rules add. The trust
table, and the limits that remain, are in [safety](./safety.md).

| Mode | Meaning | Targets |
| --- | --- | --- |
| `test` | A declared environment that can be reset. A run never waits for a person. | `trust: "test"` or `"harness"` |
| `automation` | A real system. A person must have approved what runs, and a step only a person can do holds the run. | `trust: "production"`, `"unknown"` |

A target no file declares is `unknown`, and `unknown` is automation mode, the stricter one.

## Declaring trust

`trust` is a key in two files:

- `.jevitate/environments.json`, under `environments[name].trust`. It is committed and goes through PR review.
- `~/.jevitate/targets.json`, under the origin's entry. It is the operator's own file.

Valid values are `"test"`, `"harness"` and `"production"`. `"unknown"` is what an undeclared origin reads as;
it is never written, and a file that says it is refused. When both files name an origin, the stricter wins,
in this order: `production` (strictest), `unknown`, `harness`, `test`. A repository file therefore cannot
declare test mode for an origin your own file calls production. `production: true` is still honoured and
reads as `trust: "production"`. `synthetic: true` says something about the data, not about who may be
waited for, so it implies nothing about trust.

An environment's `test` or `harness` covers only its own origins (its `baseUrl` and its named `origins`).
A `--base-url` onto another origin is not what the file vouches for, and reads as `unknown` unless
`targets.json` says otherwise. A `production` declaration holds for any origin the run goes to. If either
file cannot be read, the target is at least `unknown`.

Existing files stay valid without a `trust` key. Their targets read as `unknown`, so they run in automation
mode, unless they were already `production: true`.

## What each mode guarantees

| | Test mode | Automation mode |
| --- | --- | --- |
| A human step (a handback step in a Journey) | Never waits. The run is refused before any browser opens with `E_HUMAN_STEP_IN_TEST_MODE` | Holds the run until a person answers at a terminal |
| An MCP run of a Journey | Any approval channel authorises it | Needs an approval a person made (`tty` or `pr-review`), else `E_APPROVAL_CHANNEL_FOR_MODE` |
| Destructive control (MCP) | Allowed, and noted in the run's evidence by rule and step. Session-ending and paid controls, and a target's own `safety.deny`, are still refused | Refused (`E_RUN_REFUSED_DESTRUCTIVE`) unless `mcpRun.allowDestructive` lifts it, as in 0.29.0 |
| A write off the run's allowlist (MCP) | Allowed to an origin the test environment declares (its `baseUrl` and named `origins`, or the origin a `targets.json` `trust: "test"` names), and noted in the evidence. Any other origin is refused, an authored `allowedOrigins` entry included | Refused (`E_RUN_REFUSED_OFF_ALLOWLIST_WRITE`) unless `mcpRun.allowOffAllowlistWrites` lifts it. An authored `allowedOrigins` entry also needs it |
| A production origin (MCP) | Refused (`E_RUN_REFUSED_PRODUCTION`): a `production` declaration makes the target automation mode anyway | Refused unless `mcpRun.allowProduction` lifts it |
| Mutation proof | Runs and `countsForGate` is true | Runs and `countsForGate` is false: a proof's strength depends on a target you can reset |
| Job attainment | From the done check | From the done check |
| Write sentinel | Not run | Shadow mode: records its judgment as advisory evidence and holds nothing |

A `harness` target (a UI over a mock backend) is in test mode, but a run there never gives a job verdict:
its job attainment reads `unverified` with `basis: "harness"`, and such a pass exits 0 (owner decision,
0.30.0). A pass on a real-stack target with no done check also reads `unverified`, and exits 2 by default
under `doneCheckPolicy: "require"`; see [outcomes](./outcomes.md).

A CLI run records `run.mode` and `run.target.trust` in its evidence. The person at the terminal stays the
guard: the CLI does not refuse an MCP-channel approval, and it prints one stderr warning when a draft Journey
runs on an automation-mode target.

## Which runs have a mode

Every run that opens a browser on a target decides its mode the same way, from the same two files, before
the browser opens, and records it in what it writes as `run.mode` and `run.target.trust` (test mode's
relaxations are listed in `run.notes`):

| Run | CLI | MCP | What the mode does there |
| --- | --- | --- | --- |
| A Journey run | `journey run`, `journey chain`, `journey verify`, `journey readiness` | `run_journey`, `chain_journeys`, `verify_journey`, `journey_readiness` | Everything on this page: the approval rule, the human-step refusal, holds, the guard's relaxation in test mode |
| A load test | `load run` | `run_load_test` | It runs a Journey, so the approval rule (MCP) and the human-step refusal apply before any browser; every actor's session has the guard with the mode |
| An exploration | `explore` (every strategy) | `run_exploration` | Over MCP each session is armed with the same guard a Journey run has: a production target is refused before anything opens, and a write off the run's allowlist is refused at the browser context unless test mode allows it inside the declared environment. `allowDestructive` is refused on an automation-mode target (`E_RUN_REFUSED_DESTRUCTIVE`) unless `mcpRun.allowDestructive` lifts it, and allowed in test mode. A `--from-journey` prefix is a Journey run |
| A queued exploration | `mission queue`, then `mission run` | `queue_exploration`, then `run_queued_missions` | The queue result shows the mode the run will have; the run decides it again from the files when it starts, so a file changed in between counts. Over MCP its sessions carry the guard, as an exploration's do |
| A regression | `regression run`, `regression capture` | `regressions` | The mode reaches the guard and the result. A regression is not a Journey, so there is no approval to check |
| A finding's replay | `verify-fix` | `verify_fix` | The mode is recorded on the report. Its sessions carry no write guard, so test mode has nothing to relax, and a production origin is still refused over MCP |
| A source Journey | `source run` | `sources run` | The mode reaches the guard and the result. The approval rule does not apply: a source Journey runs only after a person trusted it with `source trust`, which no MCP tool can do |

No argument chooses the mode on any of them. A queued request names a target by id and cannot carry a trust,
and an exploration's `--allow` widens what it may visit, not its mode.

## What an MCP promotion authorises

`promote_journey` over MCP records an approval with `provenance.channel: "mcp"`. That approval authorises
runs on test-mode targets only. On an automation-mode target the run is refused with
`E_APPROVAL_CHANNEL_FOR_MODE` before any browser opens, and the refusal names the fix: `jevitate journey
promote <id>` typed at a terminal, or a verified PR review of the Journey.

| Channel | Where it comes from | Authorises |
| --- | --- | --- |
| `tty` | `journey promote` typed at a terminal | test and automation runs |
| `pr-review` | a verified PR review of the Journey's file | test and automation runs |
| `ci`, `non-interactive` | a scripted promote | test-mode runs only |
| `mcp` | `promote_journey` over MCP | test-mode runs only |

This changes 0.29.0, where an MCP approval authorised an MCP run anywhere. The rule applies to every MCP run
of a local Journey: `run_journey`, `chain_journeys`, `verify_journey`, `journey_readiness`, `run_load_test`,
and the Journey prefix of `run_exploration` with `fromJourney`. The channel is a record, not a proof: the tool that made the approval writes it, and it
is not signed.

## How a secret comes back over MCP

A secret value passed as a tool argument is refused by name in both modes (`E_SECRET_PARAM_OVER_MCP`). A
Journey that needs a secret the request leaves out is handled by mode.

In automation mode, on a Journey whose current approval a person made, `run_journey` does not refuse. The
run goes on until the step that needs the secret and then meets it one of two ways:

- **`vault-autofill`.** The operator's `~/.jevitate/targets.json` entry for that origin has a `secretFields`
  binding for the field. Code types the value, on that origin only, from the server's environment. The value
  goes to the browser and never to the model, the result or the evidence.
- **`visible-handback`.** There is no binding. The run holds, and a person runs `jevitate inbox resume <id>`
  at a terminal, which opens the held session headed so they can finish the step.

The agent sees `outcome: "held"` with the hold's id, and later the resumed outcome. It never sees the value.
If a binding for the field exists only on another origin, the run is refused with
`E_SECRET_ORIGIN_REFUSED`: a bound secret is typed on its own origin only. The CLI's `--secret-mode`
(`auto`, `fail-closed`, `vault-autofill`, `visible-handback`) narrows the choice; a mode the target cannot
give is refused with `E_SECRET_MODE_UNAVAILABLE`.

In test mode a run never waits for a person. A Journey with a handback step is refused with
`E_HUMAN_STEP_IN_TEST_MODE`. A secret parameter the request leaves out comes from the test target's own
`secretFields` in `~/.jevitate/targets.json` (test credentials a person wrote), through the same binding
`vault-autofill` uses: code types it into the field the spec names, on that origin only, and the value never
reaches the model, the result, the evidence or a log. A promoted Journey reads it whatever channel approved it, an MCP
promotion included, since that authorises test-mode runs (on `run_journey` the approval must also be
current); a draft never reads the file. With no binding for
every such parameter (or a binding whose environment variable is unset), the run is refused with
`E_HUMAN_STEP_IN_TEST_MODE` before any browser opens; it is never held. A binding on another origin only is
refused with `E_SECRET_ORIGIN_REFUSED`.

A secret in a `navigate` URL (an invite token) has no field for a person to type it into, so it never holds. Over
MCP it is supplied only by a `param=<name>=env:<VAR>` binding in `targets.json` `secretFields` for the run's origin;
with none, the run is refused with `E_SECRET_MODE_UNAVAILABLE` before any browser opens.

What each tool does with a secret the call leaves out:

| Tool | A secret the call leaves out |
|---|---|
| `run_journey`, `queue_journey` | `vault-autofill` from `targets.json`, else hold (automation); the test target's `secretFields`, else `E_HUMAN_STEP_IN_TEST_MODE` (test) |
| `verify_journey` | `vault-autofill` only; else `E_HUMAN_STEP_IN_PROOF` (a proof never holds) |
| `demo_journey`, `chain_journeys` (producer) | as `run_journey` |
| `run_load_test`, `run_exploration` (`fromJourney`) | `vault-autofill` only; else `E_SECRET_MODE_UNAVAILABLE` |
| `annotate_journey` | refuses a secret-bound Journey (`E_MODEL_REFUSED_SECRET`) |
| `sources` | refused: a source's Journey never reads `targets.json` |

A value in any tool's `params` is refused by name (`E_SECRET_PARAM_OVER_MCP`). A Journey with a secret still
cannot self-heal or be annotated.

## Holds and resume

A hold stops a run in automation mode at a step that needs a person: a handback, a secret nobody supplied,
or an action a hook asked to hold. It is a record and a checkpoint, both under `.jevitate/logs/holds/`
(`~/.jevitate/logs/holds/` outside a project), signed with the per-user key at
`~/.jevitate/verify-checkpoint.key`, plus an inbox item with the same id (`hold-` and 16 hex digits). The
record binds what a person approves:

- the Journey's id and content hash;
- a keyed digest of the parameters (secret ones included, as a digest);
- the target's origin and trust;
- the pending step and the control it names.

It holds no value. The run ends `outcome: "held"` with `E_RUN_HELD` (exit 2).

1. `jevitate inbox approve <id>` answers it. It works only at a terminal (a TTY on stdin and stdout) and not
   inside an MCP call. It shows what is held and asks for the hold's id typed back. `--reject` answers with a
   rejection, and the run then never resumes. `approve_action` over MCP keeps refusing and never touches a
   hold.
2. `jevitate inbox resume <id> --param <name=value>` continues from the checkpoint, and does not repeat the
   steps before the pending one. Pass the same non-secret parameters the run was held with. A handback or
   secret hold opens a headed browser for the person to complete the step, then the run checks the step's own
   assertion.
3. The resume is refused unless an approval by a person at a terminal exists, and the Journey hash, the
   parameter digest, the target origin and the pending action all still match the record. A changed Journey
   needs a new hold and a new approval.

A hold lives 24 hours by default. After that, resume ends the run `inconclusive` with `E_HOLD_EXPIRED` (exit
2), and running the Journey again makes a new hold. Every other hold refusal ran nothing and exits 64.

A proof never holds. A proof (`journey verify --mutate`, `verify_journey`, the proof inside
`journey_readiness`) is many replays of the Journey judged together, and a resume would continue one replay
as a plain run, which proves nothing. So a proof's replay that reaches a step only a person can do (a
handback, a secret nobody supplied, an action a hook asked to hold) ends the proof `inconclusive` with
`E_HUMAN_STEP_IN_PROOF` (exit 2), naming the step and the kind of hold. A handback or a missing secret is
refused before any browser opens. Nothing is held: no hold record, no checkpoint and no inbox item, so
there is nothing to resume. To prove a Journey with a secret step, supply the secret to every replay: the
test target's `secretFields`, an automation-mode target's binding for a Journey a person approved, or
`--secret-field` on the CLI. A Journey with a handback step cannot be proved; run it instead.

## The ratchet

Over MCP:

- `site_policy` may only write a policy at least as strict as the one in effect, on every axis (pacing,
  interval, budget, quiet hours). A looser one is refused with `E_POLICY_LOOSEN_OVER_MCP`.
- `mission_targets` cannot promote a target (`E_TARGET_PROMOTE_OVER_MCP`). Promotion is a CLI act.
- `promote_journey` still works, and its approval authorises test-mode runs only.
- An authored `allowedOrigins` never widens what a run may write to on its own: an agent can author it. In
  automation mode a write there needs `mcpRun.allowOffAllowlistWrites`; in test mode it is allowed only when
  the test environment declares that origin too.

## What forged provenance still means

The refusals above hold against an agent that has only the MCP surface: it cannot change a target's trust,
start an automation-mode run on its own promotion, loosen a policy, promote a target, or read or move a
secret value.

They do not hold against an agent that can write to `.jevitate/` or `~/.jevitate/`. Such an agent can write
`trust: "test"`, an approval with `provenance.channel: "tty"`, and a Journey's approval hash. A Journey's
approval is an unsigned hash. A hold and its checkpoint carry a keyed MAC, which shows only that they were
written by a holder of that user's key, so an agent that can read the key can write them too. The control is
git review of `.jevitate/` with `jevitate check --require-approvals`. A `--require-trust` check that fails CI
when `trust` changes outside a reviewed PR is not in 0.30.0, and neither is signing approvals with a key an
agent cannot read.

## Codes

Every refusal below happens before a browser opens, carries no parameter value, and is not a failed run to
retry: it is refused the same way until a person changes the setting it names. Exit codes are in
[outcomes](./outcomes.md).

| Code | Exit | When | Way out |
| --- | --- | --- | --- |
| `E_APPROVAL_CHANNEL_FOR_MODE` | 2 | an MCP run on an automation-mode target, and the Journey's approval is `mcp`, `ci`, `non-interactive` or has no channel | `jevitate journey promote <id>` at a terminal, or a verified PR review; or a person declares the target `"trust": "test"` |
| `E_HUMAN_STEP_IN_TEST_MODE` | 2 | a test-mode target, and the Journey has a human step (a handback), or a secret parameter that no `secretFields` binding of that target supplies | give the test target the `secretFields` binding; or run it on an automation-mode target, where it holds for a person; or take the handback out of the Journey |
| `E_POLICY_LOOSEN_OVER_MCP` | 2 | `site_policy set` over MCP asked for a policy looser than the effective one on some axis | a person loosens it on the CLI: `jevitate site policy set <site> --file <policy.json>` |
| `E_TARGET_PROMOTE_OVER_MCP` | 2 | `mission_targets` over MCP tried to promote a target | `jevitate mission target promote <id>` on the CLI |
| `E_SECRET_ORIGIN_REFUSED` | 2 | a `secretFields` binding exists for the field on another origin only | bind it for this origin in that origin's `secretFields`, or run the Journey on the bound origin |
| `E_SECRET_MODE_UNAVAILABLE` | 2 | `--secret-mode vault-autofill` and the target has no binding on this origin for every secret step | add the `secretFields` binding, or use `--secret-mode auto` or `visible-handback` |
| `E_RUN_HELD` | 2 | not a refusal: the run reached a human step in automation mode and is held | `jevitate inbox approve <id>` at a terminal, then `jevitate inbox resume <id>` |
| `E_HUMAN_STEP_IN_PROOF` | 2 | a proof's replay reached a step only a person can do (a handback, a secret nobody supplied, a held action); the proof ends `inconclusive` and nothing is held | supply the secret to every replay (`secretFields`, or `--secret-field` on the CLI); a Journey with a handback step cannot be proved |
| `E_HOLD_EXPIRED` | 2 | the hold's 24 hours ran out before the answer or resume; the run ends `inconclusive` | run the Journey again, and answer the new hold in time |
| `E_HOLD_BINDING` | 64 | the Journey, parameters, target origin or pending action changed since the hold, or the hold changed while it was being answered | run the Journey again and approve the new hold; for parameters, pass the same `--param` set |
| `E_HOLD_NOT_APPROVED` | 64 | resume of a hold with no answer, or one not answered by a person at a terminal | `jevitate inbox approve <id>` at a terminal |
| `E_HOLD_REJECTED` | 64 | resume of a hold a person rejected | run the Journey again to be asked again |
| `E_HOLD_ANSWERED` | 64 | answering a hold that was already approved or rejected | none needed; resume it if approved |
| `E_HOLD_NOT_FOUND` | 64 | no hold with that id (or the id is malformed) | `jevitate inbox list` for the id; run the Journey again |
| `E_HOLD_INTEGRITY` | 64 | the hold or its checkpoint fails its signature check, or belongs to another hold | delete it and run the Journey again; investigate who wrote to `.jevitate/logs/holds/` |
| `E_HOLD_CHECKPOINT` | 64 | the hold has no usable checkpoint to resume from | run the Journey again |
| `E_HUMAN_APPROVAL_REQUIRED` | 64 | `inbox approve` or `cancel` inside an MCP call, without a TTY, or for an id that is not a hold | a person runs it at a terminal, or answers in `jevitate ui` |
| `E_JOURNEY_PARAM_TYPE` | 64 | a parameter's value is not of the type the Journey declares (the message names the parameter, never the value) | pass a value of the declared type |
| `E_SECRET_PARAM_OVER_MCP` | none (MCP `invalid_args`) | a secret value passed as an MCP parameter, or a secret the request leaves out on a Journey with no current approval that authorises the run's mode | never pass the value; use a `targets.json` `secretFields` binding, or on an automation-mode target let the run hold |
