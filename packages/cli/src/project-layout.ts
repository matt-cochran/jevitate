/**
 * #585: one resolver for every command that reads or writes a project's Journeys or catalog —
 * `docs/contracts/project-layout.md` §3 (resolution) and §4 (this API). It resolves the location
 * flags against the working directory once, refuses an unusable explicit path with a typed error
 * (and a concrete next action), and reports where each location came from. It never copies,
 * rewrites or relocates files: the same Journey content reaches the same content hash whichever
 * flag or cwd reached it.
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { findProjectDir, homeDataRoot, type LayoutDeps } from "./project-dir.js";

/** What a deprecated `--dir` means for this command (§2). */
export type DirMeaning = "journeys" | "project";

/** The raw location flags of one invocation. */
export interface LayoutFlags {
  readonly project?: string;
  readonly journeysDir?: string;
  readonly dir?: string;
}

/** Where each resolved location came from. */
export interface LayoutOrigin {
  readonly project: "flag" | "dir" | "discovered" | "none";
  readonly journeys: "flag" | "dir" | "project" | "home" | "seam";
}

/** The resolved locations for one invocation (§4). */
export interface ResolvedLayout {
  /** The `.jevitate` directory, or null outside a project. */
  readonly projectDir: string | null;
  /** The Journey store (§1: project journeys, else `~/.jevitate/journeys`). */
  readonly journeysDir: string;
  /** Where the catalog files live; the project dir, with no fallback. */
  readonly catalogDir: string | null;
  readonly from: LayoutOrigin;
  /** The §2 stderr line, when the deprecated `--dir` was used. */
  readonly deprecation?: string;
}

/** The refusal codes of §3/§4. */
export type ProjectLayoutErrorCode = "E_PROJECT_ARGS" | "E_PROJECT_DIR_MISSING" | "E_PROJECT_LAYOUT" | "E_PROJECT_NOT_FOUND";

/** A refused layout: the code, and the concrete next action (a command or flag) that resolves it. */
export class ProjectLayoutError extends Error {
  readonly code: ProjectLayoutErrorCode;
  readonly nextAction: string;

  constructor(code: ProjectLayoutErrorCode, message: string, nextAction: string) {
    super(message);
    this.name = "ProjectLayoutError";
    this.code = code;
    this.nextAction = nextAction;
  }
}

/** The §2 deprecation line `--dir` prints (stderr, never the `--json` stdout envelope). */
function deprecationFor(meaning: DirMeaning): string {
  return meaning === "journeys"
    ? "jevitate: --dir is deprecated here; use --journeys-dir <path> (same meaning)"
    : "jevitate: --dir is deprecated here; use --project <path> (same meaning)";
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The directory `jevitate init` would create the project in, for a missing project path. */
function initDirFor(path: string): string {
  return basename(path) === ".jevitate" ? dirname(path) : path;
}

/**
 * Resolves the project, catalog and Journey locations for one invocation (§3 steps 1-8).
 *
 * `dirMeaning` is the command's current meaning for the deprecated `--dir` (§2): `journeys`
 * commands keep using it as the store, project/catalog commands as the project. `requireProject`
 * refuses with `E_PROJECT_NOT_FOUND` when a command needs the catalog but no project was found —
 * never falling back to `~/.jevitate`. `deps` carries the CLI's test seams (`cwd`/`homedir`, and
 * the `CliDeps.journeysDir` seam that wins over discovery but not over a flag).
 */
export function resolveLayout(
  flags: LayoutFlags,
  opts: { readonly dirMeaning: DirMeaning; readonly requireProject?: boolean; readonly deps?: LayoutDeps & { readonly journeysDir?: string } },
): ResolvedLayout {
  const { dirMeaning } = opts;
  const deps = opts.deps ?? {};

  // §3.1: every explicit path is resolved against the working directory, once, before any check.
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const projectFlag = flags.project === undefined ? undefined : resolve(cwd, flags.project);
  const journeysFlag = flags.journeysDir === undefined ? undefined : resolve(cwd, flags.journeysDir);
  const dirFlag = flags.dir === undefined ? undefined : resolve(cwd, flags.dir);

  // §3.2: the deprecated --dir is exclusive with the two new flags.
  if (dirFlag !== undefined && (projectFlag !== undefined || journeysFlag !== undefined)) {
    throw new ProjectLayoutError(
      "E_PROJECT_ARGS",
      "--dir cannot be combined with --project or --journeys-dir",
      "drop --dir and pass --project for the project, or --journeys-dir for the Journey store",
    );
  }

  // Where the project comes from: --project, or a project-meaning --dir, else discovery (§1).
  const projectPath = projectFlag ?? (dirMeaning === "project" ? dirFlag : undefined);

  // §3.3: an explicit project path or Journey store that does not exist is refused (never a raw
  // ENOENT), and nothing is created. The deprecated --dir-as-journeys keeps its current meaning and
  // is used as given (a command's store need not exist yet); --dir-as-project is a project path.
  if (projectPath !== undefined && !existsSync(projectPath)) {
    throw new ProjectLayoutError(
      "E_PROJECT_DIR_MISSING",
      `the project path ${projectPath} does not exist`,
      `run jevitate init in ${initDirFor(projectPath)}, or pass an existing --project <dir>`,
    );
  }
  if (journeysFlag !== undefined && !existsSync(journeysFlag)) {
    throw new ProjectLayoutError(
      "E_PROJECT_DIR_MISSING",
      `the journeys dir ${journeysFlag} does not exist`,
      `check the path and pass an existing --journeys-dir <path>, or run jevitate init to create the project store`,
    );
  }

  // §3.4: a `.jevitate` directory is the project; otherwise it must contain one.
  let projectDir: string | null;
  let fromProject: LayoutOrigin["project"];
  if (projectPath !== undefined) {
    if (basename(projectPath) === ".jevitate") {
      if (!isDir(projectPath)) {
        throw new ProjectLayoutError(
          "E_PROJECT_LAYOUT",
          `--project ${projectPath} is not a directory`,
          `pass the .jevitate directory itself or its parent with --project <path>, or run jevitate init in ${initDirFor(projectPath)}`,
        );
      }
      projectDir = projectPath;
    } else {
      const nested = join(projectPath, ".jevitate");
      if (!isDir(nested)) {
        throw new ProjectLayoutError(
          "E_PROJECT_LAYOUT",
          `--project ${projectPath} is not a .jevitate directory and does not contain one (expected ${nested})`,
          `pass the .jevitate directory itself or its parent with --project <path>, or run jevitate init in ${projectPath}`,
        );
      }
      projectDir = nested;
    }
    fromProject = projectFlag !== undefined ? "flag" : "dir";
  } else {
    projectDir = findProjectDir({ cwd: () => cwd, ...(deps.homedir === undefined ? {} : { homedir: deps.homedir }) });
    fromProject = projectDir === null ? "none" : "discovered";
  }

  // §3.5: a command that needs the catalog is refused when no project was found; never ~/.jevitate.
  if (projectDir === null && opts.requireProject === true) {
    throw new ProjectLayoutError(
      "E_PROJECT_NOT_FOUND",
      "no project found: the working directory is not inside a .jevitate/ and --project was not given",
      "pass --project <dir>, or run jevitate init in the project",
    );
  }

  // §3.6: journeys default exactly as today; an explicit store is never redirected. Precedence is
  // flag > deprecated --dir > the CLI's journeysDir seam > project discovery > ~/.jevitate.
  let journeysDir: string;
  let fromJourneys: LayoutOrigin["journeys"];
  if (journeysFlag !== undefined) {
    journeysDir = journeysFlag;
    fromJourneys = "flag";
  } else if (dirMeaning === "journeys" && dirFlag !== undefined) {
    journeysDir = dirFlag;
    fromJourneys = "dir";
  } else if (deps.journeysDir !== undefined) {
    journeysDir = deps.journeysDir;
    fromJourneys = "seam";
  } else if (projectDir !== null) {
    journeysDir = join(projectDir, "journeys");
    fromJourneys = "project";
  } else {
    journeysDir = join(homeDataRoot(deps), "journeys");
    fromJourneys = "home";
  }

  const deprecation = dirFlag === undefined ? undefined : deprecationFor(dirMeaning);
  return {
    projectDir,
    journeysDir,
    catalogDir: projectDir,
    from: { project: fromProject, journeys: fromJourneys },
    ...(deprecation === undefined ? {} : { deprecation }),
  };
}

/**
 * Adds the standard project-location flags, `--project <path>` and `--journeys-dir <path>` (§2/§4).
 * It does not add the deprecated `--dir`: that stays on a command while it is being migrated, so the
 * resolver can report it.
 */
export function withProjectFlags<C extends Command>(cmd: C): C {
  cmd
    .option("--project <path>", "the project: a .jevitate directory or the directory containing it; sets the catalog dir and the default journeys dir")
    .option("--journeys-dir <path>", "the Journey store only; wins over --project for journeys, while the catalog still comes from --project");
  return cmd;
}
