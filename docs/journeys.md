# Journeys: record, author, replay and load-test

A **Journey** is Jevitate's deterministic, replayable browser flow: a Recording of typed steps
(Screenplay-style actions over Playwright) plus parameters and metadata. Discovery can be
nondeterministic, but a Journey replays the same way every time, and a replay never clicks a
guess ([how replay finds elements](./verification.md#replay-finds-the-recorded-element-exactly)).

## Author a Journey from a goal (needs model keys)

```bash
jevitate explore-author-journey --url http://localhost:3000 \
  --goal "add a product to the cart and reach checkout" --success urlIncludes:/checkout \
  --id checkout --name "Checkout" --real
jevitate journey promote checkout        # a human approval gate: unpromoted Journeys never run
jevitate journey run checkout
```

The authored Journey carries its `--success` check as its final assertion, so a replay fails when
the flow stops reaching its goal. It is written unpromoted: promotion is always a deliberate human
act. `--takes <n>` corroborates the flow over several takes.

## Record a flow by demonstration

```bash
jevitate record --url http://localhost:3000 --intent "check out with a saved card"
```

`record` opens a headed browser and records what you do; Enter or Ctrl+C ends the take and saves
it. The take can then be post-processed:

- `jevitate recording diff takeA.json takeB.json` classifies which values vary between takes.
- `jevitate recording postdoc take.json --decisions decisions.json --out recording.json` marks
  values as constants, variables or human hand-backs.
- `jevitate recording promote take.json --page 0 --step 2 --var email` turns one value into a
  variable.
- `jevitate recording fit take.json` derives a timing policy from your pacing.

A recorded take is a Recording, one step short of a Journey: there is no single command yet that
turns a post-processed take into a promoted Journey (see the `jevitate-record` skill's "Known
gaps"). `explore-author-journey` is the direct path today.

## Run, heal, share and load-test

```bash
jevitate journey list
jevitate journey run checkout --param sku=A1 --storage-state auth.json
jevitate journey run checkout --self-heal hybrid --real     # repair a broken step under policy
jevitate load run checkout --authorized-origin http://localhost:3000 --concurrency 5 --iterations 10 --seed 1
```

- `--self-heal fail-closed` (the default) stops and quarantines on a broken step. `hybrid` and
  `full` re-learn only the broken step and need `--real` (or `--fake-ai`). Write and irreversible
  steps are never auto-healed in any mode.
- A Journey that declares `metadata.requiresAuth: true` refuses to start without
  `--storage-state`, before any browser opens.
- `load run` replays a promoted Journey with a seeded, human-paced pool of actors, and refuses to
  start without `--authorized-origin`.
- Distributed sources share Journeys through git: `jevitate source add <name> <gitUrl>`,
  `source trust <name> <journeyId>` (bound to the Journey's content hash), `source run`, and
  `jevitate journey publish <id> --to <source>`.

Over MCP, agents find and run promoted Journeys with `find_capabilities` and `run_journey`
([agents.md](./agents.md)).
