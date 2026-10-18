# Bizops community fixture (#580)

An offline, entirely fictional "community" web app used as the integration fixture for the
two-journey Bizops comment workflow. It is a plain `node:http` server — no framework, no new
dependency, no disk I/O, no clock reads — so a journey can drive the inbox and reply on a comment
as many times as it likes without the outside world changing underneath it.

* `data.ts` — seeded identities, posts, threads and comments (all names, providers and text invented).
* `server.ts` — `startBizopsCommunity()`, the HTTP fixture.
* Smoke test — `packages/cli/src/bizops-fixture-server.test.ts` (vitest `unit` project, no browser).

## Pages

| Request | What it serves |
| --- | --- |
| `GET /` | The **inbox**: one row per seeded comment, i.e. one open conversation each. |
| `GET /c/<commentId>` | The **conversation** at that comment's native permalink: the full source text (multiline included), the parent comment when the comment is a reply, and the reply composer. |
| `POST /c/<commentId>/reply` | Records the reply **in memory** and answers `200` with a receipt. Nothing is written to disk. |
| anything else, or an unknown `<commentId>` | `404`. |

The inbox lists comments in **seeded order**, which is deliberately not id order — position is never
an identity, so a test (and a journey) must locate a row by its ids, not by "the first row".

## Ids

Every comment has a stable id that is also its permalink leaf:

| Post | Thread | Comment | Parent | Account |
| --- | --- | --- | --- | --- |
| `post-314` (Mockcrew / forum) | `thread-31` | `c-2041` | — | `mcpl` |
| | | `c-1007` | `c-2041` | `personal` |
| | `thread-32` | `c-3388` | — | `mcpl` |
| | | `c-1210` | `c-3388` | `personal` |
| `post-207` (Bramble Yard / email) | `thread-21` | `c-4520` | — | `personal` |
| | | `c-1462` | `c-4520` | `mcpl` |
| | `thread-22` | `c-3391` | — | `mcpl` |
| | | `c-2014` | `c-3391` | `personal` |

Reply identities (the `Reply as` options): `mcpl` and `personal`. `data.ts` exports `IDENTITIES`,
`POSTS`, `SEED_COMMENTS` (flat, seeded order) and `COMMENT_BY_ID`.

## Assertion hooks

Markup carries `data-testid` plus `data-*` attributes so a browser journey and a plain HTTP test can
assert the same things.

Inbox (`GET /`):

* `ul[data-testid="inbox-list"]`, one `li[data-testid="inbox-row"]` per comment with
  `data-provider`, `data-channel`, `data-account`, `data-post-id`, `data-thread-id`,
  `data-comment-id`, `data-parent-id` (only when the comment has a parent) and
  `data-permalink="/c/<commentId>"`.

Conversation (`GET /c/<commentId>`):

* `p[data-testid="conversation-meta"]` — provider, channel, post id, thread id, comment id;
* `div[data-testid="parent-comment"]` — present only for a reply, with `data-comment-id` of the parent;
* `div[data-testid="source-comment"]` — `data-comment-id`, `data-account`, `data-author`, and the
  full escaped text in a `white-space: pre-wrap` paragraph;
* `select[data-testid="account-select"]` labelled **Reply as** (an option per identity, the comment's
  own account preselected);
* `select[data-testid="thread-select"]` labelled **Thread** (the comment's thread preselected);
* `textarea[data-testid="reply-body"]` labelled **Reply** — the multiline composer;
* `button[data-testid="reply-send"]` — **Send**, inside `form[action="/c/<commentId>/reply"]`.

## How tests use it

```ts
import { startBizopsCommunity } from "../../../test/fixtures/bizops-community/server.js";
import { COMMENT_BY_ID, SEED_COMMENTS } from "../../../test/fixtures/bizops-community/data.js";

const fixture = await startBizopsCommunity(); // 127.0.0.1, an ephemeral port: nothing is exposed
const inbox = await (await fetch(`${fixture.url}/`)).text();
const before = fixture.submissions(); // 0 on a fresh fixture
await fetch(`${fixture.url}/c/c-1007/reply`, { method: "POST", body: new URLSearchParams({ account: "personal", thread: "thread-31", body: "…" }) });
fixture.submissions(); // before + 1
await fixture.close();
```

`startBizopsCommunity()` returns `{ url, submissions(), close() }`. Each call starts an independent
server with its own in-memory submissions, so a test can assert that nothing was sent (count `0`)
and a journey can reply without leaving state behind. Run it from the repo root with an explicit
path, e.g. `pnpm exec vitest run packages/cli/src/bizops-fixture-server.test.ts`.
