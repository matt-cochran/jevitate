import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { PersistedMissionResultSchema } from "@jevitate/domain";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { consolidate, renderJUnit, renderReportMarkdown, renderSarif } from "@jevitate/findings";
import { runExploration } from "./explore-api.js";
import { loadRunFile } from "./report-api.js";
import { runVerifyFix } from "./verify-fix-api.js";

/**
 * #250 served acceptance — the example-site defect: Save answers `PUT /api/profile → 500` while the
 * page says "Saved". With evidence on, the defect gets a captioned repro clip (its failing step
 * marked "server returned 500 (PUT /api/profile)", the replay seeing it fire again) and key
 * screenshots just before and at the failing step, linked from the result (and the persisted file),
 * the issue draft, the consolidated report, JUnit and SARIF. A registered secret on the page is
 * masked in both screenshots. `verify-fix --record-video` then gives a before/after pair.
 */

const SECRET = "acct-7788-SECRET-zz";
let app: Server;
let origin: string;
let broken = true;

const profilePage = `<!doctype html><html><body style="background:#fff;font:16px sans-serif"><main>
<h1>Profile</h1>
<p>Account: <span id="acct">${SECRET}</span></p>
<button id="save" type="button">Save</button>
<p id="status"></p>
<script>
  document.getElementById("save").addEventListener("click", async () => {
    await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"name":"Zoë"}' }).catch(() => {});
    document.getElementById("status").textContent = "Saved";
    history.pushState({}, "", location.pathname + "?saved=1");
  });
</script></main></body></html>`;

beforeAll(async () => {
  app = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/profile") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(profilePage);
    if (path === "/api/profile") return void res.writeHead(broken ? 500 : 200, { "content-type": "application/json" }).end("{}");
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

/** Clicks Save, then proposes `done`. */
class ClickThenDone implements JudgmentPort {
  #i = 0;
  async systemOne(args: { questions: Record<string, { kind: string; options?: readonly string[] }> }): Promise<Record<string, Answer>> {
    const out: Record<string, Answer> = {};
    if (!("action" in args.questions)) {
      for (const [name, q] of Object.entries(args.questions)) if (q.kind === "noul") out[name] = { kind: "noul", value: true, probability: 0.95 };
      return out;
    }
    const options = args.questions.action?.options ?? [];
    const value = this.#i++ === 0 ? (options.find((o) => o.startsWith("click")) ?? "done") : "done";
    out.action = { kind: "choice", value, confidence: 0.9 };
    return out;
  }
}

async function magentaShare(p: Page, png: Buffer, rect: { x: number; y: number; width: number; height: number }): Promise<number> {
  return p.evaluate(
    async ({ src, r }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(Math.floor(r.x), Math.floor(r.y), Math.ceil(r.width), Math.ceil(r.height)).data;
      let hit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) hit++;
      return hit / (d.length / 4);
    },
    { src: `data:image/png;base64,${png.toString("base64")}`, r: rect },
  );
}

describe("defect evidence (served, real Chromium)", () => {
  it(
    "PUT /api/profile → 500: a captioned clip + before/at screenshots, linked from the result, draft, report, JUnit and SARIF; verify-fix --record-video gives before/after",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-250-"));
      try {
        broken = true;
        const run = await runExploration({
          url: `${origin}/profile`,
          goal: "save the profile",
          allowlist: [origin],
          judge: new ClickThenDone(),
          gen: new FakeGenerationGateway({}),
          successAssertion: { kind: "urlIncludes", text: "saved=1" },
          bounds: { maxDecisions: 4, maxActions: 4 },
          secrets: [SECRET],
          outDir,
          browserPortFactory: () => new PlaywrightBrowserPort(),
          evidenceVideo: true,
        });
        const d0 = run.defects.find((d) => d.kind === "http-5xx");
        expect(d0).toBeDefined();

        const withEvidence = run;
        const d = withEvidence.defects.find((x) => x.fingerprint === d0?.fingerprint) as (typeof withEvidence.defects)[number] & {
          evidence?: { videoPath?: string; screenshots: string[]; signal?: string; reproduced?: boolean; failingStep?: number; captureSkips?: string[] };
        };
        const ev = d.evidence;
        expect(ev?.captureSkips, JSON.stringify(ev?.captureSkips)).toBeUndefined();
        expect(ev?.signal).toBe("server returned 500 (PUT /api/profile)");
        expect(ev?.reproduced).toBe(true);
        expect(ev?.videoPath).toMatch(/\.evidence\/[0-9a-f]{16}\/clip\.webm$/);
        expect(statSync(ev?.videoPath ?? "").size).toBeGreaterThan(0);
        const step = ev?.failingStep ?? 0;
        expect(ev?.screenshots.map((s) => basename(s))).toEqual([`before-step-${step}.png`, `at-step-${step}.png`]);
        for (const s of ev?.screenshots ?? []) expect(existsSync(s)).toBe(true);

        // The persisted result carries it too, and still parses under the unified schema (additive).
        const persisted = PersistedMissionResultSchema.parse(JSON.parse(readFileSync(run.resultPath, "utf8")));
        const pd = persisted.result.defects.find((x) => x.fingerprint === d0?.fingerprint);
        expect(pd?.evidence?.videoPath).toBe(ev?.videoPath);

        // The issue draft links the media (before its fingerprint marker); no secret in it.
        const draft = withEvidence.issues.drafts.find((x) => x.fingerprint === d0?.fingerprint);
        expect(draft).toBeDefined();
        const md = readFileSync(draft?.path ?? "", "utf8");
        expect(md).toContain("## Repro clip and screenshots");
        expect(md).toContain(ev?.videoPath ?? "?");
        expect(md).toContain("server returned 500 (PUT /api/profile)");
        expect(md).toContain("GitHub's API cannot upload media");
        expect(md.indexOf("## Repro clip and screenshots")).toBeLessThan(md.indexOf("<!-- jevitate-fingerprint"));
        expect(md).not.toContain(SECRET);

        // report / check: the consolidated defect's evidence refs name the clip and screenshots.
        const rec = loadRunFile(run.resultPath);
        expect(rec).not.toBeNull();
        const [cd] = consolidate([rec!]).filter((x) => x.fingerprints.includes(d0?.fingerprint ?? ""));
        expect(cd?.evidence.some((e) => e.video === ev?.videoPath)).toBe(true);
        const report = renderReportMarkdown({ title: "t", runs: [rec!], defects: [cd!] });
        expect(report).toContain(`video \`${ev?.videoPath}\``);
        const junit = renderJUnit("s", [
          { suite: "t", classname: "c", name: "n", timeSec: 1, status: "failed", message: "m", attachments: [ev?.videoPath ?? "", ...(ev?.screenshots ?? [])] },
        ]);
        expect(junit).toContain(`<property name="attachment" value="${ev?.videoPath}"/>`);
        expect(junit).toContain(`[[ATTACHMENT|${ev?.videoPath}]]`);
        const sarif = JSON.stringify(renderSarif({ toolVersion: "0", suiteUri: "suite.json", automationId: "a", findings: [{ defect: cd!, gating: true }] }));
        expect(sarif).toContain(`"attachments"`);
        expect(sarif).toContain(ev?.videoPath ?? "?");

        // The secret is masked in both screenshots (measured where it renders, unmasked).
        const probe = await new PlaywrightBrowserPort().open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
        try {
          await probe.page.goto(`${origin}/profile`);
          const box = await probe.page.locator("#acct").boundingBox();
          if (box === null) throw new Error("no box");
          for (const s of ev?.screenshots ?? []) expect(await magentaShare(probe.page, readFileSync(s), box)).toBe(1);
        } finally {
          await probe.close();
        }

        // verify-fix --record-video after the fix: before (the run's clip) + after (a new captioned clip).
        broken = false;
        const vf = await runVerifyFix({
          resultPath: run.resultPath,
          fingerprint: d0?.fingerprint ?? "",
          replays: 1,
          secrets: [SECRET],
          browser: { recordVideo: { dir: join(outDir, "vf") } },
          browserPortFactory: () => new PlaywrightBrowserPort(),
          evidencePaceMs: 50,
        });
        expect(vf.verdict).toBe("fixed");
        expect(vf.evidence?.before?.videoPath).toBe(ev?.videoPath);
        expect(vf.evidence?.after?.videoPath).toMatch(/clip\.webm$/);
        expect(existsSync(vf.evidence?.after?.videoPath ?? "")).toBe(true);
        expect(vf.evidence?.after?.reproduced).toBe(false);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    420_000,
  );
});
