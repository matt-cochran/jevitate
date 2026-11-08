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
| Authored `allowedOrigins` (MCP) | Join the run's write allowlist | Need `mcpRun.allowOffAllowlistWrites` |
| Destructive control, off-allowlist write, production origin (MCP) | Refused as in [safety](./safety.md); test mode does not loosen them | Refused as in [safety](./safety.md) |
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

Load tests (`load run`), `regression run`, `verify-fix` and `source run` do not go through the run hooks, so
they have no mode.

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

This changes 0.29.0, where an MCP approval authorised an MCP run anywhere. The rule applies to every run that
goes through the run hooks inside an MCP call: `run_journey`, `chain_journeys`, `verify_journey` and
`journey_readiness`. The channel is a record, not a proof: the tool that made the approval writes it, and it
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

In test mode, a Journey with a human step is refused with `E_HUMAN_STEP_IN_TEST_MODE`. The design also
routed a test target's `secretFields` to the run; that route is not built, so over MCP in test mode a missing
secret parameter is refused with `E_SECRET_PARAM_OVER_MCP`.

Limits of this route: the `targets.json` read covers `run_journey` and its holds, not every tool. A Journey with
a secret still cannot self-heal or be annotated, and a secret in a `navigate` URL runs on the CLI only.

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

A hold reached during a proof replay (`verify_journey`, `journey_readiness`) resumes as a plain run of the
Journey. It does not return to the proof.

## The ratchet

Over MCP:

- `site_policy` may only write a policy at least as strict as the one in effect, on every axis (pacing,
  interval, budget, quiet hours). A looser one is refused with `E_POLICY_LOOSEN_OVER_MCP`.
- `mission_targets` cannot promote a target (`E_TARGET_PROMOTE_OVER_MCP`). Promotion is a CLI act.
- `promote_journey` still works, and its approval authorises test-mode runs only.
- An authored `allowedOrigins` joins a run's write allowlist in test mode only. In automation mode a write
  there needs `mcpRun.allowOffAllowlistWrites`.

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
| `E_HUMAN_STEP_IN_TEST_MODE` | 2 | a test-mode target, and the Journey has a human step (a handback) | run it on an automation-mode target, where it holds for a person, or take the handback out of the Journey |
| `E_POLICY_LOOSEN_OVER_MCP` | 2 | `site_policy set` over MCP asked for a policy looser than the effective one on some axis | a person loosens it on the CLI: `jevitate site policy set <site> --file <policy.json>` |
| `E_TARGET_PROMOTE_OVER_MCP` | 2 | `mission_targets` over MCP tried to promote a target | `jevitate mission target promote <id>` on the CLI |
| `E_SECRET_ORIGIN_REFUSED` | 2 | a `secretFields` binding exists for the field on another origin only | bind it for this origin in that origin's `secretFields`, or run the Journey on the bound origin |
| `E_SECRET_MODE_UNAVAILABLE` | 2 | `--secret-mode vault-autofill` and the target has no binding on this origin for every secret step | add the `secretFields` binding, or use `--secret-mode auto` or `visible-handback` |
| `E_RUN_HELD` | 2 | not a refusal: the run reached a human step in automation mode and is held | `jevitate inbox approve <id>` at a terminal, then `jevitate inbox resume <id>` |
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
| `E_SECRET_PARAM_OVER_MCP` | none (MCP `invalid_args`) | a secret value passed as an MCP parameter, or (in test mode) a secret the request leaves out | use `--secret-field` or a `targets.json` `secretFields` binding on the CLI; on an automation-mode target let the run hold |
