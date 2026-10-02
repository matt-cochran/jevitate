import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { RecordingSchema } from "@jevitate/recording";
import type { UxFinding } from "@jevitate/ux";
import { discoverRecordingSidecars, loadRecordingSidecars, runUsabilityMission, runUxReview } from "./ux-api.js";

/**
 * #198 ACCEPTANCE, served — the edge-case fixture pages through a real browser: each page plants
 * one real problem the review must catch and one look-alike it must not flag. The run's own loop
 * ends at once (a grounded `done`); what is tested is the claim pipeline's CODE side on a real page:
 * the guard probe (each destructive control clicked with writes blocked — not one write may reach
 * the server), the product-facts check, the cropped/boxed screenshots and the evidence sidecar's
 * offline reproduction. Jev's answers are scripted (grade "yes", duplicates "new") — the real
 * model's categorization and grade cutoffs need a separate real-model calibration pass.
 */

const writes: string[] = [];
/** Every request path the server saw, and every WebSocket frame it received. */
const seen: string[] = [];
const wsFrames: Buffer[] = [];
const upgraded: import("node:net").Socket[] = [];
/** A registered secret shown on the danger-zone page: it must never reach an artifact. */
const CANARY = `tok-canary-${Math.random().toString(36).slice(2)}-secret`;
let server: Server;
let origin: string;

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body style="font:16px sans-serif;margin:16px">${body}</body></html>`;

const PAGES: Record<string, string> = {
  // 1. Admin queue: Approve/Reject act at once (routine — look-alike); Delete user does too (real).
  "/admin/queue": page(
    "Queue",
    `<h1>Review queue</h1>
     <p>Ada Lovelace — pending</p>
     <button id="ap">Approve</button> <button id="rj">Reject</button>
     <p><button id="del">Delete user</button></p><p id="out"></p>
     <script>
       ap.onclick = () => fetch('/api/queue/1/approve', { method: 'POST' }).then(() => out.textContent = 'Approved');
       rj.onclick = () => fetch('/api/queue/1/reject', { method: 'POST' }).then(() => out.textContent = 'Rejected');
       del.onclick = () => fetch('/api/users/1', { method: 'DELETE' }).then(() => out.textContent = 'Deleted');
     </script>`,
  ),
  // 2. Members: the "…" menu's Remove asks first (look-alike); Remove all members does not (real).
  "/members": page(
    "Members",
    `<h1>Members</h1>
     <p>Grace Hopper <button id="more" aria-label="More actions">…</button></p>
     <div role="menu" aria-label="Grace Hopper actions"><button role="menuitem" id="rm">Remove</button></div>
     <p><button id="all">Remove all members</button></p>
     <script>
       rm.onclick = () => { if (confirm('Remove Grace Hopper?')) fetch('/api/members/1', { method: 'DELETE' }); };
       all.onclick = () => fetch('/api/members', { method: 'DELETE' });
     </script>`,
  ),
  // 3. Pricing: Pro's price is wrong (real); Starter's price and a saving are right (look-alikes).
  "/pricing": page(
    "Pricing",
    `<h1>Plans</h1>
     <div>Starter $29/month</div>
     <div>Pro $129/month</div>
     <div>Save $240 a year with annual billing</div>
     <a href="/pricing#upgrade">See plan details</a>`,
  ),
  // 4. Danger zone: Delete draft opens a confirmation dialog (look-alike); Delete workspace acts at once (real).
  "/settings/danger": page(
    "Danger zone",
    `<h1>Danger zone</h1>
     <p>Workspace token ${CANARY}</p>
     <p><button id="dd">Delete draft</button></p>
     <div role="alertdialog" aria-label="Confirm" id="dlg" hidden>Delete the draft? <button id="no">Cancel</button><button id="yes">Confirm</button></div>
     <p><button id="dw">Delete workspace</button></p>
     <script>
       dd.onclick = () => { dlg.hidden = false; };
       no.onclick = () => { dlg.hidden = true; };
       yes.onclick = () => fetch('/api/drafts/1', { method: 'DELETE' });
       dw.onclick = () => fetch('/api/workspace', { method: 'DELETE' });
     </script>`,
  ),
  // Fail-safe cases: a delete sent over a WebSocket (never probed), and a GET link that deletes.
  "/live": page(
    "Live",
    `<h1>Live list</h1><p>Item 1</p><button id="del">Delete item</button>
     <script>
       const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
       del.onclick = () => ws.send('delete 1');
     </script>`,
  ),
  "/files": page("Files", `<h1>Files</h1><p>report.pdf <a href="/delete?id=1">Delete file</a></p>`),
  // 5. Onboarding: the intended next step is obvious (look-alike); the trial length is wrong (real).
  "/onboarding": page(
    "Welcome",
    `<h1>Welcome</h1>
     <p>Start your 7-day free trial</p>
     <button>Create project</button> <button>Import</button>
     <a href="/onboarding#skip">Skip for now</a> <a href="/onboarding#docs">Read the docs</a>`,
  ),
};

const FACTS = {
  version: 1,
  plans: [
    { name: "Starter", prices: [{ amount: 29, interval: "month" }], trialDays: 14 },
    { name: "Pro", prices: [{ amount: 149, interval: "month" }], trialDays: 14 },
  ],
  journeys: [{ name: "Set up a workspace", routes: ["/onboarding", "/pricing"] }],
  pages: [{ route: "/onboarding", nextStep: "Create project", alternatives: ["Import", "Skip for now"] }],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    seen.push(path);
    if (req.method !== "GET" && req.method !== "HEAD") {
      writes.push(`${req.method} ${path}`);
      res.writeHead(204).end();
      return;
    }
    const html = PAGES[path];
    if (html === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  // A minimal WebSocket endpoint: the handshake, then every frame is recorded (never answered).
  server.on("upgrade", (req, socket) => {
    upgraded.push(socket as import("node:net").Socket);
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // Text/binary data frames only (opcode 1/2) — a close frame from a closing page is not a message.
    socket.on("data", (d: Buffer) => {
      const opcode = (d[0] ?? 0) & 0x0f;
      if (opcode === 1 || opcode === 2) wsFrames.push(d);
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const sock of upgraded) sock.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Ends the run at once (a grounded done); grades every claim "needed to ship"; no duplicates. */
const judge: JudgmentPort = {
  async systemOne({ questions }) {
    const out: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (key === "action" && q.kind === "choice") out[key] = { kind: "choice", value: q.options.includes("done") ? "done" : q.options[0]!, confidence: 0.9 };
      else if (q.kind === "noul") out[key] = { kind: "noul", value: true, probability: 0.9 };
      else if (q.kind === "score") out[key] = { kind: "score", value: 0.9 };
      else if (key.startsWith("dup::")) out[key] = { kind: "choice", value: "new", confidence: 0.9 };
      else out[key] = { kind: "choice", value: q.options.includes("not-a-problem") ? "not-a-problem" : q.options[0]!, confidence: 0.5 };
    }
    return out;
  },
};

const FIXTURES = [
  { path: "/admin/queue", mustCatch: ["destructive-unguarded", "Delete user"], mustNotFlag: ["Approve", "Reject"] },
  // The look-alike is refuted by the probe itself: the native confirm was seen (and dismissed).
  { path: "/members", mustCatch: ["destructive-unguarded", "Remove all members"], mustNotFlag: ['"Remove"', "More actions"], refuted: ['menuitem "Remove"', /confirm dialog/] },
  { path: "/pricing", mustCatch: ["fact-conflict", "$129"], mustNotFlag: ["Starter", "$240"] },
  { path: "/settings/danger", mustCatch: ["destructive-unguarded", "Delete workspace"], mustNotFlag: ["Delete draft"], refuted: ['button "Delete draft"', /opened a dialog/] },
  { path: "/onboarding", mustCatch: ["fact-conflict", "7-day"], mustNotFlag: ["Create project", "next-step"], refuted: ["", /"Create project" is on the page and enabled/] },
] as const satisfies ReadonlyArray<{ path: string; mustCatch: readonly [string, string]; mustNotFlag: readonly string[]; refuted?: readonly [string, RegExp] }>;

const text = (f: UxFinding): string => JSON.stringify([f.claim?.type, f.observation, f.controls, f.quotes, f.contributing ?? []]);

describe("#198 acceptance, served (real Chromium): the claim pipeline catches every planted problem and flags no look-alike", () => {
  for (const fx of FIXTURES) {
    it(
      fx.path,
      async () => {
        const outDir = await mkdtemp(join(tmpdir(), "jev-ux-claims-"));
        const product = join(outDir, "product.json");
        writeFileSync(product, JSON.stringify(FACTS));
        writes.length = 0;
        try {
          const result = await runUsabilityMission({
            url: `${origin}${fx.path}`,
            job: "look around the workspace",
            allowlist: [origin],
            appContext: { appClass: "admin", job: "look around the workspace" },
            judge,
            gen: new FakeGenerationGateway(),
            judgmentBudget: 10,
            minConfidence: 0,
            bounds: { maxDecisions: 2 },
            secrets: [CANARY],
            product,
            probeGuards: true,
            outDir,
            env: {},
            configPath: join(outDir, "no-config.json"),
            nowIso: () => "2026-10-01T00:00:00.000Z",
          });
          const report = result.report!;
          expect(report, result.analysisUnavailable).not.toBeNull();
          // Not one write reached the server: the run clicked nothing, and the probe blocks writes.
          expect(writes).toEqual([]);
          const findings = report.findings;
          const caught = findings.filter((f) => f.claim?.type === fx.mustCatch[0] && text(f).includes(fx.mustCatch[1]));
          expect(caught, JSON.stringify(findings.map(text))).toHaveLength(1);
          expect(caught[0]!.quality?.label).toBe("actionable");
          for (const look of fx.mustNotFlag) expect(findings.filter((f) => text(f).includes(look)).map(text), look).toEqual([]);
          if ("refuted" in fx) {
            const [target, why] = fx.refuted;
            const item = report.claims!.items.find((i) => i.status === "refuted" && (target === "" || i.target === target) && why.test(i.reason));
            expect(item, JSON.stringify(report.claims!.items)).toBeDefined();
          }

          // The cited control (or quoted text) is boxed in a cropped, masked screenshot.
          const shot = caught[0]!.screenshot;
          expect(shot, "finding screenshot").toBeDefined();
          expect(existsSync(shot!.path)).toBe(true);
          const png = readFileSync(shot!.path);
          expect(png.subarray(1, 4).toString()).toBe("PNG");
          const width = png.readUInt32BE(16);
          const height = png.readUInt32BE(20);
          expect(shot!.box.x).toBeGreaterThanOrEqual(0);
          expect(shot!.box.x + shot!.box.width).toBeLessThanOrEqual(width);
          expect(shot!.box.y + shot!.box.height).toBeLessThanOrEqual(height);
          expect(width).toBeLessThan(1280); // cropped, not the whole viewport

          // No artifact (report, result, sidecar, screenshots) carries the registered secret.
          for (const file of [result.reportPath!, result.resultPath, result.evidencePath!, shot!.path]) {
            expect(readFileSync(file).toString("latin1").includes(CANARY), file).toBe(false);
          }

          // #134: offline review over the sidecar (guard probes included) reproduces the findings.
          const sidecars = discoverRecordingSidecars(result.recordingPaths[0]!);
          const offline = await runUxReview({
            recording: RecordingSchema.parse(JSON.parse(readFileSync(result.recordingPaths[0]!, "utf8"))),
            appContext: { appClass: "admin" },
            judge,
            gen: new FakeGenerationGateway(),
            judgmentBudget: 10,
            minConfidence: 0,
            product,
            secrets: [CANARY],
            env: {},
            configPath: join(outDir, "no-config.json"),
            outDir: join(outDir, "offline"),
            nowIso: () => "2026-10-01T00:00:01.000Z",
            ...(await loadRecordingSidecars(sidecars)),
          });
          const key = (fs: readonly UxFinding[]) => fs.map((f) => `${f.claim?.type}|${f.route}|${f.observation}`).sort();
          expect(key(offline.report.findings.filter((f) => f.claim !== undefined))).toEqual(key(findings.filter((f) => f.claim !== undefined)));
          expect(offline.report.claims).toMatchObject({ verified: report.claims!.verified, refuted: report.claims!.refuted });
        } finally {
          await rm(outDir, { recursive: true, force: true });
        }
      },
      240_000,
    );
  }
});

async function review(path: string, probeGuards: boolean) {
  const outDir = await mkdtemp(join(tmpdir(), "jev-ux-probe-"));
  try {
    const result = await runUsabilityMission({
      url: `${origin}${path}`,
      job: "look around",
      allowlist: [origin],
      appContext: { appClass: "admin", job: "look around" },
      judge,
      gen: new FakeGenerationGateway(),
      judgmentBudget: 10,
      minConfidence: 0,
      bounds: { maxDecisions: 2 },
      ...(probeGuards ? { probeGuards: true } : {}),
      outDir,
      env: {},
      configPath: join(outDir, "no-config.json"),
      nowIso: () => "2026-10-01T00:00:02.000Z",
    });
    return result.report!;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

describe("#198 guard probe is fail-safe (served, real Chromium)", () => {
  it(
    "default (no --probe-guards): nothing is clicked; the destructive control's guard claim is unverifiable, never asserted",
    async () => {
      writes.length = 0;
      const report = await review("/admin/queue", false);
      expect(writes).toEqual([]);
      expect(report.findings.filter((f) => f.claim?.type === "destructive-unguarded")).toEqual([]);
      const item = report.claims!.items.find((i) => i.target === 'button "Delete user"');
      expect(item).toMatchObject({ status: "unverifiable", reason: expect.stringMatching(/opt-in \(--probe-guards\)/) });
      expect(report.coverage.skipped.map((s) => s.rubricItemId)).toContain("claim:destructive-unguarded");
      expect(report.coverageComplete).toBe(false);
    },
    240_000,
  );

  it(
    "a WebSocket-driven delete button is never probed (refused: the socket's messages cannot be blocked)",
    async () => {
      wsFrames.length = 0;
      writes.length = 0;
      const report = await review("/live", true);
      expect(wsFrames).toEqual([]);
      expect(writes).toEqual([]);
      const item = report.claims!.items.find((i) => i.target === 'button "Delete item"');
      expect(item).toMatchObject({ status: "unverifiable", reason: expect.stringMatching(/WebSocket/) });
      expect(report.findings.filter((f) => f.claim?.type === "destructive-unguarded")).toEqual([]);
    },
    240_000,
  );

  it(
    "a GET /delete?id= link is aborted by the probe: nothing reaches the server, and the unguarded delete is reported",
    async () => {
      seen.length = 0;
      writes.length = 0;
      const report = await review("/files", true);
      expect(seen.filter((p) => p.startsWith("/delete"))).toEqual([]);
      expect(writes).toEqual([]);
      const f = report.findings.find((x) => x.claim?.type === "destructive-unguarded");
      expect(f?.controls).toEqual(['link "Delete file"']);
      expect(f?.observation).toMatch(/GET \/delete/);
    },
    240_000,
  );
});
