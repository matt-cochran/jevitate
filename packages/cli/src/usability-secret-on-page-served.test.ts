import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type GenerationPort, type JudgmentPort } from "@jevitate/ai-core";
import { runUsabilityMission } from "./ux-api.js";

/**
 * #219 — usability on a page that DISPLAYS a registered secret (in its text and in an input's
 * value), with the model typing that very value: the review completes, and no judgment/generation
 * payload, transcript, Recording, evidence or result file written carries the value. Served page,
 * real Chromium, spied gateways.
 */

const SECRET = "test@example.test";
const forms = [SECRET, encodeURIComponent(SECRET)];
const leaks = (s: string): boolean => forms.some((f) => s.includes(f));

const PAGE = `<!doctype html><html><head><title>Profile</title></head><body>
<h1>Profile settings</h1>
<p>Signed in as ${SECRET}</p>
<form id="f">
  <label>Display name <input name="displayName" aria-label="Display name" value="Ada"></label>
  <label>Email <input name="email" type="email" aria-label="Email" value="${SECRET}"></label>
  <button type="submit">Save</button>
</form>
<p role="status" id="s"></p>
<script>
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    await fetch("/api/profile", { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    document.getElementById("s").textContent = "Saved " + e.target.email.value;
  });
</script>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/")) {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** Every text file under `dir` (screenshots excluded), recursively. */
async function textFiles(dir: string): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await textFiles(p)));
    else if (!/\.(png|jpe?g|webp)$/i.test(e.name)) out.push({ path: p, text: await readFile(p, "utf8") });
  }
  return out;
}

describe("#219 — usability on a page showing a registered secret", () => {
  it(
    "completes; no payload, transcript, Recording, evidence or result file carries the secret",
    async () => {
      const payloads: unknown[] = [];
      let step = 0;
      /** Types into Email, clicks Save, then proposes done; every advisory head answers low. */
      const judge: JudgmentPort = {
        async systemOne(args) {
          payloads.push(args);
          const out: Record<string, Answer> = {};
          for (const [key, q] of Object.entries(args.questions)) {
            // The decision's "already met" head says no (so the job is acted); a proposed done is met.
            if (q.kind === "noul") {
              const p = "action" in args.questions ? 0.05 : 0.95;
              out[key] = { kind: "noul", value: p >= 0.5, probability: p };
            }
            else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
            else if (key === "action") {
              const find = (op: string, label: string): string | undefined =>
                q.options.find((o) => o.startsWith(`${op}:`) && (q.descriptions?.[o] ?? "").includes(label));
              const pick = step === 0 ? find("type", "Email") : step === 1 ? find("click", "Save") : "done";
              step += 1;
              out[key] = { kind: "choice", value: pick ?? "done", confidence: 0.9 };
            } else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.1 };
          }
          return out;
        },
      };
      const inputs: unknown[] = [];
      const fake = new FakeGenerationGateway({ "form.value": { text: SECRET } });
      const gen: GenerationPort = {
        generate: async (kind, input) => {
          inputs.push({ kind, input });
          return fake.generate(kind, input);
        },
      };
      const outDir = await mkdtemp(join(tmpdir(), "jev-usability-secret-"));
      try {
        const result = await runUsabilityMission({
          url: `${origin}/profile`,
          job: "Save my profile with my email address",
          allowlist: [origin],
          appContext: { appClass: "consumer", job: "Save my profile with my email address" },
          judge,
          gen,
          secrets: [SECRET],
          judgmentBudget: 2,
          minConfidence: 0,
          bounds: { maxDecisions: 4 },
          outDir,
        });
        expect(step).toBeGreaterThanOrEqual(2);
        // The model typed the very secret into Email: recorded redacted, never in the clear.
        const recording = await readFile(result.recordingPath, "utf8");
        expect(recording).toMatch(/"redacted":\s*true/);
        expect(result.missionOutcome).not.toBe("crashed");
        expect(result.failure?.message ?? "").not.toMatch(/secret/i);
        expect(result.outcome.status).toBe("completed");
        expect(payloads.length).toBeGreaterThan(0);
        expect(leaks(JSON.stringify(payloads))).toBe(false);
        expect(leaks(JSON.stringify(inputs))).toBe(false);
        expect(leaks(JSON.stringify(result))).toBe(false);
        const files = await textFiles(outDir);
        expect(files.length).toBeGreaterThan(0);
        expect(files.filter((f) => leaks(f.text)).map((f) => f.path)).toEqual([]);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
