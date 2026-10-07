import type { Assertion } from "@jevitate/recording";
import { checkAssertion, readAssertionEvidence, readAssertionText } from "@jevitate/interpreter";
import type { Actor } from "@jevitate/screenplay";
import type { Page } from "playwright";
import { reloadPage } from "./act.js";
import { monitorFor, type CapturedRequest, type RequestCapture } from "./page-monitor.js";
import { redactText } from "./redact.js";
import { describeCheck, evaluateNetworkCheck, type SuccessCheck, type SuccessCheckResult } from "./success-checks.js";

/** How long the oracle lets the network settle before it reads requests or reloads (ms). */
export const DEFAULT_ORACLE_SETTLE_MS = 10_000;

/** Bound on the text quoted into a failed check's detail (#113): enough to see the mismatch, never a page dump. */
export const READ_TEXT_MAX_CHARS = 200;

function quoteRead(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return `"${flat.length > READ_TEXT_MAX_CHARS ? `${flat.slice(0, READ_TEXT_MAX_CHARS)}…` : flat}"`;
}

/**
 * #335: an exact `text=` target that matched no element while some element CONTAINS that text —
 * the usual reason a visible text "did not hold" (`text=` compares an element's whole text). Says
 * so, with the substring form to use. Empty for any other target or failure.
 */
async function exactTextHint(page: Page, assertion: Assertion): Promise<string> {
  const target = "target" in assertion ? assertion.target : undefined;
  if (target === undefined || target.text === undefined || target.textMatch === "contains" || target.testId !== undefined || (target.role !== undefined && target.name !== undefined) || target.label !== undefined) return "";
  const exact = await page.getByText(target.text, { exact: true }).count().catch(() => -1);
  if (exact !== 0) return "";
  const containing = await page.getByText(target.text).count().catch(() => 0);
  if (containing === 0) return "";
  return ` (no element's whole text is exactly ${JSON.stringify(target.text)} — text= matches an element's whole text — but ${containing} element(s) contain it: use textContains=${target.text})`;
}

type NetworkSuccessCheck = Extract<SuccessCheck, { kind: "requestMade" | "responseStatus" }>;

/** What `evaluateOutcomeChecks` reads and how. */
export interface OutcomeCheckContext {
  readonly actor: Actor;
  readonly page: Page;
  /** The requests to judge network checks over (read AFTER the settle); null: none were captured. */
  readonly capture: RequestCapture | null;
  /** Registered secrets: what a failed check quotes from the page is redacted of them. */
  readonly secrets?: readonly string[];
  /** Poll bound for each page assertion (ms). Default 3000. */
  readonly timeoutMs?: number;
  /** Bound on the network settle before reading requests / after the reload (ms). */
  readonly settleMs?: number;
  /** Judges one network check (default: `evaluateNetworkCheck` over every captured request). */
  readonly judgeNetwork?: (check: NetworkSuccessCheck, requests: readonly CapturedRequest[], truncated: boolean) => SuccessCheckResult;
}

/**
 * The success oracle (#65), shared by the goal mission's verdict and a Journey replay's end state
 * (#400) — one evaluator, never two. In order: let the page settle (a save still in flight lands
 * first), read the captured requests, check the page, then reload ONCE and check what persisted
 * (`reloadThen`). Network checks use the requests from BEFORE the oracle's own reload. Results keep
 * the order the checks were given in.
 */
export async function evaluateOutcomeChecks(checks: readonly SuccessCheck[], ctx: OutcomeCheckContext): Promise<SuccessCheckResult[]> {
  const { actor, page, capture } = ctx;
  const secrets = ctx.secrets ?? [];
  const timeoutMs = ctx.timeoutMs ?? 3000;
  const ceilingMs = ctx.settleMs ?? DEFAULT_ORACLE_SETTLE_MS;
  const judgeNetwork = ctx.judgeNetwork ?? ((c, requests, truncated) => evaluateNetworkCheck(c, requests, truncated));
  const results = new Map<number, SuccessCheckResult>();
  const needsSettle = checks.some((c) => c.kind !== "page");
  if (needsSettle) await monitorFor(page).waitSettled({ ceilingMs });
  const requests = capture?.sent() ?? [];

  const assertOn = async (assertion: Assertion, when: string, check: SuccessCheck): Promise<SuccessCheckResult> => {
    const passed = await checkAssertion(actor, assertion, { timeoutMs });
    // A visual-state check (#148) always says what it observed — the ratio, the computed values, the
    // flash timing — pass or fail (bounded, redacted: it is page-derived).
    const evidence = await readAssertionEvidence(actor, assertion).catch(() => null);
    if (evidence !== null) {
      const seen = redactText(evidence, secrets).slice(0, READ_TEXT_MAX_CHARS);
      return { check: describeCheck(check), passed, detail: `${passed ? "held" : "did not hold"} ${when} (${seen})` };
    }
    if (passed) return { check: describeCheck(check), passed, detail: `held ${when}` };
    // #113/#213 — a `textIncludes` or `valueEquals` mismatch (including a failing
    // `reloadThen:valueEquals`) is otherwise invisible ("did not hold" alone doesn't say whether the
    // text/value is wrong or just differently cased). What was actually read, bounded and redacted
    // (page text or a form value is untrusted, and may carry a secret) — never a full-page dump.
    const read = await readAssertionText(actor, assertion);
    const detail =
      read === null
        ? `did not hold ${when}${await exactTextHint(page, assertion)}`
        : `did not hold ${when} (read: ${quoteRead(redactText(read, secrets))})`;
    return { check: describeCheck(check), passed, detail };
  };

  for (const [i, c] of checks.entries()) {
    if (c.kind === "page") results.set(i, await assertOn(c.assertion, "on the final page", c));
  }
  const reloads = [...checks.entries()].filter(([, c]) => c.kind === "reloadThen");
  if (reloads.length > 0) {
    // Persistence: what the page shows after a reload came from the server, not local UI state.
    const reloaded = await reloadPage(page);
    if (reloaded.ok) {
      await page.waitForLoadState("domcontentloaded", { timeout: ceilingMs }).catch(() => undefined);
      await monitorFor(page).waitSettled({ ceilingMs });
    }
    for (const [i, c] of reloads) {
      if (c.kind !== "reloadThen") continue;
      results.set(
        i,
        reloaded.ok
          ? await assertOn(c.assertion, "after a reload", c)
          : { check: describeCheck(c), passed: false, detail: `the page could not be reloaded: ${reloaded.reason ?? "unknown"}` },
      );
    }
  }
  for (const [i, c] of checks.entries()) {
    if (c.kind === "requestMade" || c.kind === "responseStatus") results.set(i, judgeNetwork(c, requests, capture?.truncated ?? false));
  }
  return checks.map((c, i) => results.get(i) ?? { check: describeCheck(c), passed: false, detail: "not evaluated" });
}
