// ux-claim-probe.ts — the CODE side of the UX claim pipeline (#198), on the live run's browser.
//
// 1. Guard probes — OPT-IN (`--probe-guards`). Without it nothing is clicked: every destructive
//    control is recorded `skipped`, so its guard claim is reported unverifiable (coverage), never
//    asserted and never silently dropped. With it, every control the shared safety policy calls
//    DESTRUCTIVE (explore safety.ts's vocabulary) on an analyzed screen is clicked ONCE (per route ×
//    control), each on a FRESH page in the run's context, fail-safe:
//      - refused (→ unverifiable, reason recorded) when the page has an open WebSocket or
//        EventSource, or a service worker controls it — writes over those cannot be blocked;
//      - new WebSocket/EventSource connections are refused by the page once the probe is armed;
//      - every request is aborted that is not GET/HEAD/OPTIONS, or whose URL (path or query) or body
//        names a destructive verb (delete, remove, destroy, revoke, purge, archive… — also as an RPC
//        name such as `DeleteUser`), whatever its method;
//      - the page is closed as soon as a confirm/alert or a page dialog is observed: the probe never
//        clicks anything inside a dialog (a native dialog is dismissed — cancel — then the page closes).
//    It records whether a dialog or confirmation page guarded the click and which writes it
//    attempted. A `--deny` control is never clicked (recorded `refused`).
// 2. Finding screenshots: each verified claim finding with a cited control or quoted text gets a
//    cropped, secret-masked screenshot (the run's pixel mask, demo-capture.ts) with the cited
//    element boxed (no click; the same request blocker is active).
//
// Both run on DEDICATED pages in the run's own browser context (same session), after the run's
// loop ended — never on the page the run's oracles listen to — and a probe page's video (if
// recorded) is deleted.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, Route } from "playwright";
import { SafetyPolicy, assertAuthorizedExploreTarget, controlRisk, endpointOf, looksDestructiveRequest, redactText, redactUrl, type SafetyConfig } from "@jevitate/explore";
import { descriptorToLocator } from "@jevitate/recorder";
import { controlKey, redactEvidence, routeOf, type Control, type FindingScreenshot, type GuardKind, type GuardProbe, type UxEvidence, type UxFinding } from "@jevitate/ux";
import { MaskUnavailableError, SecretPixelMask, captureStepScreenshot } from "./demo-capture.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const OPEN_DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const PROBE_TIMEOUT_MS = 8_000;
/** At most this many controls are probed per run; the rest are recorded as not probed (unverifiable). */
export const MAX_GUARD_PROBES = 25;
const SETTLE_MS = 1_500;
/** Why nothing was clicked without the opt-in. */
export const PROBE_OPT_IN_REASON = "not probed: clicking destructive controls is opt-in (--probe-guards)";

/** The fail-safe destructive-request classifier, shared with the find-out guard (#270): one vocabulary. */
export function looksDestructive(url: string, body: string | null = null, method = "GET"): boolean {
  return looksDestructiveRequest(method, url, body);
}

export interface ProbeTarget {
  readonly screen: UxEvidence;
  readonly control: Control;
  /** Redacted `role "name"`. */
  readonly label: string;
  /** controlKey over the REDACTED role/name (what the claim pipeline matches on). */
  readonly key: string;
  readonly route: string;
}

/** The destructive controls to probe (one per route × control) and the ones a `--deny` pattern refuses. */
export function planGuardProbes(
  screens: readonly UxEvidence[],
  secrets: readonly string[],
  safety?: SafetyConfig,
): { readonly targets: ProbeTarget[]; readonly refused: GuardProbe[] } {
  // Only the operator's --deny patterns refuse here: the built-in destructive category is exactly
  // what the (opted-in) probe exists to click — fail-safe, its writes blocked.
  const deny = new SafetyPolicy({ deny: safety?.deny ?? [], allowDestructive: true });
  const seen = new Set<string>();
  const targets: ProbeTarget[] = [];
  const refused: GuardProbe[] = [];
  for (const screen of screens) {
    const red = redactEvidence(screen, secrets);
    const route = routeOf(red.url);
    screen.controls.forEach((c, i) => {
      if (controlRisk(c.name, c.role)?.risk !== "destructive") return;
      const rc = red.controls[i]!;
      const key = controlKey(rc);
      if (seen.has(`${route}|${key}`)) return;
      seen.add(`${route}|${key}`);
      const label = `${rc.role || "control"} "${rc.name}"`;
      const verdict = deny.refuses({ name: c.name, role: c.role, descriptor: c.descriptor ?? {} });
      if (verdict !== null) {
        refused.push({ screenId: screen.screenId, route, control: label, controlKey: key, status: "refused", detail: verdict.reason });
        return;
      }
      targets.push({ screen, control: c, label, key, route });
    });
  }
  return { targets, refused };
}

/** The opt-out record: every planned target is `skipped` (its guard claim: unverifiable). */
export function skippedProbes(targets: readonly ProbeTarget[]): GuardProbe[] {
  return targets.map((t) => ({ screenId: t.screen.screenId, route: t.route, control: t.label, controlKey: t.key, status: "skipped", detail: PROBE_OPT_IN_REASON }));
}

function locatorFor(page: Page, c: Control): Locator {
  if (c.descriptor !== undefined) return descriptorToLocator(page, c.descriptor);
  return page.getByRole(c.role as Parameters<Page["getByRole"]>[0], { name: c.name, exact: true });
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);
}

/**
 * Aborts every write and every destructive-looking request (see `looksDestructive`); records each
 * one, in order. `allowDocument` is the screen's own URL: its load is let through.
 */
function writeBlocker(secrets: readonly string[], seq: { n: number }, allowDocument?: () => string | undefined) {
  const blocked: { at: number; endpoint: string }[] = [];
  const handler = async (route: Route): Promise<void> => {
    const req = route.request();
    const method = req.method().toUpperCase();
    let body: string | null = null;
    try {
      body = req.postData();
    } catch {
      body = null;
    }
    const own = allowDocument?.() !== undefined && req.isNavigationRequest() && req.url() === allowDocument();
    if (own || (SAFE_METHODS.has(method) && !looksDestructive(req.url(), body, method))) {
      await route.continue().catch(() => undefined);
      return;
    }
    blocked.push({ at: seq.n++, endpoint: redactText(redactUrl(endpointOf(method, req.url())), secrets) });
    await route.abort("blockedbyclient").catch(() => undefined);
  };
  return { blocked, handler };
}

async function openDialogs(page: Page): Promise<number> {
  return page
    .evaluate((sel) => Array.from(document.querySelectorAll(sel)).filter((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    }).length, OPEN_DIALOGS)
    .catch(() => 0);
}

/**
 * BROWSER (init script on a probe page): counts WebSocket/EventSource connections the page opens,
 * and refuses new ones once `window.__jevProbeArmed` is set (just before the click).
 */
const CONNECTION_GUARD = `(() => {
  const w = window;
  w.__jevProbeConnections = 0;
  for (const name of ["WebSocket", "EventSource"]) {
    const Orig = w[name];
    if (typeof Orig !== "function") continue;
    const Wrapped = function (...args) {
      if (w.__jevProbeArmed) throw new Error("jevitate guard probe: " + name + " refused while probing");
      w.__jevProbeConnections += 1;
      return new Orig(...args);
    };
    Wrapped.prototype = Orig.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) if (k in Orig) Object.defineProperty(Wrapped, k, { value: Orig[k] });
    w[name] = Wrapped;
  }
})();`;

/** Why the page cannot be probed safely (a channel whose writes the probe cannot block), or null. */
async function unsafeChannel(page: Page, sockets: number): Promise<string | null> {
  const state = await page
    .evaluate(() => {
      const w = window as unknown as { __jevProbeConnections?: number };
      return { connections: w.__jevProbeConnections ?? 0, sw: typeof navigator.serviceWorker !== "undefined" && navigator.serviceWorker.controller !== null };
    })
    .catch(() => null);
  if (state === null) return "the page's connections could not be inspected";
  if (sockets > 0) return "the page has an open WebSocket (its messages cannot be blocked)";
  if (state.connections > 0) return "the page opened a WebSocket or EventSource (its messages cannot be blocked)";
  if (state.sw) return "a service worker controls the page (its requests cannot be blocked)";
  return null;
}

/** Opens a fresh probe page in `runPage`'s context; `close()` closes it and deletes its video. */
async function openProbePage(runPage: Page): Promise<{ page: Page; close: () => Promise<void> }> {
  const page = await runPage.context().newPage();
  let closed = false;
  return {
    page,
    close: async () => {
      if (closed) return;
      closed = true;
      const video = page.video();
      await page.close().catch(() => undefined);
      await video?.delete().catch(() => undefined);
    },
  };
}

/**
 * Probes each target, each on a fresh page in `runPage`'s context (call only with the opt-in).
 * Never throws per target; a target that cannot be probed safely is `refused`/`failed`.
 */
export async function runGuardProbes(runPage: Page, targets: readonly ProbeTarget[], opts: { readonly allowlist: readonly string[]; readonly secrets: readonly string[] }): Promise<GuardProbe[]> {
  const out: GuardProbe[] = [];
  for (const [i, t] of targets.entries()) {
    const base = { screenId: t.screen.screenId, route: t.route, control: t.label, controlKey: t.key };
    if (i >= MAX_GUARD_PROBES) {
      out.push({ ...base, status: "failed", detail: `not probed: the run's probe cap (${MAX_GUARD_PROBES} controls) was reached` });
      continue;
    }
    let probe: { page: Page; close: () => Promise<void> } | undefined;
    try {
      assertAuthorizedExploreTarget(t.screen.url, opts.allowlist);
      probe = await openProbePage(runPage);
      const page = probe.page;
      const seq = { n: 0 };
      let screenUrl: string | undefined = t.screen.url;
      const { blocked, handler } = writeBlocker(opts.secrets, seq, () => screenUrl);
      const dialogs: { at: number; type: string }[] = [];
      let sockets = 0;
      page.on("websocket", () => {
        sockets += 1;
      });
      page.on("dialog", (d) => {
        dialogs.push({ at: seq.n++, type: d.type() });
        // Cancel — never accept: the probe never confirms anything. The page is closed right after.
        void d.dismiss().catch(() => undefined);
      });
      await page.addInitScript({ content: CONNECTION_GUARD });
      await page.route("**/*", handler);
      await page.goto(t.screen.url, { waitUntil: "domcontentloaded", timeout: PROBE_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
      screenUrl = undefined; // from here on, even a reload of the screen goes through the blocker
      const loc = locatorFor(page, t.control).first();
      if (!(await loc.isVisible().catch(() => false))) {
        out.push({ ...base, status: "not-found", detail: "the control was not visible on a fresh load of its screen (it may need state the run built up)" });
        continue;
      }
      const unsafe = await unsafeChannel(page, sockets);
      if (unsafe !== null) {
        out.push({ ...base, status: "refused", detail: `not probed: ${unsafe}` });
        continue;
      }
      await page.evaluate(() => {
        (window as unknown as { __jevProbeArmed?: boolean }).__jevProbeArmed = true;
      });
      const before = await openDialogs(page);
      // Anything the page load itself sent is not the click's.
      blocked.length = 0;
      dialogs.length = 0;
      const startUrl = page.url().split("#")[0];
      await loc.click({ timeout: 3_000 });
      let domDialog = false;
      for (let waited = 0; waited < SETTLE_MS && blocked.length === 0 && dialogs.length === 0 && !domDialog; waited += 100) {
        await page.waitForTimeout(100);
        domDialog = (await openDialogs(page)) > before;
      }
      // A dialog was observed: stop here — the page closes without anything inside it being clicked.
      const sawDialog = dialogs.length > 0 || domDialog;
      if (!sawDialog) {
        await page.waitForTimeout(150);
        domDialog = (await openDialogs(page)) > before;
      }
      const navigated = !page.isClosed() && page.url().split("#")[0] !== startUrl;
      const lateSocket = sockets > 0;
      await probe.close();
      const firstWrite = blocked[0]?.at ?? Number.POSITIVE_INFINITY;
      const firstDialog = dialogs[0]?.at ?? Number.POSITIVE_INFINITY;
      // A write attempted before any native dialog was NOT guarded by it (a confirm blocks the write
      // until answered; the probe cancels it, so a guarded action never writes).
      const guard: GuardKind =
        blocked.length > 0 && firstWrite < firstDialog ? "none" : dialogs.length > 0 ? "native-dialog" : domDialog ? "dom-dialog" : navigated && blocked.length === 0 ? "navigation" : "none";
      if (lateSocket && guard === "none") {
        out.push({ ...base, status: "refused", detail: "not judged: the click opened a WebSocket (its messages cannot be blocked)" });
        continue;
      }
      const writes = [...new Set(blocked.map((b) => b.endpoint))];
      out.push({
        ...base,
        status: "probed",
        guard,
        blockedWrites: writes,
        detail:
          guard === "none"
            ? writes.length > 0
              ? `no guard: the click attempted ${writes.join(", ")} (aborted by the probe)`
              : "no guard and no write attempted"
            : `guarded by ${guard === "native-dialog" ? `a native ${dialogs[0]?.type ?? "dialog"} (cancelled)` : guard === "dom-dialog" ? "a dialog on the page (left unanswered)" : "a navigation to another page"}`,
      });
    } catch (e) {
      out.push({ ...base, status: "failed", detail: redactText(`the probe could not click it: ${errText(e)}`, opts.secrets) });
    } finally {
      await probe?.close();
    }
  }
  return out;
}

const PAD = 48;
const QUOTE_ATTR = "data-jevitate-quote";

/** BROWSER: wraps the first text-node occurrence of `q` under `el` in an inline marker span. */
function wrapQuote(el: Element, q: string): boolean {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const at = (n.nodeValue ?? "").indexOf(q);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(n, at);
    range.setEnd(n, at + q.length);
    const span = document.createElement("span");
    span.setAttribute("data-jevitate-quote", "");
    range.surroundContents(span);
    return true;
  }
  return false;
}

/**
 * Cropped, masked, boxed screenshots for the verified claim findings (`finding.screenshot`). Best
 * effort per finding: one that cannot be located or masked has none. Fails CLOSED on masking: if
 * the pixel mask cannot be installed or proven, no screenshot is written.
 */
export async function captureFindingShots(
  page: Page,
  findings: readonly UxFinding[],
  screens: ReadonlyMap<string, UxEvidence>,
  opts: { readonly dir: string; readonly allowlist: readonly string[]; readonly secrets: readonly string[] },
): Promise<UxFinding[]> {
  const mask = new SecretPixelMask(opts.secrets);
  try {
    await mask.install(page);
  } catch (e) {
    if (e instanceof MaskUnavailableError) return [...findings];
    throw e;
  }
  const seq = { n: 0 };
  let current: string | undefined;
  const { handler } = writeBlocker(opts.secrets, seq, () => current);
  await page.route("**/*", handler);
  const out: UxFinding[] = [];
  let n = 0;
  try {
    for (const f of findings) {
      const screen = screens.get(f.screenId);
      if (f.claim === undefined || screen === undefined) {
        out.push(f);
        continue;
      }
      const ref = f.evidenceRefs.find((r) => r.id.startsWith("control:"));
      const control = ref === undefined ? undefined : screen.controls.find((c) => `control:${c.index}` === ref.id);
      const quote = f.quotes[0];
      if (control === undefined && quote === undefined) {
        out.push(f);
        continue;
      }
      try {
        assertAuthorizedExploreTarget(screen.url, opts.allowlist);
        current = screen.url;
        await page.goto(screen.url, { waitUntil: "domcontentloaded", timeout: PROBE_TIMEOUT_MS });
        current = undefined;
        await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
        let loc = (control !== undefined ? locatorFor(page, control) : page.getByText(quote!.slice(0, 120), { exact: false })).first();
        if (!(await loc.isVisible().catch(() => false))) {
          out.push(f);
          continue;
        }
        // A quote is boxed tightly: its text is wrapped in an inline marker on this throwaway page
        // (a block element's box would span the page). Falls back to the element.
        if (control === undefined && (await loc.evaluate(wrapQuote, quote!.slice(0, 120)).catch(() => false))) {
          loc = page.locator(`[${QUOTE_ATTR}]`).first();
        }
        await loc.scrollIntoViewIfNeeded({ timeout: 2_000 });
        const bb = await loc.boundingBox();
        const vp = page.viewportSize() ?? { width: 1280, height: 720 };
        if (bb === null) {
          out.push(f);
          continue;
        }
        const x = Math.max(0, Math.floor(bb.x - PAD));
        const y = Math.max(0, Math.floor(bb.y - PAD));
        const clip = { x, y, width: Math.max(1, Math.min(vp.width - x, Math.ceil(bb.width + 2 * PAD))), height: Math.max(1, Math.min(vp.height - y, Math.ceil(bb.height + 2 * PAD))) };
        await mask.highlightLocator(page, loc);
        await mkdir(opts.dir, { recursive: true });
        n += 1;
        const path = join(opts.dir, `finding-${n}.png`);
        await captureStepScreenshot(page, path, { step: 0 }, [mask.layer()], clip);
        await mask.clearHighlight(page);
        const target = f.claim.target ?? (control !== undefined ? f.controls[0] ?? control.name : `text ${JSON.stringify(quote!.slice(0, 80))}`);
        const screenshot: FindingScreenshot = { path, target, box: { x: Math.round(bb.x - x), y: Math.round(bb.y - y), width: Math.round(bb.width), height: Math.round(bb.height) } };
        out.push(Object.freeze({ ...f, screenshot }));
      } catch {
        out.push(f); // presentation only: a finding without a screenshot is still the finding
      }
    }
  } finally {
    await page.unroute("**/*", handler).catch(() => undefined);
  }
  return out;
}

/** Opens the dedicated probe page in the run's context; closing it deletes its video, if any. */
export async function withProbePage<T>(runPage: Page, fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await runPage.context().newPage();
  try {
    return await fn(page);
  } finally {
    const video = page.video();
    await page.close().catch(() => undefined);
    await video?.delete().catch(() => undefined);
  }
}
