# Running on a UI harness (`trust: "harness"`)

## Why

A real stack is slow, shared and hard to reset. A UI harness is the front end running over a mock
backend (MockServer or WireMock, your choice), so a Journey can replay fast, offline and repeatably.

What a harness proves is narrow: the UI can be driven end to end against the responses you mocked.
It cannot prove the job happened, because the mock answers whatever you recorded. So jevitate treats
a harness as test mode (it never waits for a person, drafts may run with `--allow-draft`) but forces
the job verdict: `job.attainment` is `unverified` with `basis: "harness"`, even when the done check
reads true. Only a run on the real stack can say `achieved`.

## Declare the environment

In the committed `.jevitate/environments.json`, set `trust` on the environment that points at the
harness:

```json
{
  "harness": { "baseUrl": "http://127.0.0.1:4010", "trust": "harness" },
  "staging": { "baseUrl": "https://staging.example.com", "trust": "test" }
}
```

Trust is read from configuration only; no flag or MCP argument can choose it. If the operator's
`~/.jevitate/targets.json` also names the origin, the stricter value wins
(`production` > `unknown` > `harness` > `test`). `trust` applies to the environment's own `baseUrl`
and `origins`, not to a `--base-url` onto another origin.

## Record mock data

1. Record the flow against the real or staging stack (`jevitate record --url ...`), or capture the
   API traffic you need from your own tooling.
2. Turn the responses into MockServer expectations or WireMock stubs. Keep them in the repo next to
   the harness, one stub per request the Journey makes.
3. Before committing, scan the recordings for secrets: session cookies, bearer tokens, API keys,
   passwords, personal data in bodies. jevitate has no command that scans recordings for you (its
   own secret scan covers only usability screenshots), so run a scanner on the stub files, for
   example `gitleaks detect --no-git --source <stubs-dir>`. Replace every finding with a synthetic
   value before the commit. Committed secrets cannot be taken back.

## Run on the harness

Start the harness, then run the Journey with the harness environment:

```sh
jevitate journey run <id> --env harness --param item=example
```

Expect `outcome: ok` and `job: { attainment: "unverified", basis: "harness" }`. The done check is
still read and kept in the run's evidence, but it does not decide the job.

Exit code: a passing harness run exits `0`, so it can gate CI on the UI layer. It still reports
`unverified` with basis `harness`, because a mock backend cannot show that the job happened; read the
result, not the exit code, before treating it as proof. The real-stack run below follows
`doneCheckPolicy` as usual: under the default `require`, an unverified pass there exits `2`.

## Confirm on the real stack

Run the same Journey, unchanged, on an environment declared `trust: "test"` (a resettable staging):

```sh
jevitate journey run <id> --env staging --param item=example
```

This run reads the done check in a fresh session before and after and can say `achieved`. That is
the verdict that counts. The harness run tells you the UI works against known responses; the real
run tells you the job happens.

## Limits

- A harness never yields `achieved`. This is by design, not a setting.
- A mock that drifts from the real API makes the harness pass while the product is broken. Re-record
  when the API changes, and always do the real run before release.
- `harness` is test mode: it never waits for a human step. A Journey with a handback fails
  `E_HUMAN_STEP_IN_TEST_MODE`.
- A mutation proof on a harness still runs and counts for a strict gate (same as `test`), but it
  shows the UI's assertions are sensitive, not that the backend behaves.
- Recordings used as mock data are your responsibility to scan; see Record mock data.
