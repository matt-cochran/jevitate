# #580 mutation proof (`journey verify --mutate`)

Run on the offline fixture (`test/fixtures/bizops-community`), engine at `feat/580-bizops-workflow`,
real Chromium. Both reply proofs bind to the Journey content hash in their reports. Submissions to the
fixture during all proof runs: **0**.

| Journey | Params | Verdict | Sensitive | Insensitive | Cascade | Not applied | Error | Unpaired |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `discover-conversations` | (none) | **inconclusive** | 0 | 0 | 0 | 0 | 0 | 1 |
| `prepare-reply` | c-2041, mcpl, thread-31 (post-314) | **proven** | 9 | 0 | 0 | 0 | 0 | 0 |
| `prepare-reply` | c-4520, personal, thread-21 (post-207) | **proven** | 9 | 0 | 0 | 0 | 0 | 0 |

## prepare-reply: what proves each check (both runs identical)

| Check | Verdict | Proved by |
| --- | --- | --- |
| `step:1` | sensitive | `swap-param:commentId` |
| `step:2` | sensitive | `guard-param:expected_commentid` |
| `step:3` | sensitive | `guard-param:expected_account` |
| `step:4` | sensitive | `guard-param:expected_sourcetext` |
| `step:5` | sensitive | `guard-param:replyIdentity` |
| `step:6` | sensitive | `guard-param:threadId` |
| `step:7` | sensitive | `swap-param:replyIdentity` |
| `step:8` | sensitive | `swap-param:threadId` |
| `step:9` | sensitive | `stale-value:9` |

- Steps 2–6 are the guards that run **before** the composer (comment id, account, source text, reply
  identity, thread). Each is proven by a wrong input for the whole run (`guard-param`, new in 0.17.0);
  `replyIdentity` uses its reviewed `mutationValues`.
- Steps 7–8 are the selections. `replyIdentity` swaps to its reviewed value; `threadId` swaps to
  another enabled option of the live `<select>` (#579). No select mutation timed out.
- Step 9 is the exact composer text (multiline), proven by `stale-value:9` and `swap-param:replyText`.

## discover-conversations

`inconclusive` with one unpaired check, and that is the honest verdict: it takes no inputs, sends no
writes and checks no typed values, so there is nothing to mutate. Its records are proven by the
real-browser acceptance tests (`packages/cli/src/bizops-workflow-served.test.ts`): every discovered
record drives a reply run whose guards check the record against the live conversation.

## Blockers found and fixed while proving

- **B10**: a declared parameter read by an action through `{ var }` without a `variableName` tag was
  not a run input, so a pinned swap was refused as an unknown param (`error`). `journeyParamSchema`
  now counts action reads.
- **B11**: guards before the action could not be proven (a swap pins assertions to the supplied value),
  and assertion-only inputs got no mutation. `guard-param` proves them.

Reproduce: start the fixture and run, for one record,
`jevitate journey verify prepare-reply --mutate --base-url <fixture url> --param commentId=c-2041 …`
(see `docs/bizops-workflow.md`).
