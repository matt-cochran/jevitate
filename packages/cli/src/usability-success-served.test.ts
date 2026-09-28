import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type JudgmentState } from "@jevitate/ai-core";
import { GOAL_MET_QUESTION } from "@jevitate/explore";
import { parseSuccessSpec } from "./explore-api.js";
import { runUsabilityMission } from "./ux-api.js";

/**
 * #225 — a usability job that saves a bio (the example site's /demo/profile shape).
 *  1. The bio really saved and the page said "Saved", yet `done` was rejected and the review ended
 *     `job-incomplete`: the done-judge never saw the saved value (a field's value is not page text).
 *  2. `--success` was silently ignored for usability. It is now an independent completion check with a
 *     goal run's semantics: it gates the job (a failed check is `defects-found`, a vacuous one
 *     `inconclusive`), and the result carries `goalOutcome` + `checks`.
 * Served page, real Chromium, a deterministic fake judge.
 */

let saved = { displayName: "Ada Lovelace", bio: "" };

const PAGE = (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Profile settings</title></head>
<body><h1>Profile settings</h1>
<form id="profile">
<label>Display name <input name="displayName" aria-label="Display name" value="${saved.displayName}"></label>
<label>Bio <textarea name="bio" aria-label="Bio">${saved.bio}</textarea></label>
<button type="submit">Save</button>
</form>
<p role="status" data-testid="status"></p>
<script>
document.getElementById("profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const res = await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  document.querySelector("[data-testid=status]").textContent = res.ok ? "Saved" : "Please check the form.";
});
</script></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/profile" && req.method === "PUT") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const b = JSON.parse(raw) as { displayName?: string; bio?: string };
        saved = { displayName: b.displayName ?? saved.displayName, bio: b.bio ?? saved.bio };
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }
    if (path === "/profile") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  saved = { displayName: "Ada Lovelace", bio: "" };
});

// Profile: [0] Display name, [1] Bio, [2] Save.
const STEPS = ["type:1", "click:2", "done"];

/**
 * Plays type Bio → click Save → done. The goal question is answered high only when the bio the SERVER
 * saved is visible in what the judge was shown; every other advisory question (the UX rubric, the
 * #225 save-scope head) is answered low — the save must be recognised on what the judge can see.
 */
function savedValueJudge(): JudgmentPort & { goalStates: JudgmentState[] } {
  let i = 0;
  const goalStates: JudgmentState[] = [];
  return {
    goalStates,
    async systemOne({ state, questions }) {
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (key === "action" && q.kind === "choice") {
          const want = STEPS[Math.min(i, STEPS.length - 1)]!;
          i += 1;
          out[key] = { kind: "choice", value: q.options.includes(want) ? want : (q.options[0] ?? ""), confidence: 0.9 };
        } else if (key === GOAL_MET_QUESTION) {
          goalStates.push(state);
          const visible = saved.bio !== "" && JSON.stringify(state).includes(saved.bio.slice(0, 40));
          out[key] = { kind: "noul", value: visible, probability: visible ? 0.9 : 0.42 };
        } else if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
        else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.1 };
      }
      return out;
    },
  };
}

async function review(opts: { success?: string[]; allowVacuousChecks?: boolean } = {}) {
  const outDir = await mkdtemp(join(tmpdir(), "jev-usability-success-"));
  const judge = savedValueJudge();
  try {
    const result = await runUsabilityMission({
      url: `${origin}/profile`,
      job: "Add a short bio to your profile and save it.",
      allowlist: [origin],
      appContext: { appClass: "consumer", job: "Add a short bio to your profile and save it." },
      judge,
      gen: new FakeGenerationGateway(),
      judgmentBudget: 1,
      minConfidence: 0,
      bounds: { maxDecisions: 6 },
      outDir,
      ...(opts.success === undefined ? {} : { successChecks: opts.success.map(parseSuccessSpec) }),
      ...(opts.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
    });
    return { result, judge };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

describe("#225 — a usability save job", () => {
  it(
    "the bio saved and shows in its field: the job ends complete (never job-incomplete)",
    async () => {
      const { result, judge } = await review();
      expect(saved.bio).not.toBe("");
      expect(result.outcome.status).toBe("completed");
      expect(result.failure?.kind).not.toBe("job-incomplete");
      expect(result.missionOutcome).not.toBe("inconclusive");
      expect(JSON.stringify(judge.goalStates.at(-1))).toContain(saved.bio.slice(0, 40));
      // No --success: no goal-run fields.
      expect(result.goalOutcome).toBeUndefined();
      expect(result.checks).toBeUndefined();
    },
    240_000,
  );

  it(
    "--success that holds gates it clean: goalOutcome succeeded, every check passed",
    async () => {
      const { result } = await review({ success: ["requestMade:PUT /api/profile", "textIncludes:[data-testid=status]|Saved"] });
      expect(result.goalOutcome).toBe("succeeded");
      expect(result.checks?.length).toBe(2);
      expect(result.checks?.every((c) => c.passed)).toBe(true);
      expect(result.missionOutcome).toBe("clean");
      expect(result.exitCode).toBe(0);
    },
    240_000,
  );

  it(
    "--success that does not hold gates it: the model's done is not the verdict — defects-found (1), success-check-failed, stopped at once",
    async () => {
      const { result } = await review({ success: ["textIncludes:[data-testid=status]|Profile published"] });
      expect(result.goalOutcome).toBe("failed");
      expect(result.checks?.[0]?.passed).toBe(false);
      expect(result.outcome.status).toBe("incomplete");
      expect(result.missionOutcome).toBe("defects-found");
      expect(result.exitCode).toBe(1);
      expect(result.failure?.kind).toBe("success-check-failed");
      expect(result.failure?.message).toMatch(/Profile published/);
      // The job was judged done (the saved bio is on the page): the run stops there — it never spends
      // the rest of its budget re-proposing `done` against a check that failed.
      expect(result.stop).toBe("done");
      expect(result.actions).toBe(2);
      expect(result.outcome.status === "incomplete" && result.outcome.reason).toMatch(/judged done on this page .*success condition is not met/);
    },
    240_000,
  );

  it(
    "#202 on usability too: a check that held before any action is vacuous — inconclusive, unless allowed",
    async () => {
      const vacuous = ["visible:role=heading;name=Profile settings"];
      const { result } = await review({ success: vacuous });
      expect(result.goalOutcome).toBe("inconclusive");
      expect(result.failure?.kind).toBe("vacuous-check");
      expect(result.checkWarnings?.some((w) => /held at step 0, before any action/.test(w))).toBe(true);

      const allowed = await review({ success: vacuous, allowVacuousChecks: true });
      expect(allowed.result.goalOutcome).toBe("succeeded");
      expect(allowed.result.missionOutcome).toBe("clean");
    },
    240_000,
  );
});
