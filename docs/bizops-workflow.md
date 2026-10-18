# Two-journey comment workflow: discover, then prepare an approved reply (#580)

Jevitate can find open conversations and prepare an **approved** reply in each one, stopping before
Send. It runs as two reusable Journeys and one chain command. The same Journeys, unchanged, serve
every conversation and every reply text: nothing is compiled into a run.

- **Discover** reads the inbox and returns one record per open conversation.
- **Prepare reply** reopens one conversation, checks it is exactly the one approved, then fills the
  approved text and stops. It never sends.
- **`jevitate journey chain`** runs discover once and prepare once per approved request.

Approval of the text is not Jevitate's job. Bizops owns it (copy, version, expiry) and exports
prepare-only requests; Jevitate never grants, extends or substitutes an approval.

The shapes (record, outputs, params, requests, result) are fixed in
[journey-chain-contract.md](journey-chain-contract.md).

## The reference fixture

`test/fixtures/bizops-community/` is an offline, fictional Community-style app: two reply identities
(`mcpl`, `personal`), two posts with two threads each, replies with parents, permalinks, a
Reply-as / Thread / Reply composer and an in-memory submission counter. Its `.jevitate/` holds both
Journeys and a draft persona (`bizops-operator`) and job (`answer-community-comments`).

| Journey | What it does | Inputs | Outputs |
| --- | --- | --- | --- |
| `discover-conversations` | `forEach` over the inbox rows, one `extract` per record field | none | `records.count`, `records.<i>.<field>` |
| `prepare-reply` | navigate `/c/${commentId}`; check comment id, account, source text, identity and thread **before** the composer; select identity and thread; fill the reply; stop | `commentId`, `replyIdentity`, `threadId`, `expected_commentid`, `expected_account`, `expected_sourcetext`, `replyText` | none |

Every check in `prepare-reply` that compares the page with an input runs before any write. A wrong
comment, parent context, account, thread, source text or reply identity ends the run at that check,
with the composer untouched and nothing sent.

## Run it

```bash
jevitate journey chain --from discover-conversations --to prepare-reply \
  --requests approved.jsonl --base-url http://127.0.0.1:<port> --json
```

`approved.jsonl` holds one request per line, exactly these keys:

```json
{"commentId": "c-2041", "account": "mcpl", "replyText": "Thanks, Marta!\nThe crew starts on the ninth."}
```

- A request is run only when a discovered record has the same `commentId` **and** `account`; any
  other request is listed under `unmatched` and never run.
- An empty inbox, or a discover run that fails, stops the chain: no target is ever guessed.
- The result names ids and outcomes only. Reply text and source text are never echoed; a failure
  reason that quotes them shows `<param replyText>` / `<param expected_sourcetext>` instead.
- Exit 0 only when every request matched and every prepare run was `ok`.
- Both Journeys must be promoted. `--allow-draft` runs drafts while authoring (CLI only).

To run a single conversation by hand, pass the record's fields as params:

```bash
jevitate journey run prepare-reply --base-url http://127.0.0.1:<port> \
  --param commentId=c-2041 --param replyIdentity=mcpl --param threadId=thread-31 \
  --param expected_commentid=c-2041 --param expected_account=mcpl \
  --param "expected_sourcetext=$(cat source.txt)" --param "replyText=$(cat reply.txt)"
```

`expected_*` are assertion-only inputs: they register no form field and need no fake navigation
(#573).

## Over MCP

| Operation | MCP tool | Notes |
| --- | --- | --- |
| Chain | `chain_journeys` | `{ from, to, requests: "<path to approved.jsonl>", env? \| baseUrl?, storageState? }`; the requests path is confined to the project; promoted Journeys only |
| One reply | `run_journey` | `{ id: "prepare-reply", params: {…} }`; promoted only |
| Proof | `verify_journey` | `{ id, mutate: true, params: {…} }` |
| Review sheet | `review_journey` | read-only; promotion and catalog approval are never MCP tools |

No tool takes selectors, scripts or extra fields: the Journeys are the only behaviour.

## Proving the checks can fail

```bash
jevitate journey verify prepare-reply --mutate --base-url http://127.0.0.1:<port> --param … # as above
```

On the fixture it is **proven** for records on both posts: 9 of 9 checks sensitive, with no
cascade, timeout or submission ([evidence](evidence/580-mutation-proof.md)).

- The guards before the composer are proven by `guard-param:<input>`: the whole run gets a wrong
  input and the guard must refuse it.
- The selections are proven by `swap-param`. It uses a reviewed `mutationValues` entry when the
  parameter declares one, else another enabled option of the live `<select>` (#579). With no other
  enabled option, the mutation is `not-applied` (`no-alternative`), never a pass.
- The exact multiline text is proven by `stale-value` and `swap-param:replyText`.

Declare reviewed wrong values on a parameter when the page has a fixed set of valid choices:

```json
{ "name": "replyIdentity", "mutationValues": ["mcpl", "personal"] }
```

The first entry that differs from the supplied value is used. Values must be valid choices the page
offers (else the selection itself fails), are persisted in the Journey file, and are refused on a
secret parameter (`E_MUTATION_VALUES_SECRET`).

The discover Journey's proof is `inconclusive`: it takes no input and checks no typed value, so
there is nothing to mutate. Its records are verified by the acceptance suite instead, where each
record drives a prepare run whose guards check it against the live conversation.

## Verification commands

From the repo root:

```bash
pnpm exec vitest run packages/cli/src/bizops-workflow-served.test.ts   # chain, fail-closed cases, 0 submissions
pnpm exec vitest run packages/cli/src/bizops-proof-served.test.ts      # verify --mutate: proven
pnpm exec vitest run packages/cli/src/bizops-journeys.test.ts packages/cli/src/bizops-catalog.test.ts packages/cli/src/bizops-fixture-server.test.ts
```

## Human review and approval (human only)

The persona and job ship as **drafts**, and both Journeys as **unpromoted**. `journey review
--strict` is clean only after a person reviews and approves them. No agent or MCP tool can do any of
these steps, and nothing is waived:

```bash
cd test/fixtures/bizops-community
jevitate persona review bizops-operator
jevitate persona approve bizops-operator
jevitate job review answer-community-comments
jevitate job approve answer-community-comments --reviewed-hash <hash from the sheet>
jevitate journey review discover-conversations --strict
jevitate journey review prepare-reply --strict
jevitate journey promote discover-conversations --reviewed-hash <hash from its sheet>
jevitate journey promote prepare-reply --reviewed-hash <hash from its sheet>
```

## Since 0.18.0

Both Journeys now declare their typed handoff (`outputs` on discover, `inputs` with bindings on
prepare-reply) and prepare-reply declares a prepare-only boundary. So:

- `journey chain` validates every record and request against the contract before any reply run;
- each prepare run reports `handback: prepared` (or why not) and exits non-zero if anything was sent;
- `jevitate journey readiness discover-conversations --with prepare-reply` gives one receipt for the
  pair;
- `jevitate journey bundle discover-conversations --with prepare-reply --out review/` writes the
  human review bundle.

See [linked-journeys.md](linked-journeys.md).

## Scope

Everything here is local and fictional. Real provider comment selectors, ids and permalinks are
validated separately once real comments and production automation are authorized. Browser execution
in deployed Bizops stays disabled, and replies are still posted by a person.
