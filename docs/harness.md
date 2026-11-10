# Running on a UI harness (`trust: "harness"`)

## Why

A real stack is shared and hard to reset. A UI harness is the front end running over a mock backend
(MockServer or WireMock, your choice), so a Journey can replay offline and repeatably, and a reset is
cheap: reloading the mock's expectations took 0.03 s in the #802 lab.

A harness does not make a run faster. A run's time is the browser and the done check's two fresh-session
readings, not the backend: in the #802 lab the harness run and the real-stack run took the same median
time (5.68 s each, a ratio of 1.00). Don't adopt a harness for speed.

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
3. Before committing, scan the recordings for secrets: session cookies, bearer tokens, CSRF tokens,
   API keys, passwords, personal data in bodies. jevitate has no command that scans recordings for you
   (its own secret scan covers only usability screenshots). A generic scanner is not enough on its
   own: in the #802 lab, `gitleaks` on a raw gRPC-Web recording found only the `x-csrf-token` header.
   It missed 4 session cookies in `Cookie` and `Set-Cookie`, and every e-mail address inside the
   base64 protobuf bodies. So:
   - Decode every body before you scan it (base64, gRPC-Web framing, protobuf with the service schema,
     compressed JSON), and scan the decoded text as well as the raw files, headers included.
   - Search for the exact values the recording session was issued: its session cookies, CSRF token,
     bearer and API tokens, and the account's e-mail and name. You know them; a pattern scanner does not.
   - Keep a positive control: the same scan on the unredacted recording must find those values, or the
     scan is not looking where they are.
   - Then run a generic scanner too (for example `gitleaks detect --no-git --source <stubs-dir>`).

   Replace every finding with a synthetic value before the commit. Committed secrets cannot be taken
   back.
4. Probe the mock for drift before you trust a harness pass, and again whenever the API may have
   changed. Replay the recorded requests, in order, against a freshly loaded mock and against a freshly
   reset real or staging stack, decode both responses and compare them field by field. Ignore only the
   fields you redacted on purpose and volatile ones (timestamps). Any other difference means the mock no
   longer matches the API: re-record it. A drifted mock passes with exit `0`: in the #802 lab, after the
   real API started to require a new field, the harness run passed 5 of 5 times while the real run failed
   5 of 5 (exit 1, the done check `not-achieved`); the probe showed the difference on 2 of 11 requests.
   jevitate has no drift-probe command; `scripts/mock-harness-lab/run-lab.mjs` (`driftProbe`) is a
   worked example.

## Run on the harness

Start the harness, then run the Journey with the harness environment:

```sh
jevitate journey run <id> --env harness --param item=example
```

Expect `outcome: ok` and `job: { attainment: "unverified", basis: "harness" }`. The done check is
still read and kept in the run's evidence, but it does not decide the job.

Exit code: a passing harness run exits `0`, so it can gate CI on the UI layer. It still reports
`unverified` with basis `harness`, because a mock backend cannot show that the job happened; read the
result, not the exit code, before treating it as proof. A CI gate that reads only the exit code is fooled
by a drifted mock, so run the drift probe (step 4 above) in the same pipeline. The real-stack run below follows
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
- A mock that drifts from the real API makes the harness pass, exit `0`, while the product is broken.
  The harness run cannot see it; only the drift probe or a real run can. Probe before trusting a pass,
  re-record when the API changes, and always do the real run before release.
- A harness is not faster than the real stack (measured ratio 1.00). It buys offline, repeatable runs
  and a cheap reset.
- `harness` is test mode: it never waits for a human step. A Journey with a handback fails
  `E_HUMAN_STEP_IN_TEST_MODE`.
- A mutation proof on a harness still runs and counts for a strict gate (`countsForGate: true`, as on
  `test`), but it shows the UI's assertions are sensitive, not that the backend behaves. It does not detect drift.
- Recordings used as mock data are your responsibility to scan, with decoded bodies and the session's
  exact values; see Record mock data.
