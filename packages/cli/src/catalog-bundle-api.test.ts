import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram, type CliDeps } from "./program.js";
import { exportCatalogBundle, renderCatalogExport, type ExportCatalogBundleRequest } from "./catalog-bundle-api.js";
import type { GitExec } from "./change-context.js";

/** #464 (d464a): `exportCatalogBundle`'s I/O — where and how `bundle.json` is written, and what it refuses to overwrite. */

const SAMPLE = fileURLToPath(new URL("../test-fixtures/catalog-bundle/sample-project", import.meta.url));
const fakeGit: GitExec = async (args) => ({ stdout: args[0] === "rev-parse" ? "592a7021c4f0be9d3a8e6b1f2c7d4e5a6b7c8d9e\n" : "" });
const deps = { git: fakeGit, version: () => "0.10.0" };

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): { root: string; req: (outDir?: string) => ExportCatalogBundleRequest } {
  const root = mkdtempSync(join(tmpdir(), "jev-bundle-api-"));
  tmpDirs.push(root);
  cpSync(SAMPLE, root, { recursive: true });
  return {
    root,
    req: (outDir = join(root, "out")) => ({ format: "journeeze-bundle", catalogDir: join(root, ".jevitate"), journeysDir: join(root, ".jevitate", "journeys"), outDir }),
  };
}

describe("exportCatalogBundle", () => {
  it("writes <out>/bundle.json and reports what it exported", async () => {
    const p = project();
    const r = await exportCatalogBundle(p.req(), deps);
    expect({ path: r.bundlePath, counts: r.counts }).toEqual({ path: join(p.root, "out", "bundle.json"), counts: { personas: 2, jobs: 2, journeys: 1, checks: 4, findings: 0, media: 0 } });
  });

  it("writes the bundle's minor as 1", async () => {
    const r = await exportCatalogBundle(project().req(), deps);
    expect((JSON.parse(readFileSync(r.bundlePath, "utf8")) as { minor: number }).minor).toBe(1);
  });

  it("reports the digest of the bytes it wrote (the upload's Idempotency-Key)", async () => {
    const r = await exportCatalogBundle(project().req(), deps);
    expect(r.digest).toBe(`sha256-${createHash("sha256").update(readFileSync(r.bundlePath)).digest("hex")}`);
  });

  it("writes the same bytes for the same catalog (no export timestamp), so a re-publish dedupes", async () => {
    const p = project();
    const first = await exportCatalogBundle(p.req(), deps);
    expect((await exportCatalogBundle(p.req(), deps)).digest).toBe(first.digest);
  });

  it("leaves nothing but bundle.json in the out directory (the temp file is renamed into place)", async () => {
    const p = project();
    await exportCatalogBundle(p.req(), deps);
    expect(readdirSync(join(p.root, "out"))).toEqual(["bundle.json"]);
  });

  it("refuses an out directory holding other content, and leaves it untouched", async () => {
    const p = project();
    mkdirSync(join(p.root, "out"));
    writeFileSync(join(p.root, "out", "notes.txt"), "mine");
    await expect(exportCatalogBundle(p.req(), deps)).rejects.toMatchObject({ code: "E_CATALOG_EXPORT_ARGS" });
  });

  it("refuses to overwrite a bundle.json that is not a catalog bundle", async () => {
    const p = project();
    mkdirSync(join(p.root, "out"));
    writeFileSync(join(p.root, "out", "bundle.json"), JSON.stringify({ name: "something else" }));
    await expect(exportCatalogBundle(p.req(), deps)).rejects.toMatchObject({ code: "E_CATALOG_EXPORT_ARGS" });
  });

  it("refuses an out path that is a file", async () => {
    const p = project();
    await expect(exportCatalogBundle(p.req(join(p.root, "package.json")), deps)).rejects.toMatchObject({ code: "E_CATALOG_EXPORT_ARGS" });
  });

  it("does not create the out directory when it refuses the catalog", async () => {
    const p = project();
    writeFileSync(join(p.root, ".jevitate", "jobs.json"), JSON.stringify([{ id: "j", trigger: "ana@example.com asks", motivation: "m", outcome: "o" }]));
    await exportCatalogBundle(p.req(), deps).catch(() => undefined);
    expect(existsSync(join(p.root, "out"))).toBe(false);
  });

  it("warns when the catalog has uncommitted changes (the producer commit is HEAD)", async () => {
    const dirty: GitExec = async (args) => ({ stdout: args[0] === "rev-parse" ? "592a7021c4f0be9d3a8e6b1f2c7d4e5a6b7c8d9e\n" : " M .jevitate/jobs.json\n" });
    const r = await exportCatalogBundle(project().req(), { ...deps, git: dirty });
    expect(r.warnings).toContainEqual(expect.stringMatching(/uncommitted changes/));
  });

  it("renders a one-line summary plus one line per warning", async () => {
    const r = await exportCatalogBundle(project().req(), deps);
    expect(renderCatalogExport(r).split("\n")[0]).toMatch(/^wrote .*bundle\.json \(sha256-[0-9a-f]{64}\): 2 persona\(s\), 2 job\(s\), 1 Journey\(s\), 4 check\(s\), 0 finding\(s\)$/);
  });
});

describe("jevitate catalog export --format journeeze-bundle", () => {
  async function cli(argv: readonly string[], root: string): Promise<{ code: number | undefined; out: string }> {
    const stdout: string[] = [];
    const program = buildProgram({ profiles: new ProfileManager(join(root, "profiles")), dbPath: join(root, "site.sqlite"), journeysDir: join(root, "journeys") } as CliDeps);
    const tree = (c: Command): void => {
      c.exitOverride();
      c.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: () => {} });
      c.commands.forEach(tree);
    };
    tree(program);
    process.exitCode = undefined;
    let code: number | undefined;
    try {
      await program.parseAsync([...argv], { from: "user" });
      code = process.exitCode === undefined ? undefined : Number(process.exitCode);
    } catch (err) {
      if (!(err instanceof CommanderError)) throw err;
      code = err.exitCode;
    } finally {
      process.exitCode = undefined;
    }
    return { code, out: stdout.join("") };
  }

  it("--json: exit 0 and the written bundle's path and counts", async () => {
    const p = project();
    const r = await cli(["catalog", "export", "--format", "journeeze-bundle", "--dir", join(p.root, ".jevitate"), "--out", join(p.root, "out"), "--json"], p.root);
    expect({ code: r.code, data: JSON.parse(r.out).data }).toMatchObject({ code: 0, data: { bundlePath: join(p.root, "out", "bundle.json"), counts: { journeys: 1 } } });
  });
});
