# Journey handoff contract (#582)

Status: contract for 0.18.0. A producing Journey declares the record it outputs; a consuming
Journey declares the record it accepts, the request a caller supplies, and how both bind to its
params. Both are optional and additive: a Journey without them validates, hashes and chains exactly as
in 0.17.0.

## 1. Field types

| Type | Accepts | Never |
| --- | --- | --- |
| `id` | a non-empty opaque string, 1–512 chars, no control characters, compared byte for byte | trimmed, case-folded or coerced from a number |
| `text` | any string up to 20 000 chars, newlines kept verbatim | trimmed, normalised or paraphrased |
| `path` | a site-relative path: starts with `/`, not `//`, no scheme, no `..` segment, ≤ 2048 chars | an absolute URL |
| `url` | an absolute `http(s)` URL whose origin is one of the Journey's allowed origins (`recording.site`, `metadata.allowedOrigins`, the run's environment) | a new origin: a supplied URL never widens what a run may reach |
| `timestamp` | an ISO 8601 UTC instant (`…Z`) | a local time |

## 2. Producing Journey: `metadata.outputs`

```json
"outputs": {
  "contract": "community-conversation@1",
  "collection": "records",
  "key": ["commentId", "account"],
  "fields": {
    "provider":   { "type": "id" },
    "channel":    { "type": "id" },
    "account":    { "type": "id" },
    "postId":     { "type": "id" },
    "threadId":   { "type": "id" },
    "commentId":  { "type": "id" },
    "parentId":   { "type": "id", "required": false },
    "permalink":  { "type": "path" },
    "sourceText": { "type": "text" }
  }
}
```

- `contract` is `<name>@<major>` (`[a-z0-9][a-z0-9.-]{0,63}@[1-9][0-9]{0,3}`).
- `collection` names a `forEach` `as`; records are read from `<collection>.<i>.<field>` and
  `<collection>.count` (0.17.0). Absent: one record from flat `<field>` outputs.
- `key` lists the fields that identify a record (all `id`, all required). Default: every required
  `id` field.
- `required` defaults to `true`. Every field must be produced by an `extract` (`as`) of the Journey;
  a field nothing extracts is refused at load (`outputs: field <f> is never extracted`).

## 3. Consuming Journey: `metadata.inputs`

```json
"inputs": {
  "accepts": "community-conversation@1",
  "request": {
    "fields": { "commentId": { "type": "id" }, "account": { "type": "id" }, "replyText": { "type": "text" } },
    "key": ["commentId", "account"]
  },
  "bindings": {
    "commentId":           { "record": "commentId" },
    "replyIdentity":       { "record": "account" },
    "threadId":            { "record": "threadId" },
    "expected_commentid":  { "record": "commentId" },
    "expected_account":    { "record": "account" },
    "expected_sourcetext": { "record": "sourceText" },
    "replyText":           { "request": "replyText" }
  }
}
```

- `bindings` maps each param of this Journey to exactly one source: `{ "record": f }` (a field of
  the accepted record), `{ "request": f }` (a field of the caller's request), `{ "const": "v" }` (a
  literal reviewed in the file), or `{ "secret": "<secretRef name>" }` (an operator secret, never
  supplied by a record, request or constant).
- Refused at load (`E_HANDOFF_SCHEMA` issues, with the path): a binding to an undeclared param; a
  required run param (`journeyParamSchema`) with no binding; a secret param bound to anything but
  `secret`; a non-secret param bound to `secret`; a `record`/`request` binding to a field the
  contract does not declare (`request` fields are local; `record` fields come from the producing
  Journey at chain time, §4).
- `request.key` must be a subset of the request's `id` fields; the chain matches on it.

## 4. Validation before any reply run (`packages/journey/src/handoff.ts`, pure)

In this order, all before the consuming Journey runs even once:

1. **Compatibility.** `to.inputs.accepts` must equal `from.outputs.contract` (name and major), and
   every `record` binding must name a field `from.outputs.fields` declares
   (`E_HANDOFF_INCOMPATIBLE`, chain refused).
2. **Records.** Each discovered record against `from.outputs.fields`: missing required, unknown,
   wrong type or malformed values are field-level errors (`missing`, `unknown`, `type`,
   `malformed`). An invalid record is never run; requests matching it are reported `invalid-record`.
3. **Duplicates.** Two records with the same `key` are ambiguous: neither is run, and requests
   matching that key are reported `ambiguous` (no guess, no "first wins").
4. **Empty.** Zero records stops the chain (`E_CHAIN_EMPTY`, 0.17.0).
5. **Requests.** Each request against `to.inputs.request.fields` (same codes). A malformed request is
   `invalid-request` and never run; the rest proceed.
6. **Binding.** Params come only from the bindings. Validation never fetches, never reads the page and
   never evaluates captured text: a record's `sourceText` is data, compared by the Journey's own
   checks during the live run, never instructions.

Contract validation is not verification: a well-typed but stale record still reaches the Journey,
whose pre-composer checks (`expected_*`) must fail it before anything is written.

Errors and receipts name the field, the rule and the record/request key. They never contain a
`text` value, a secret or a `url`/`path` value beyond its origin.

## 5. Chain behaviour

When `to` declares `inputs`, `journey chain` (and MCP `chain_journeys`) uses §4 and the bindings in
place of the 0.17.0 fixed request keys and fixed param mapping. When it does not, 0.17.0 behaviour
is unchanged. Each `runs[]` entry gains:

- `contract`: the accepted contract (`name@major`);
- `fingerprint`: `sha256:` of the canonical JSON of the record's declared fields (keys sorted),
  so a reviewer can tell two runs saw the same context without seeing it;
- `capturedAt`: when the producing run finished (UTC, from the injectable clock).

and the result gains `rejected: [{ key, reason: "invalid-record" | "ambiguous" | "invalid-request", errors: [{ field, code }] }]`.

## 6. Review and re-review

`outputs` and `inputs` are part of the Journey file, so they are part of its content hash
(`journeyContentHash`): changing a contract, a field or a binding makes a promoted Journey's approval
stale and requires re-review. Absent fields are not hashed, so 0.17.0 hashes do not change.
`journey review` shows both blocks; readiness (#581) reports their compatibility.

## 7. Not in scope

Approval of reply text (Bizops owns copy, version and expiry), sending, and any new authority. No
binding can enable a submit step.
