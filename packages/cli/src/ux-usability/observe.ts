// ux-usability/observe.ts — the usability act loop's per-screen observation hook (#500).
import { type ExploreConfig, clippingSummary, detectClipping, detectOverflow, shouldCheckOverflow } from "@jevitate/explore";
import { makeSignalFinding } from "@jevitate/ux";
import { snapshotToEvidence } from "../ux-evidence.js";
import type { UsabilitySetup } from "./setup.js";

/**
 * Phase 2a — the act loop's `onSnapshot` hook: one screen's evidence per observation, its
 * (secret-masked) screenshot and the overflow/clipping hard signals. Never gates the loop.
 */
export function usabilityOnSnapshot(ctx: UsabilitySetup): NonNullable<ExploreConfig["onSnapshot"]> {
  const { opts, extract, session, collected, history, capture, seenOverflow, overflowFindings, secrets } = ctx;
  return async (snap) => {
    let visibleText = "";
    try {
      visibleText = await extract(session as never);
    } catch {
      visibleText = ""; // best-effort; the analyzer Skips visibleText items honestly
    }
    const ev = snapshotToEvidence(snap, visibleText, opts.appContext, opts.job, [...history]);
    collected.push(ev);
    history.push({ screenId: ev.screenId, url: ev.url });
    // #98 the step's (secret-masked) screenshot; #96 the screen's facts for the signal oracles.
    await capture.observe(snap, visibleText);
    // #149: horizontal-overflow hard signal — pure DOM geometry, never a model judgment.
    // Best-effort like visibleText extraction above: a detection failure never fails the mission.
    try {
      const vp = session.page.viewportSize();
      if (shouldCheckOverflow(vp?.width, opts.overflow?.checkOverflow ?? false)) {
        const overflow = await detectOverflow(session.page, {
          viewport: vp ?? { width: 1280, height: 720 },
          ...(opts.emulation?.device === undefined ? {} : { device: opts.emulation.device }),
          ...(opts.overflow?.toleranceCss === undefined ? {} : { toleranceCss: opts.overflow.toleranceCss }),
          ...(opts.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: opts.overflow.ignoreSelectors }),
          secrets,
        });
        if (overflow !== null && !seenOverflow.has(overflow.fingerprint)) {
          seenOverflow.add(overflow.fingerprint);
          overflowFindings.push(
            makeSignalFinding({
              kind: "horizontal-overflow",
              confidence: 0.9,
              url: ev.url,
              screenId: ev.screenId,
              observation: `${overflow.element.descriptor} overflows the ${overflow.viewport.width}px viewport by ${overflow.overflowPx}px on ${overflow.route}.`,
              userImpact:
                "Content extends past the visible viewport; a user on this device must discover and use horizontal scrolling to see it, and may miss it entirely.",
              recommendation: `Constrain ${overflow.element.descriptor} to the viewport width (e.g. a responsive layout, or an explicit scroll container) at ${overflow.viewport.width}px.`,
              controls: [overflow.element.descriptor],
              evidence: {
                kind: "horizontal-overflow",
                steps: [history.length],
                requests: [],
                detail: `scrollWidth exceeds innerWidth by ${overflow.overflowPx}px at a ${overflow.viewport.width}x${overflow.viewport.height} viewport`,
              },
            }),
          );
        }
        // #302: text cut off vertically (a fixed-height box, or above the page top) — one finding per element.
        const clipped = await detectClipping(session.page, {
          viewport: vp ?? { width: 1280, height: 720 },
          ...(opts.emulation?.device === undefined ? {} : { device: opts.emulation.device }),
          ...(opts.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: opts.overflow.ignoreSelectors }),
          secrets,
        });
        for (const c of clipped) {
          if (seenOverflow.has(c.fingerprint)) continue;
          seenOverflow.add(c.fingerprint);
          overflowFindings.push(
            makeSignalFinding({
              kind: "vertical-clipping",
              confidence: 0.9,
              url: ev.url,
              screenId: ev.screenId,
              observation:
                c.cause === "overflow-hidden"
                  ? `${c.element.descriptor} cuts off its text by ${c.clippedPx}px on ${c.route}: the content is taller than the box and overflow is hidden.`
                  : `${c.element.descriptor} is cut off ${c.clippedPx}px above the top of the page on ${c.route}.`,
              userImpact: "Part of the text is cut off and no scroll position shows it: a user on this device cannot read it.",
              recommendation:
                c.cause === "overflow-hidden"
                  ? `Let ${c.element.descriptor} grow with its content (min-height instead of height), make it scrollable, or truncate on purpose with line-clamp at ${c.viewport.width}px.`
                  : `Give the container of ${c.element.descriptor} room for its wrapped content (no fixed height, or no wrapping) at ${c.viewport.width}px.`,
              controls: [c.element.descriptor],
              evidence: { kind: "vertical-clipping", steps: [history.length], requests: [], detail: clippingSummary(c) },
            }),
          );
        }
      }
    } catch {
      // Best-effort: the run's own explore loop is never held up or failed by this check.
    }
  };
}
