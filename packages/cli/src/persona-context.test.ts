import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPersonasFile } from "./multi-run.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-persona-context-"));
  writeFileSync(join(dir, "admin.json"), "{}");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePersonas(value: unknown): string {
  const path = join(dir, "personas.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("#741 persona context", () => {
  it("a persona with context exposes its organization and role", () => {
    const path = writePersonas({ personas: [{ name: "admin", storageState: "admin.json", context: { organization: "Acme", role: "admin" } }] });
    expect(loadPersonasFile(path)[0]!.context).toEqual({ organization: "Acme", role: "admin" });
  });

  it("a persona without context parses exactly as before", () => {
    const path = writePersonas({ admin: "admin.json" });
    expect(loadPersonasFile(path)).toEqual([{ name: "admin", storageState: join(dir, "admin.json") }]);
  });

  it("an unknown key inside context is refused with a clear error", () => {
    const path = writePersonas({ personas: [{ name: "admin", storageState: "admin.json", context: { organization: "Acme", team: "payments" } }] });
    expect(() => loadPersonasFile(path)).toThrow(/context.*unknown key.*team/i);
  });
});
