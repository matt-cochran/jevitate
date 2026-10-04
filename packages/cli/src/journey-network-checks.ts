/**
 * #322 — a Journey's `networkChecks` (authored from `explore-author-journey --success
 * requestMade:…|responseStatus:…`), evaluated over the requests its replay itself sent: the SAME
 * page-monitor capture and evaluator a live goal mission's own network check uses (and a
 * network-check regression replays with). A replay whose steps all passed but whose expected
 * request never went out (or got the wrong status) is a failed run, never `ok`.
 */
import type { Page } from "playwright";
import type { JourneyNetworkCheck } from "@jevitate/journey";
import type { JourneyRunResult } from "@jevitate/runtime";
import { evaluateNetworkCheck, monitorFor } from "@jevitate/explore";

/** How long the network may take to go idle after the last step before the checks read it. */
const SETTLE_CEILING_MS = 5_000;

/**
 * Runs `replay` with the page's requests captured, then evaluates `checks` over them. With no
 * checks it just runs `replay`. A replay that already failed keeps its own reason.
 */
export async function withNetworkChecks(
  page: Page,
  checks: readonly JourneyNetworkCheck[] | undefined,
  replay: () => Promise<JourneyRunResult>,
): Promise<JourneyRunResult> {
  if (checks === undefined || checks.length === 0) return replay();
  const monitor = monitorFor(page);
  await monitor.instrument();
  const capture = monitor.startCapture();
  let result: JourneyRunResult;
  try {
    result = await replay();
    if (result.outcome === "quarantined") return result;
    // A step's postcondition can hold before the write it triggered finished: wait for the network
    // to go idle (bounded) before reading what was sent.
    await monitor.waitSettled({ ceilingMs: SETTLE_CEILING_MS }).catch(() => undefined);
  } finally {
    monitor.stopCapture(capture);
  }
  const failed = checks
    .map((c) => evaluateNetworkCheck(c.kind === "requestMade" ? c : { ...c, status: { ...c.status } }, capture.sent(), capture.truncated))
    .filter((r) => !r.passed);
  if (failed.length === 0) return result;
  return {
    outcome: "quarantined",
    reason: `success check${failed.length === 1 ? "" : "s"} not met after the last step: ${failed.map((r) => `${r.check} — ${r.detail}`).join("; ")}`,
  };
}
