# #580 blockers on 0.16.1

What stands between 0.16.1 and the #580 definition of complete. Each blocker names the
deliverable of the 0.17.0 plan that removes it. Shapes are fixed in
[journey-chain-contract.md](../journey-chain-contract.md).

| # | Blocker | Repro on 0.16.1 | Owning code | Removed by |
| --- | --- | --- | --- | --- |
| B1 | A `forEach` child `extract` binds one flat name per field, overwritten on every row, so a run can return only the last conversation | discover over an inbox of 4 comments: `output.commentId` is the 4th; rows 1–3 are lost | `packages/interpreter/src/run-step.ts` (`forEach` case, `vars.set`) | `journey-output-chaining` (indexed `records.<i>.<field>` + `records.count`) |
| B2 | No supported way to feed one Journey's outputs to another, so callers copy values into `--param` by hand, or guess when nothing is found | none: the operation does not exist | `packages/cli` | `journey-output-chaining` (`jevitate journey chain`) |
| B3 | `verify --mutate` swaps a select-fed param to a value that is not an option: `selectOption` times out after 30 s and the proof reads as cascade (#579) | reply Journey: 2 sensitive / 5 cascade; discover: 0 sensitive / 5 cascade | `packages/journey/src/mutation-proof*.ts`, `packages/interpreter/src/run-step.ts` | `select-option-aware-mutation`, `reviewed-values-in-proof` |
| B4 | `truncate-param` on a select-fed param is planned as a proof though half an option value is never a valid choice | same runs as B3 | `packages/journey/src/mutation-proof.ts` | `select-option-aware-mutation` |
| B5 | No reviewed mutation value per parameter: when a page has a single valid alternative the proof cannot be steered to it | n/a (field missing) | `packages/journey/src/journey.ts` (`JourneyParameter`) | `param-mutation-values-contract` |
| B6 | `journey review --strict` flags missing job/persona links; the links need catalog entries, and their approval is human-only | strict review on either Journey | `.jevitate/jobs.json`, `personas.json` | `bizops-catalog-links`, then `human-catalog-signoff` |
| B7 | No offline fixture with ≥2 identities, ≥2 threads, parents and permalinks, and a countable Send | n/a | `test/fixtures/` | `bizops-fixture-app` |

Checked and **not** blockers:

- Assertion-only inputs (`expected_*`) are accepted, required when missing and refused when unknown
  since 0.16.1 (#573).
- MCP `verify_journey` already carries `params` and `mutate`
  (`packages/cli/src/mcp-cli-tools.ts`, `verify_journey`). `run_journey` carries `params`. Only
  the chain operation (B2) needs a new MCP tool, which goes through the `@jevitate/mcp-facade`
  allowlist.
- Multiline `fill` followed by an exact `valueEquals` passes on 0.16.1 (#580 evidence).

New blockers found while delivering go in this table, with the deliverable that removes them.
