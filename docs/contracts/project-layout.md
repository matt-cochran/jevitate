# Project layout contract (#585)

Status: contract for 0.18.0. One set of location flags and one resolver for every command that reads
or writes a project's Journeys or catalog. Implementations follow it; changing it is a contract
change.

## 1. Locations

| Name | What it is | Default |
| --- | --- | --- |
| project dir | a `.jevitate/` directory: the catalog (`personas.json`, `jobs.json`) and the project's data | the nearest `.jevitate/` walking up from the working directory (never `~/.jevitate`) |
| journeys dir | the Journey store | `<project dir>/journeys`, else `~/.jevitate/journeys` outside a project (unchanged) |
| catalog dir | where the catalog files live | the project dir; **no fallback** |

## 2. Flags

| Flag | Meaning |
| --- | --- |
| `--project <path>` | the project. `<path>` may be the `.jevitate/` directory itself or the directory that contains it. Sets the project dir, hence the catalog dir and the default journeys dir |
| `--journeys-dir <path>` | the Journey store only. Wins over `--project` for Journeys; the catalog still comes from `--project` / discovery |
| `--dir <path>` | **deprecated**, kept with its current meaning per command (table below) |

| Commands | `--dir` meant | Use instead |
| --- | --- | --- |
| `journey list/find/run/verify/review/promote/migrate/anchors/publish/chain`, `journey anchor add/remove`, `journey annotate`, `journey demo`, `author-journey` | the journeys dir | `--journeys-dir` |
| `persona …`, `job …`, `catalog …`, `journey link` | the project dir | `--project` |

Other commands with a `--dir` (`check`, `load`, `serve`, `demo`, regressions, missions, logs, report)
are out of scope and unchanged.

A deprecated `--dir` prints exactly one line on stderr, never in the `--json` stdout envelope:

```
jevitate: --dir is deprecated here; use --journeys-dir <path> (same meaning)
```

## 3. Resolution

1. Paths are resolved against the working directory (`path.resolve`), once, before any other check.
2. `--dir` together with `--project` or `--journeys-dir` is refused (`E_PROJECT_ARGS`, exit 64).
3. An explicit path that does not exist is refused (`E_PROJECT_DIR_MISSING`, exit 64) with the next
   action (`run jevitate init in <dir>`, or check the path). Never a raw `ENOENT`. Nothing is created.
4. `--project <path>`: if `<path>` is named `.jevitate`, it is the project dir; else
   `<path>/.jevitate` must exist. Neither: `E_PROJECT_LAYOUT` (exit 64), naming what was expected.
5. A command that needs the catalog and finds no project (no flag, nothing found walking up) is
   refused with `E_PROJECT_NOT_FOUND` (exit 64) and the next action (`--project <dir>` or
   `jevitate init`). There is never a fallback to `~/.jevitate` for the catalog.
6. Journeys default exactly as today (§1). An explicit `--journeys-dir` is never redirected.
7. Path confinement, symlink and origin checks apply to the resolved paths exactly as before.
8. The same Journey content resolves to the same content hash whichever flag or cwd reached it: the
   resolver never copies, rewrites or relocates files.

## 4. Resolver API (`packages/cli/src/project-layout.ts`)

```ts
type DirMeaning = "journeys" | "project";
interface LayoutFlags { readonly project?: string; readonly journeysDir?: string; readonly dir?: string }
interface ResolvedLayout {
  readonly projectDir: string | null;   // the .jevitate dir
  readonly journeysDir: string;
  readonly catalogDir: string | null;   // = projectDir
  readonly from: { readonly project: "flag" | "dir" | "discovered" | "none"; readonly journeys: "flag" | "dir" | "project" | "home" | "seam" };
  readonly deprecation?: string;        // the §2 stderr line, when --dir was used
}
class ProjectLayoutError extends Error {
  readonly code: "E_PROJECT_ARGS" | "E_PROJECT_DIR_MISSING" | "E_PROJECT_LAYOUT" | "E_PROJECT_NOT_FOUND";
  readonly nextAction: string;
}
function resolveLayout(flags: LayoutFlags, opts: { dirMeaning: DirMeaning; requireProject?: boolean; deps?: LayoutDeps & { journeysDir?: string } }): ResolvedLayout;
function withProjectFlags<C extends Command>(cmd: C): C; // adds --project and --journeys-dir with standard help
```

`deps.journeysDir` is the existing CLI test seam (`CliDeps.journeysDir`) and wins over discovery but
not over a flag (`from.journeys: "seam"`). `resolveJourneysDir` in `cli-shared.ts` delegates to the
resolver so commands not yet migrated keep working.

## 5. `jevitate where`

Prints the resolved layout for the current flags and cwd: project dir, catalog dir, journeys dir, logs
dir and where each came from (`--json`: the `ResolvedLayout`). Paths only; no file contents, no
secrets. It accepts `--project` and `--journeys-dir`.

## 6. MCP

MCP tools never take `--project` or `--journeys-dir`, as they never take `--dir`: the store is the
server's (`OMIT.storeDir`). Parity tests record the decision for the new flags.
