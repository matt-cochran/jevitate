import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { ProjectLayoutError, resolveLayout, withProjectFlags } from "./project-layout.js";
import { resolveJourneysDir } from "./cli-shared.js";

/**
 * #585: `resolveLayout` (docs/contracts/project-layout.md §3/§4). Every test drives a public
 * outcome with the `cwd`/`homedir` seams and a temp dir — never the real home.
 */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-layout-resolve-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const home = (): string => join(root, "home");
const deps = (cwd: string): { readonly cwd: () => string; readonly homedir: () => string } => ({ cwd: () => cwd, homedir: home });

/** A project (`.jevitate/` + `journeys/`) at `<root>/app`, with a cwd below it and an unrelated cwd. */
function project(): { readonly parent: string; readonly projectDir: string; readonly cwd: string; readonly unrelated: string } {
  const parent = join(root, "app");
  const projectDir = join(parent, ".jevitate");
  mkdirSync(join(projectDir, "journeys"), { recursive: true });
  mkdirSync(join(parent, "src"));
  const unrelated = join(root, "elsewhere");
  mkdirSync(unrelated);
  return { parent, projectDir, cwd: join(parent, "src"), unrelated };
}

/** A Journey store and a home that exist, for the existence-checked flags. */
function store(): string {
  const dir = join(root, "store");
  mkdirSync(dir);
  return dir;
}

function layoutError(fn: () => unknown): ProjectLayoutError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProjectLayoutError) return err;
    throw err;
  }
  throw new Error("expected a ProjectLayoutError");
}

describe("resolveLayout: §3.1 paths resolved against the working directory", () => {
  it("resolves a relative --journeys-dir against the cwd", () => {
    const dir = store();
    expect(resolveLayout({ journeysDir: "store" }, { dirMeaning: "journeys", deps: deps(root) }).journeysDir).toBe(dir);
  });

  it("resolves a relative --project against the cwd", () => {
    const p = project();
    expect(resolveLayout({ project: "app" }, { dirMeaning: "journeys", deps: deps(root) }).projectDir).toBe(p.projectDir);
  });
});

describe("resolveLayout: §3.2 --dir is exclusive with the new flags", () => {
  it("refuses --dir together with --project as E_PROJECT_ARGS", () => {
    const p = project();
    expect(layoutError(() => resolveLayout({ dir: store(), project: p.parent }, { dirMeaning: "journeys", deps: deps(root) })).code).toBe("E_PROJECT_ARGS");
  });

  it("refuses --dir together with --journeys-dir as E_PROJECT_ARGS", () => {
    const dir = store();
    expect(layoutError(() => resolveLayout({ dir: dir, journeysDir: dir }, { dirMeaning: "journeys", deps: deps(root) })).code).toBe("E_PROJECT_ARGS");
  });

  it("names the replacement flags in the E_PROJECT_ARGS next action", () => {
    const p = project();
    expect(layoutError(() => resolveLayout({ dir: store(), project: p.parent }, { dirMeaning: "journeys", deps: deps(root) })).nextAction).toMatch(/--project|--journeys-dir/);
  });
});

describe("resolveLayout: §3.3 an explicit path that does not exist", () => {
  it("refuses a nonexistent --project as E_PROJECT_DIR_MISSING", () => {
    const missing = join(root, "missing");
    expect(layoutError(() => resolveLayout({ project: missing }, { dirMeaning: "journeys", deps: deps(root) })).code).toBe("E_PROJECT_DIR_MISSING");
  });

  it("refuses a nonexistent --project with a ProjectLayoutError, never a raw ENOENT", () => {
    const missing = join(root, "missing");
    expect(layoutError(() => resolveLayout({ project: missing }, { dirMeaning: "journeys", deps: deps(root) }))).toBeInstanceOf(ProjectLayoutError);
  });

  it("creates nothing for a nonexistent --project", () => {
    const missing = join(root, "missing");
    layoutError(() => resolveLayout({ project: missing }, { dirMeaning: "journeys", deps: deps(root) }));
    expect(existsSync(missing)).toBe(false);
  });

  it("names jevitate init in the E_PROJECT_DIR_MISSING next action", () => {
    const missing = join(root, "missing");
    expect(layoutError(() => resolveLayout({ project: missing }, { dirMeaning: "journeys", deps: deps(root) })).nextAction).toMatch(/jevitate init/);
  });

  it("refuses a nonexistent --journeys-dir as E_PROJECT_DIR_MISSING", () => {
    const missing = join(root, "missing");
    expect(layoutError(() => resolveLayout({ journeysDir: missing }, { dirMeaning: "journeys", deps: deps(root) })).code).toBe("E_PROJECT_DIR_MISSING");
  });
});

describe("resolveLayout: §3.4 --project is a .jevitate dir or its parent", () => {
  it("accepts a .jevitate directory itself as the project", () => {
    const p = project();
    expect(resolveLayout({ project: p.projectDir }, { dirMeaning: "journeys", deps: deps(root) }).projectDir).toBe(p.projectDir);
  });

  it("accepts the directory containing .jevitate as the project", () => {
    const p = project();
    expect(resolveLayout({ project: p.parent }, { dirMeaning: "journeys", deps: deps(root) }).projectDir).toBe(p.projectDir);
  });

  it("refuses a directory with no .jevitate as E_PROJECT_LAYOUT", () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(layoutError(() => resolveLayout({ project: empty }, { dirMeaning: "journeys", deps: deps(root) })).code).toBe("E_PROJECT_LAYOUT");
  });

  it("names the expected --project in the E_PROJECT_LAYOUT next action", () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(layoutError(() => resolveLayout({ project: empty }, { dirMeaning: "journeys", deps: deps(root) })).nextAction).toMatch(/--project/);
  });
});

describe("resolveLayout: §3.5 requireProject, §3.1/§3.6 defaults", () => {
  it("refuses requireProject with no project found as E_PROJECT_NOT_FOUND", () => {
    const p = project();
    expect(layoutError(() => resolveLayout({}, { dirMeaning: "project", requireProject: true, deps: deps(p.unrelated) })).code).toBe("E_PROJECT_NOT_FOUND");
  });

  it("names --project or jevitate init in the E_PROJECT_NOT_FOUND next action", () => {
    const p = project();
    expect(layoutError(() => resolveLayout({}, { dirMeaning: "project", requireProject: true, deps: deps(p.unrelated) })).nextAction).toMatch(/--project|jevitate init/);
  });

  it("keeps the catalog dir null outside a project (no ~/.jevitate fallback)", () => {
    const p = project();
    expect(resolveLayout({}, { dirMeaning: "project", deps: deps(p.unrelated) }).catalogDir).toBeNull();
  });

  it("defaults the journeys dir to the project's journeys inside a project", () => {
    const p = project();
    expect(resolveLayout({}, { dirMeaning: "journeys", deps: deps(p.cwd) }).journeysDir).toBe(join(p.projectDir, "journeys"));
  });

  it("reports the project journeys default as from journeys 'project'", () => {
    const p = project();
    expect(resolveLayout({}, { dirMeaning: "journeys", deps: deps(p.cwd) }).from.journeys).toBe("project");
  });

  it("discovers the project from the working directory", () => {
    const p = project();
    expect(resolveLayout({}, { dirMeaning: "journeys", deps: deps(p.cwd) }).from.project).toBe("discovered");
  });

  it("reports no project as from project 'none' outside a project", () => {
    const p = project();
    expect(resolveLayout({}, { dirMeaning: "journeys", deps: deps(p.unrelated) }).from.project).toBe("none");
  });

  it("defaults the journeys dir to ~/.jevitate/journeys outside a project", () => {
    const p = project();
    expect(resolveLayout({}, { dirMeaning: "journeys", deps: deps(p.unrelated) }).journeysDir).toBe(join(home(), ".jevitate", "journeys"));
  });

  it("reports the home journeys default as from journeys 'home'", () => {
    const p = project();
    expect(resolveLayout({}, { dirMeaning: "journeys", deps: deps(p.unrelated) }).from.journeys).toBe("home");
  });

  it("creates no store when it defaults to the per-user journeys dir", () => {
    const p = project();
    resolveLayout({}, { dirMeaning: "journeys", deps: deps(p.unrelated) });
    expect(existsSync(join(home(), ".jevitate", "journeys"))).toBe(false);
  });

  it("reports --project as from project 'flag'", () => {
    const p = project();
    expect(resolveLayout({ project: p.parent }, { dirMeaning: "journeys", deps: deps(root) }).from.project).toBe("flag");
  });
});

describe("resolveLayout: §3.6 an explicit store is never redirected", () => {
  it("lets --journeys-dir win over --project for the journey store", () => {
    const p = project();
    const dir = store();
    expect(resolveLayout({ project: p.parent, journeysDir: dir }, { dirMeaning: "journeys", deps: deps(root) }).journeysDir).toBe(dir);
  });

  it("reports --journeys-dir as from journeys 'flag'", () => {
    const dir = store();
    expect(resolveLayout({ journeysDir: dir }, { dirMeaning: "journeys", deps: deps(root) }).from.journeys).toBe("flag");
  });

  it("sets the catalog dir to the project even with a separate journeys dir", () => {
    const p = project();
    expect(resolveLayout({ project: p.parent, journeysDir: store() }, { dirMeaning: "journeys", deps: deps(root) }).catalogDir).toBe(p.projectDir);
  });
});

describe("resolveLayout: the deps.journeysDir seam wins over discovery but not flags", () => {
  it("reports the seam as from journeys 'seam'", () => {
    const p = project();
    expect(resolveLayout({}, { dirMeaning: "journeys", deps: { ...deps(p.cwd), journeysDir: join(root, "seam") } }).from.journeys).toBe("seam");
  });

  it("does not let the seam win over --journeys-dir", () => {
    const dir = store();
    expect(resolveLayout({ journeysDir: dir }, { dirMeaning: "journeys", deps: { ...deps(root), journeysDir: join(root, "seam") } }).journeysDir).toBe(dir);
  });

  it("does not let the seam win over a journeys-meaning --dir", () => {
    const dir = store();
    expect(resolveLayout({ dir: dir }, { dirMeaning: "journeys", deps: { ...deps(root), journeysDir: join(root, "seam") } }).journeysDir).toBe(dir);
  });
});

describe("resolveLayout: the deprecated --dir per meaning (§2)", () => {
  it("uses a journeys-meaning --dir as the journey store", () => {
    const dir = store();
    expect(resolveLayout({ dir: dir }, { dirMeaning: "journeys", deps: deps(root) }).journeysDir).toBe(dir);
  });

  it("reports a journeys-meaning --dir as from journeys 'dir'", () => {
    const dir = store();
    expect(resolveLayout({ dir: dir }, { dirMeaning: "journeys", deps: deps(root) }).from.journeys).toBe("dir");
  });

  it("names --journeys-dir in the journeys-meaning deprecation line", () => {
    expect(resolveLayout({ dir: store() }, { dirMeaning: "journeys", deps: deps(root) }).deprecation).toBe("jevitate: --dir is deprecated here; use --journeys-dir <path> (same meaning)");
  });

  it("uses a project-meaning --dir as the project", () => {
    const p = project();
    expect(resolveLayout({ dir: p.parent }, { dirMeaning: "project", deps: deps(root) }).projectDir).toBe(p.projectDir);
  });

  it("reports a project-meaning --dir as from project 'dir'", () => {
    const p = project();
    expect(resolveLayout({ dir: p.parent }, { dirMeaning: "project", deps: deps(root) }).from.project).toBe("dir");
  });

  it("names --project in the project-meaning deprecation line", () => {
    const p = project();
    expect(resolveLayout({ dir: p.parent }, { dirMeaning: "project", deps: deps(root) }).deprecation).toBe("jevitate: --dir is deprecated here; use --project <path> (same meaning)");
  });
});

describe("resolveLayout: §3.8 the same store from any cwd", () => {
  it("resolves the same journeys dir from inside the project and from an unrelated cwd via --project", () => {
    const p = project();
    const discovered = resolveLayout({}, { dirMeaning: "journeys", deps: deps(p.cwd) });
    const viaFlag = resolveLayout({ project: p.parent }, { dirMeaning: "journeys", deps: deps(p.unrelated) });
    expect(discovered.journeysDir).toBe(viaFlag.journeysDir);
  });
});

describe("withProjectFlags", () => {
  it("adds --project and --journeys-dir and no --dir", () => {
    expect(withProjectFlags(new Command()).options.map((o) => o.long)).toEqual(["--project", "--journeys-dir"]);
  });

  it("gives both flags help text", () => {
    expect(withProjectFlags(new Command()).options.every((o) => o.description.length > 0)).toBe(true);
  });
});

describe("resolveJourneysDir delegates to the resolver", () => {
  it("returns the flag when given", () => {
    const dir = store();
    expect(resolveJourneysDir({ profiles: new ProfileManager("/unused"), journeysDir: join(root, "seam") }, dir)).toBe(dir);
  });

  it("returns the deps.journeysDir seam when no flag is given", () => {
    const seam = join(root, "seam");
    expect(resolveJourneysDir({ profiles: new ProfileManager("/unused"), journeysDir: seam })).toBe(seam);
  });
});
