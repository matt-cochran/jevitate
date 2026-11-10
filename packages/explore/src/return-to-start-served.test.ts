import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore } from "@jevitate/journey";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { buildProgram } from "../../cli/src/program.js";
import { GOAL_ALREADY_MET_QUESTION, GOAL_MET_QUESTION } from "./decide.js";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #807 — return-to-start, served. The nav lab's three lure cases succeed because a dead end sends the
 * run back to the home page's untried link; the accuracy lab's j3-deadend still ends blocked. The
 * model is scripted (no model call): each case lists the controls it picks, in order, and a `blocked`
 * where a model would give up. A Recording that holds the return step is saved as a Journey and
 * replays through `journey run` with no model.
 */

type Want = RegExp | "blocked";

/** Picks the next scripted want the page offers; a `blocked` want is the model giving up; then done. */
function scripted(wants: readonly Want[], goalMet = 0.95): JudgmentPort {
  let at = 0;
  return {
    async systemOne({ questions }: { questions: Record<string, { kind: string; options?: string[]; descriptions?: Record<string, string> }> }) {
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (key === "action" && q.kind === "choice") {
          const opts = q.options ?? [];
          const want = wants[at];
          let pick: string | undefined;
          if (want === undefined) pick = opts.includes("done") ? "done" : undefined;
          else if (want === "blocked") {
            pick = opts.includes("blocked") ? "blocked" : undefined;
            at += 1;
          } else {
            pick = opts.find((id) => want.test(q.descriptions?.[id] ?? ""));
            if (pick !== undefined) at += 1;
          }
          out[key] = { kind: "choice", value: pick ?? "wait", confidence: 0.9 };
        } else if (key === GOAL_MET_QUESTION) out[key] = { kind: "noul", value: goalMet >= 0.5, probability: goalMet };
        else if (key === GOAL_ALREADY_MET_QUESTION) out[key] = { kind: "noul", value: false, probability: 0.05 };
        else if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
        else out[key] = { kind: "choice", value: q.options?.[0] ?? "", confidence: 0.1 };
      }
      return out;
    },
  } as unknown as JudgmentPort;
}

interface Lab {
  readonly url: string;
  close(): Promise<void>;
}
interface LabState {
  readonly published?: boolean;
  readonly posts: readonly string[];
}

const GOAL = "Publish the Q3 sales report.";
/** Home's first link is the lure; Library > Reports > Q3 sales report > Publish is the route. */
const ROUTE: readonly Want[] = [/Publish Q3 sales report/, "blocked", /Library/, /Reports/, /Q3 sales report/, /Publish/];

async function navLab(caseId: string): Promise<Lab> {
  // @ts-expect-error — a plain .mjs fixture with no declaration file
  const { startNavLab } = (await import("../../../test/fixtures/nav-lab/app.mjs")) as { startNavLab: (o: { caseId: string }) => Promise<Lab> };
  return startNavLab({ caseId });
}

/** The trap page has no control at all, so the model is never asked there: the loop returns on its own. */
const TRAP_ROUTE: readonly Want[] = ROUTE.filter((w) => w !== "blocked");

async function lureRun(caseId: string) {
  const lab = await navLab(caseId);
  try {
    const result = await withSession(
      `rts-${caseId}-`,
      async (session) =>
        runGoalBasedMission({
          actor: CastActor.named("rts").whoCan(new BrowseTheWeb(session, [lab.url])),
          judge: scripted(caseId === "lure-trap-branch" ? TRAP_ROUTE : ROUTE),
          gen: new FakeGenerationGateway(),
          goal: GOAL,
          allowlist: [lab.url],
          startUrl: `${lab.url}/`,
          bounds: { maxDecisions: 14 },
        }),
      lab.url,
    );
    const state = (await (await fetch(`${lab.url}/__lab/state`)).json()) as LabState;
    return { result, state };
  } finally {
    await lab.close();
  }
}

describe("#807 return-to-start — served", () => {
  for (const caseId of ["lure-trap-branch", "lure-one-broken", "lure-dead-end-disabled"]) {
    it(
      `${caseId}: succeeds 2 of 2, by returning to the home page's untried link`,
      async () => {
        for (let i = 0; i < 2; i++) {
          const { result, state } = await lureRun(caseId);
          expect(result.outcome, `${caseId} #${i}: ${result.reason ?? ""}`).toBe("succeeded");
          expect(state.published).toBe(true);
          expect(JSON.stringify(result.recording)).toContain('"navigate"');
        }
      },
      240_000,
    );
  }

  it(
    "j3-deadend (accuracy lab) still ends blocked 2 of 2: the disabled Import is a real defect",
    async () => {
      // @ts-expect-error — a plain .mjs fixture with no declaration file
      const { startAccuracyLab } = (await import("../../../test/fixtures/accuracy-lab/app.mjs")) as {
        startAccuracyLab: (o: { variant: string; port: number }) => Promise<Lab>;
      };
      for (let i = 0; i < 2; i++) {
        const lab = await startAccuracyLab({ variant: "j3-deadend", port: 0 });
        try {
          const result = await withSession(
            "rts-j3-",
            async (session) =>
              runGoalBasedMission({
                actor: CastActor.named("rts").whoCan(new BrowseTheWeb(session, [lab.url])),
                judge: scripted([/Continue/, /Continue/, "blocked"], 0.05),
                gen: new FakeGenerationGateway(),
                goal: "Import the pasted CSV of contacts (name,email), map the columns, complete every confirmation, and confirm the imported rows appear.",
                allowlist: [lab.url],
                startUrl: `${lab.url}/import`,
                bounds: { maxDecisions: 14 },
              }),
            lab.url,
          );
          expect(result.outcome, result.reason ?? "").toBe("blocked");
        } finally {
          await lab.close();
        }
      }
    },
    240_000,
  );
});

describe("#807 return-to-start — the saved Journey", () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  async function cli(journeysDir: string, judge: JudgmentPort, args: string[]) {
    const out: string[] = [];
    const program = buildProgram({
      profiles: new ProfileManager("/unused"),
      journeysDir,
      dbPath: join(dir ?? tmpdir(), "no-site-policy.sqlite"),
      explore: { judge, gen: new FakeGenerationGateway(), browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(dir ?? tmpdir(), "no-targets.json") },
    });
    program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => out.push(s) });
    type Command = ReturnType<typeof buildProgram>;
    const override = (c: Command): void => {
      c.exitOverride();
      c.commands.forEach(override);
    };
    override(program);
    process.exitCode = undefined;
    await program.parseAsync(args, { from: "user" });
    process.exitCode = undefined;
    return out.join("");
  }

  it(
    "a lure run's Recording, with its return step, is a Journey that replays ok through `journey run` with no model",
    async () => {
      dir = await mkdtemp(join(tmpdir(), "jevitate-rts-"));
      const lab = await navLab("lure-trap-branch");
      try {
        const journeysDir = join(dir, "journeys");
        const authored = await cli(journeysDir, scripted(TRAP_ROUTE), [
          "explore-author-journey", "--url", `${lab.url}/`, "--goal", GOAL, "--success", "urlIncludes:/reports/q3",
          "--id", "lure-publish", "--name", "lure-publish", "--fake-ai", "--max-decisions", "14", "--out", join(dir, "runs"), "--json",
        ]);
        const env = JSON.parse(authored) as { data: { outcome: string } };
        expect(env.data.outcome, authored).toBe("authored");
        const journey = await new FsJourneyStore(journeysDir).get("lure-publish");
        const navigations = JSON.stringify(journey).match(/"kind":"navigate"/g) ?? [];
        expect(navigations.length).toBeGreaterThanOrEqual(2); // the start page, and the return to it

        await cli(journeysDir, scripted([]), ["journey", "promote", "lure-publish", "--json", "--non-interactive-approval", "test"]);
        // No --fake-ai / --real: the replay has no AI at all, and the judge below would throw if asked.
        const refusing = { systemOne: async () => { throw new Error("a model was called"); } } as unknown as JudgmentPort;
        const run = await cli(journeysDir, refusing, ["journey", "run", "lure-publish", "--base-url", lab.url, "--json"]);
        expect((JSON.parse(run) as { data: { outcome: string } }).data.outcome, run).toBe("ok");
        expect(run).not.toMatch(/a model was called|"modelCalls":\s*[1-9]/);
      } finally {
        await lab.close();
      }
    },
    240_000,
  );
});
