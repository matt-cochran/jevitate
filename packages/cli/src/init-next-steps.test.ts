import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { environmentHint, initNextSteps } from "./init-next-steps.js";
import { ENVIRONMENTS_SCAFFOLD } from "./project-dir.js";

const base = { skills: true, dryRun: false } as const;

describe("initNextSteps", () => {
  it("keys ready: a goal run, an authored Journey, a demo, the CI gate — at most 5 lines", () => {
    const lines = initNextSteps({ ...base, keysReady: true, env: "local" });
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toContain("jevitate explore --url <app-url> --goal");
    expect(lines[0]).toContain("--real");
    expect(lines[1]).toContain("jevitate explore-author-journey");
    expect(lines[2]).toContain('jevitate demo "<aspect>" --env local');
    expect(lines[3]).toContain("jevitate check --suite");
    expect(lines.join("\n")).not.toContain("ai setup");
  });

  it("keys missing: the key-free adversarial run and record, then how to add keys — never --real", () => {
    const lines = initNextSteps({ ...base, keysReady: false });
    expect(lines[0]).toContain("jevitate explore --strategy adversarial --url <app-url> --fake-ai");
    expect(lines[1]).toContain("jevitate record --url <app-url>");
    expect(lines[2]).toContain("jevitate ai setup generation");
    expect(lines.join("\n")).not.toContain("--real");
  });

  it("uses a configured app URL when one is known", () => {
    expect(initNextSteps({ ...base, keysReady: true, appUrl: "http://127.0.0.1:5173" })[0]).toContain("--url http://127.0.0.1:5173");
  });

  it("agent line: registered, declined, skipped, or absent", () => {
    const reg = initNextSteps({ ...base, keysReady: true, mcp: [{ target: "claude-code", path: "/x/.mcp.json", action: "create" }] });
    expect(reg.at(-1)).toMatch(/MCP server registered for claude-code/);
    const dry = initNextSteps({ ...base, dryRun: true, keysReady: true, mcp: [{ target: "cursor", path: "/x", action: "create" }] });
    expect(dry.at(-1)).toMatch(/would be registered for cursor/);
    const declined = initNextSteps({ ...base, keysReady: true, mcp: [{ target: "codex", path: "/x", action: "skip-conflict" }] });
    expect(declined.at(-1)).toMatch(/NOT registered \(codex/);
    expect(initNextSteps({ ...base, keysReady: true }).at(-1)).toMatch(/jevitate mcp --print-config/);
    expect(initNextSteps({ keysReady: true, skills: false, dryRun: false }).at(-1)).toContain("jevitate check");
  });
});

describe("environmentHint", () => {
  const dirWith = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "jev-next-"));
    writeFileSync(join(dir, "environments.json"), content);
    return dir;
  };

  it("the untouched scaffold names the env but never presents its example URL as the app's", () => {
    expect(environmentHint(dirWith(JSON.stringify(ENVIRONMENTS_SCAFFOLD)))).toEqual({ env: "local" });
  });

  it("a configured, non-production env gives its name and baseUrl", () => {
    const dir = dirWith(JSON.stringify({ prod: { baseUrl: "https://app.example.com", production: true }, dev: { baseUrl: "http://localhost:5173" } }));
    expect(environmentHint(dir)).toEqual({ env: "dev", appUrl: "http://localhost:5173" });
  });

  it("no project dir or an unreadable file keeps the placeholders", () => {
    expect(environmentHint(null)).toEqual({});
    expect(environmentHint(dirWith("{not json"))).toEqual({});
  });
});
