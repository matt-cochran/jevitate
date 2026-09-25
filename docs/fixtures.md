# Mission fixtures: known state before every run and replay

Exploration changes app state, and a replay that starts from different state proves little.
Fixtures put the app into a known state before a mission, restore it afterwards, and do the same
around **every replay**: hang confirmation, `verify-fix` and `regression capture`.

```bash
jevitate explore --strategy adversarial --url http://localhost:3000/projects/new --fake-ai \
  --fixtures fixtures.json
```

```json
{
  "setup": [
    { "name": "project", "method": "POST", "url": "/api/projects", "json": { "name": "fixture" },
      "expectStatus": [201], "outputs": { "projectId": "$.id" } }
  ],
  "restore": [
    { "method": "DELETE", "url": "/api/projects/${setup.projectId}" }
  ]
}
```

- Steps are HTTP requests to an `--allow` origin only (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`,
  `DELETE`), authenticated the way the page is: the `--storage-state` session or a
  `--secret-field` binding. A fixtures file can never carry literal credential headers or run a
  command.
- `outputs` bind values from a response (`$.json.path` or `header:<name>`) as `${setup.<name>}`,
  which you can use in `--url`, `--goal`, `--success`, a Journey's `--param`s and later steps,
  but never in the URL's origin.
  `secretOutputs` are redacted everywhere and never reach text a model sees.
- `${secretField.<VAR>}` puts a `--secret-field` value (read from `env:<VAR>`) into a step's
  `json`, `body` or `headers`, for example to log in to an app that keeps its token in memory.
  It is refused in a URL, never written to the step log, result or Recording, and redacted from
  every error. An unknown reference is refused before any browser or request. A credential
  header may hold only references, and a `${setup.x}` it uses must be a secret output.
  `verify-fix` re-binds the referenced variables.
- A setup that fails, times out or leaves a `${setup.x}` unresolved ends the run `inconclusive`
  as a configuration error. A mission never runs on unknown state.
- A target can declare its fixtures in `~/.jevitate/targets.json` instead of passing `--fixtures`.

**Shell hooks.** `--before <cmd>` and `--after <cmd>` run your own commands around the mission and
every replay, only with `--allow-shell-hooks`, with a timeout (`--hook-timeout-ms`, default 60000)
that kills the process group. They come from your command line only, never from a file or a
model. Exit codes are recorded, and stdout is never persisted.
