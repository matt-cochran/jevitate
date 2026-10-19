# Journey chaining contract (#580)

Status: contract for 0.17.0. It fixes the shapes that the discover Journey, the prepare-only reply
Journey, `jevitate journey chain` and its MCP tool share. Implementations follow it; changing it is
a contract change.

## 1. Conversation record

One open conversation the discover Journey found. Every field is a string; an absent optional field
is omitted, never `""`.

| Field | Required | Meaning |
| --- | --- | --- |
| `provider` | yes | The social provider, e.g. `community` |
| `channel` | yes | The channel or profile the conversation belongs to |
| `account` | yes | The reply identity that may answer it |
| `postId` | yes | The post the conversation is on |
| `threadId` | yes | The thread inside the post |
| `commentId` | yes | The comment to reply to. **The record's key** |
| `parentId` | no | The comment `commentId` replies to, when it is a reply |
| `permalink` | yes | The native path or URL that reopens exactly this comment |
| `sourceText` | yes | The comment's full text, as shown (may be multiline) |

Identity is `commentId` plus `account`. A list position, an author name or a truncated snippet is
never an identity.

## 2. Discover Journey outputs

The discover Journey walks the open conversations with `forEach` (`"as": "records"`) and one
`extract` per record field (`"as": "<field>"`) inside it. A run's `output` then holds:

- `records.count`: the number of rows, as a decimal string;
- `records.<i>.<field>` for each row `i` (0-based, page order) and each extracted field.

This indexed binding is new in 0.17.0. A `forEach` child `extract` keeps its row-scoped binding
(`<field>`, last row wins) exactly as before, so existing Journeys are unchanged. An extract that
finds nothing fails the step; it never binds `""`. A `forEach` that matches no row fails its step
(as it always has), so an empty inbox ends the discover run quarantined: nothing is returned, and
nothing can be guessed from it.

## 3. Prepare-only reply Journey params

The reply Journey reopens one conversation and prepares, never sends, the reply.

| Param | From | Used by |
| --- | --- | --- |
| `commentId` | record | the `navigate` that reopens the comment, through the Journey's own URL template (e.g. `/c/${commentId}`) |
| `replyIdentity` | record `account` | the `select` of the reply identity |
| `threadId` | record | the `select` of the thread |
| `expected_commentid`, `expected_parentid`, `expected_account`, `expected_sourcetext` | record | assertion-only checks **before** the composer is touched (#573) |
| `replyText` | the approved request | the composer `fill`, then `valueEquals { "var": "replyText" }` |

`permalink` is not a param: a navigate placeholder is one percent-encoded path segment (#399), so a
whole path or URL cannot be passed through it. The record keeps `permalink` for Bizops and for
people; the Journey owns its site's URL template and proves the page it opened is the right one
with the `expected_*` checks.

`expected_parentid` is declared only by a Journey for replies to replies. The Journey ends with
the composer filled and **zero** submissions: no Send click, no submit key press, no implicit
submission. Self-heal never adds a step that sends or changes the account or text.

## 4. Approved requests

Bizops owns copy approval. Jevitate never grants, substitutes or extends it. The chain reads a
JSON Lines file of prepare-only requests, one per line:

```json
{ "commentId": "c-1001", "account": "mcpl", "replyText": "Thanks!\nWe will follow up." }
```

`commentId` and `account` must match a discovered record exactly; `replyText` is passed verbatim.
Any other key is refused (`E_CHAIN_REQUEST`). Approval metadata (version, expiry, approver) stays in
Bizops and is not read here.

## 5. `jevitate journey chain`

```bash
jevitate journey chain --from discover-conversations --to prepare-reply \
  --requests approved.jsonl [--param name=value ...] [--base-url <url> | --env <name>] \
  [--storage-state <file>] [--json]
```

`--param name=value` (repeatable) supplies the **producer's** (`--from`) params, so one discover
Journey serves any account or thread by params and nothing is hardcoded in the Journey. The
values are validated against the producer's param schema before anything runs: a missing
required param or an unknown name is refused with `E_CHAIN_PARAMS` and no browser is opened.
Supplied values are redacted from every `reason` in the result. Reply (`--to`) params still come
only from the records and requests (section 3).

1. Runs `--from` once. A failed run stops the chain (`E_CHAIN_FROM_FAILED`); an empty inbox
   is one (section 2), and its result keeps the run's `reason`.
2. Reads its `records.*` outputs. Missing or zero `records.count` stops the chain
   (`E_CHAIN_EMPTY`): no target is guessed.
3. Joins each request to the record with the same `commentId` and `account`. A request with no
   match is reported `unmatched` and **not run**. A record with no request is not run.
4. Runs `--to` once per matched request with the params of section 3 (each only when the `--to`
   Journey declares it, except `replyText`, which it must declare). Each run is validated as
   `journey run` validates params; a missing record field is `E_CHAIN_FIELD` for that request.
5. Exits non-zero unless every request matched and every run was `ok`.

`--json` result (names and outcomes only; no record or reply text is ever echoed):

```json
{
  "from": { "journey": "discover-conversations", "outcome": "ok", "records": 4 },
  "runs": [
    { "commentId": "c-1001", "account": "mcpl", "outcome": "ok" },
    { "commentId": "c-2002", "account": "personal", "outcome": "quarantined", "reason": "step 3 failed: …" }
  ],
  "unmatched": [{ "commentId": "c-9999", "account": "mcpl" }]
}
```

## 6. MCP

The same operation is one MCP tool taking `{ from, to, requests: [<request>], params?, baseUrl?, env? }`
(`params` is an object of producer param names to values, validated and redacted as in section 5)
and returning the section 5 result. It is added to `ALLOWED_TOOLS` only through the
`@jevitate/mcp-facade` allowlist review. It takes no selectors, scripts or extra fields: the
Journeys are the only behaviour.

## 7. Readiness for a linked pair

`jevitate journey readiness <discover> --with <reply>` in `replay` or `prove` mode runs the
pair through this chain. `--param name=value` values are passed to the producer through the
chain. An unknown param is refused with `E_READINESS_PARAMS` before any browser opens (a missing
required param is refused the same way, as before).

In `prove` mode the consumer's mutation proof runs with the params the chain bound for the first
matched request (the record fields and the request). If no request matched, the consumer proof is
`not-verified` and the hint asks for a `--requests` line that matches a discovered record.
