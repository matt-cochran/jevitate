import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { runExploration } from "./explore-api.js";

/**
 * #159 — `--save-storage-state` must still be written when a run does NOT end cleanly, not only on
 * a clean success. `persistStorageState` runs in `runExploration`'s own `finally`, so it runs
 * whatever ended the `try` block — a clean return, a typed `crashed`/`inconclusive`/`blocked`
 * outcome from the mission engine's own (deliberately lenient — see its doc comments) failure
 * handling, or an exception that escapes it entirely.
 *
 * REAL Chromium against a served page: `/seed` has one button that navigates (a genuine browser
 * navigation via `location.href`, not a scripted one) to `/next`, which destroys the connection
 * outright — a real, unrecoverable mid-run network failure. The engine classifies this leniently
 * (`blocked`/`crashed`/`inconclusive`, never a silent throw out of the mission itself — by design),
 * but whichever it picks, the context is still open when `runExploration`'s `finally` runs, and the
 * storageState must still be written.
 */
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/seed") {
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<!doctype html><html><body><button type="button" onclick="location.href='/next'">Click</button></body></html>`,
      );
      return;
    }
    // /next (and anything else): destroy the connection outright — a fast, real navigation failure.
    req.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Picks the first non-"done" option for a "choice" question — same shape as the kill-signal
 *  harness's judge — so the run actually clicks the button instead of stopping at step 0. */
const clickJudge: JudgmentPort = {
  async systemOne({ questions }) {
    const out: Record<string, Answer> = {};
    for (const [name, q] of Object.entries(questions)) {
      if (q.kind === "choice") {
        const value = q.options.find((o) => o !== "done") ?? q.options[0]!;
        out[name] = { kind: "choice", value, confidence: 1 };
      } else if (q.kind === "noul") {
        out[name] = { kind: "noul", value: false, probability: 0 };
      } else {
        out[name] = { kind: "score", value: 0 };
      }
    }
    return out;
  },
};

describe("--save-storage-state survives a real mid-run failure (#159)", () => {
  it(
    "a run that hits a real navigation failure past the seed still writes the storageState in finally",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-storage-crash-"));
      const saveTo = join(outDir, "state.json");
      try {
        const result = await runExploration({
          url: `${origin}/seed`,
          goal: "click the button",
          successAssertion: { kind: "urlIncludes", text: "/never-reached" },
          allowlist: [origin],
          judge: clickJudge,
          gen: new FakeGenerationGateway(),
          outDir,
          saveStorageState: saveTo,
        });

        // The click's navigation never actually completed (the server destroyed the connection) —
        // this run never succeeded. Whatever the engine's own lenient classification landed on
        // (crashed/inconclusive/blocked), it is not a clean success.
        expect(result.outcome).not.toBe("succeeded");

        // Despite that, `finally` still ran `persistStorageState` — the file exists, mode 0600.
        const written = JSON.parse(await readFile(saveTo, "utf8"));
        expect(written).toHaveProperty("cookies");
        expect(written).toHaveProperty("origins");
        const mode = (await stat(saveTo)).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
