import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { Assertion, RecordedStep } from "@jevitate/recording";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { buildMcpTools } from "./mcp-api.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all" });

/**
 * #399 served acceptance (real Chromium): a Journey whose navigate URL holds a SECRET `${param}`
 * (a single-use invitation token) runs with `--param` (CLI) and `params` (MCP run_journey), reaches
 * the right URL, a param can never move the navigation to another origin, and the token appears in
 * no output or artifact of the run — JSON, stderr, screenshots + index, video, action deltas,
 * failure messages (incl. Playwright's own navigation error, which echoes the URL).
 */

// Distinctive core (found in any encoding) + characters that need strict percent-encoding.
const CORE = "Zq7InviteK3y";
const SECRET = `${CORE}'(/ x)!*`;

const PAGE = (h: string, extra = ""): string =>
  `<!doctype html><html><head><title>${h}</title></head><body><main><h1>${h}</h1>${extra}</main></body></html>`;

let server: Server;
let other: Server;
let origin: string;
let otherOrigin: string;
let root: string;
const seen: string[] = [];
const paths: string[] = [];
let otherHits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    paths.push(u.pathname);
    const html = (code: number, body: string): void => void res.writeHead(code, { "content-type": "text/html; charset=utf-8" }).end(body);
    if (u.pathname === "/accept") {
      const token = u.searchParams.get("token") ?? "";
      seen.push(token);
      return token === SECRET ? html(200, PAGE("Invitation accepted", `<a href="/team">Team</a>`)) : html(403, PAGE("Invalid invitation"));
    }
    if (u.pathname === "/team") return html(200, PAGE("Team"));
    if (u.pathname === "/drop") return void req.socket.destroy();
    html(404, PAGE("Not found"));
  });
  other = createServer((_req, res) => {
    otherHits += 1;
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE("Evil"));
  });
  await Promise.all([server, other].map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "jevitate-399-"));
  const store = new FsJourneyStore(join(root, "journeys"));
  await store.put(journey("accept-invite", "/accept?token=${inviteToken}", [
    { step: { kind: "click", target: { role: "link", name: "Team" }, expect: { kind: "visible", target: { role: "heading", name: "Team" } } }, objective: "Open the team" },
  ]));
  await store.put(journey("accept-then-fail", "/accept?token=${inviteToken}", [
    { step: { kind: "assert", check: { kind: "urlIncludes", text: "/nowhere" } } },
  ]));
  await store.put(journey("drop", "/drop?token=${inviteToken}", [], { kind: "urlIncludes", text: "/drop" }));
  await store.put({
    ...journey("go", "/${dest}", [], { kind: "urlIncludes", text: "/" }),
    metadata: { ...journey("go", "/", []).metadata, params: ["dest"], parameters: [{ name: "dest" }] },
  });
});

afterAll(async () => {
  await Promise.all([server, other].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await rm(root, { recursive: true, force: true });
});

function journey(id: string, url: string, after: RecordedStep[], expectOnNav?: Assertion): Journey {
  return {
    metadata: {
      id,
      name: `Accept an invitation (${id})`,
      promoted: true,
      params: [],
      parameters: [{ name: "inviteToken", description: "the single-use invitation token", secret: true }],
      createdAtIso: "2026-10-07T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/accept",
          steps: [
            {
              step: { kind: "navigate", url, expect: expectOnNav ?? { kind: "visible", target: { role: "heading", name: "Invitation accepted" } } },
              objective: "Open the invitation link",
            },
            ...after,
          ],
        },
      ],
    },
  };
}

async function cli(args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir: join(root, "journeys"),
    dbPath: join(root, "no-site-policy.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), err: err.join(""), exitCode };
}

/** Every file under `dir` (recursively), as bytes decoded latin1 so binary media is scanned too. */
async function filesUnder(dir: string): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if ((await stat(p)).isDirectory()) out.push(...(await filesUnder(p)));
    else out.push({ path: p, text: (await readFile(p)).toString("latin1") });
  }
  return out;
}

function expectNoToken(where: string, text: string): void {
  expect(text, `${where} holds the token`).not.toContain(CORE);
}

describe("#399 navigate ${param} — served", () => {
  it("journey run --param reaches the right URL; the token is in no output or artifact", async () => {
    const media = join(root, "media-cli");
    seen.length = 0;
    const r = await cli([
      "journey", "run", "accept-invite", "--param", `inviteToken=${SECRET}`, "--json",
      "--record-video", join(media, "video"), "--screenshots", `steps:${join(media, "shots")}`, "--action-deltas",
    ]);
    expect(r.exitCode, r.out + r.err).toBe(0);
    const data = (JSON.parse(r.out) as { data: { outcome: string; screenshotPaths?: string[]; videoPaths?: string[] } }).data;
    expect(data.outcome).toBe("ok");
    expect(seen).toEqual([SECRET]); // the server received exactly the token, decoded
    expectNoToken("stdout", r.out);
    expectNoToken("stderr", r.err);
    const files = await filesUnder(media);
    expect(files.some((f) => f.path.endsWith(".png"))).toBe(true);
    expect(files.some((f) => f.path.endsWith("index.md"))).toBe(true);
    expect(files.some((f) => f.path.endsWith(".webm"))).toBe(true);
    for (const f of files) expectNoToken(f.path, f.text);
  }, 120_000);

  it("a failing run's messages never echo the token (a failed check, Playwright's own navigation error)", async () => {
    const fail = await cli(["journey", "run", "accept-then-fail", "--param", `inviteToken=${SECRET}`, "--json"]);
    expect(fail.exitCode).toBe(1);
    expect(fail.out).toMatch(/quarantined/);
    expectNoToken("failed-check stdout", fail.out + fail.err);

    const drop = await cli(["journey", "run", "drop", "--param", `inviteToken=${SECRET}`, "--json"]);
    expect(drop.exitCode).toBe(1);
    expect(drop.out).toMatch(/ERR_EMPTY_RESPONSE|net::/);
    expect(drop.out).toContain("<param inviteToken>");
    expectNoToken("navigation-error stdout", drop.out + drop.err);
  }, 120_000);

  it("a param value can never move the navigation to another origin", async () => {
    paths.length = 0;
    otherHits = 0;
    const evil = otherOrigin.replace(/^http:/, ""); // "//127.0.0.1:<port>"
    for (const dest of [evil, `/${evil}`, `\\\\${evil.slice(2)}`, `@${evil.slice(2)}`, `%2F%2F${evil.slice(2)}`]) {
      await cli(["journey", "run", "go", "--param", `dest=${dest}`, "--json"]);
    }
    expect(otherHits).toBe(0);
    expect(paths.length).toBeGreaterThan(0); // every navigation stayed on the Journey's own origin
  }, 120_000);

  it("MCP run_journey takes the same param (parity) — no token in its result or artifacts", async () => {
    const media = join(root, "media-mcp");
    seen.length = 0;
    const tool = buildMcpTools({ journeysDir: join(root, "journeys"), pathRoots: [root] }).find((t) => t.name === "run_journey")!;
    const res = await tool.handler({
      id: "accept-invite",
      params: { inviteToken: SECRET },
      recordVideo: join(media, "video"),
      screenshots: `steps:${join(media, "shots")}`,
    });
    const text = res.content.map((c) => c.text).join("\n");
    expect(res.isError, text).toBeUndefined();
    expect((JSON.parse(res.content[0]!.text) as { outcome: string }).outcome).toBe("ok");
    expect(seen).toEqual([SECRET]);
    expectNoToken("MCP result", text);
    for (const f of await filesUnder(media)) expectNoToken(f.path, f.text);
  }, 120_000);
});
