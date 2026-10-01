// ux-claim-probe.ts — the CODE side of the UX claim pipeline (#198), on the live run's browser.
//
// 1. Guard probes: every control the shared safety policy calls DESTRUCTIVE (explore safety.ts's
//    vocabulary — "Delete", "Remove", "Revoke"…) on an analyzed screen is clicked ONCE (per route ×
//    control) on a fresh load of that screen, with EVERY write request blocked at the network layer
//    (non-GET/HEAD/OPTIONS, and any request whose path names a destructive verb). The probe records
//    whether anything guarded the click — a native confirm/alert (dismissed), a DOM dialog
//    (`dialog[open]`, role=dialog/alertdialog, aria-modal), or a navigation to a confirmation page —
//    and which writes the click attempted. Nothing the probe clicks can reach the server: the click
//    is allowed under the safety policy only because its writes are blocked. A `--deny` control is
//    never clicked (recorded `refused`). Limits (docs/ux-findings.md): a WebSocket message or a
//    service-worker request is not blocked; a destructive action that is client-side only (no
//    request) reads as "no write attempted".
// 2. Finding screenshots: each verified claim finding with a cited control or quoted text gets a
//    cropped, secret-masked screenshot (the run's pixel mask, demo-capture.ts) with the cited
//    element boxed.
//
// Both run on a DEDICATED page in the run's own browser context (same session), after the run's
// loop ended — never on the page the run's oracles listen to — and the page's video (if recorded)
// is deleted.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, Route } from "playwright";
import { SafetyPolicy, assertAuthorizedExploreTarget, controlRisk, endpointOf, redactText, redactUrl, type SafetyConfig } from "@jevitate/explore";
import { descriptorToLocator } from "@jevitate/recorder";
import { controlKey, redactEvidence, routeOf, type Control, type FindingScreenshot, type GuardKind, type GuardProbe, type UxEvidence, type UxFinding } from "@jevitate/ux";
import { MaskUnavailableError, SecretPixelMask, captureStepScreenshot } from "./demo-capture.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** A GET whose path names a destructive verb is treated as a write too (a `GET /items/1/delete` link). */
const DESTRUCTIVE_PATH = /(?:^|[/_.-])(?:delete|remove|destroy|erase|purge|wipe|revoke|deactivate|terminate|unsubscribe)(?:$|[/_.?-])/i;
const OPEN_DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const PROBE_TIMEOUT_MS = 8_000;
/** At most this many controls are probed per run; the rest are recorded as not probed (unverifiable). */
export const MAX_GUARD_PROBES = 25;
const SETTLE_MS = 1_500;

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
  // what the probe exists to click — with its writes blocked.
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

function locatorFor(page: Page, c: Control): Locator {
  if (c.descriptor !== undefined) return descriptorToLocator(page, c.descriptor);
  return page.getByRole(c.role as Parameters<Page["getByRole"]>[0], { name: c.name, exact: true });
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);
}

/** Blocks every write (see the module header); records each blocked one, in order. */
function writeBlocker(secrets: readonly string[], seq: { n: number }) {
  const blocked: { at: number; endpoint: string }[] = [];
  const handler = async (route: Route): Promise<void> => {
    const req = route.request();
    const method = req.method().toUpperCase();
    let path = "";
    try {
      path = new URL(req.url()).pathname;
    } catch {
      path = "";
    }
    if (SAFE_METHODS.has(method) && !DESTRUCTIVE_PATH.test(path)) {
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

/** Probes each target on `page` (a dedicated page in the run's context). Never throws per target. */
export async function runGuardProbes(page: Page, targets: readonly ProbeTarget[], opts: { readonly allowlist: readonly string[]; readonly secrets: readonly string[] }): Promise<GuardProbe[]> {
  const out: GuardProbe[] = [];
  for (const [i, t] of targets.entries()) {
    const base = { screenId: t.screen.screenId, route: t.route, control: t.label, controlKey: t.key };
    if (i >= MAX_GUARD_PROBES) {
      out.push({ ...base, status: "failed", detail: `not probed: the run's probe cap (${MAX_GUARD_PROBES} controls) was reached` });
      continue;
    }
    const seq = { n: 0 };
    const { blocked, handler } = writeBlocker(opts.secrets, seq);
    const dialogs: { at: number; type: string }[] = [];
    const onDialog = (d: { type(): string; dismiss(): Promise<void> }): void => {
      dialogs.push({ at: seq.n++, type: d.type() });
      void d.dismiss().catch(() => undefined);
    };
    try {
      assertAuthorizedExploreTarget(t.screen.url, opts.allowlist);
      await page.route("**/*", handler);
      page.on("dialog", onDialog);
      await page.goto(t.screen.url, { waitUntil: "domcontentloaded", timeout: PROBE_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
      const loc = locatorFor(page, t.control).first();
      if (!(await loc.isVisible().catch(() => false))) {
        out.push({ ...base, status: "not-found", detail: "the control was not visible on a fresh load of its screen (it may need state the run built up)" });
        continue;
      }
      const before = await openDialogs(page);
      // Anything the page load itself sent is not the click's.
      blocked.length = 0;
      dialogs.length = 0;
      const startUrl = page.url().split("#")[0];
      await loc.click({ timeout: 3_000 });
      for (let waited = 0; waited < SETTLE_MS && blocked.length === 0 && dialogs.length === 0; waited += 100) await page.waitForTimeout(100);
      await page.waitForTimeout(150);
      const domDialog = (await openDialogs(page)) > before;
      const navigated = page.url().split("#")[0] !== startUrl;
      const firstWrite = blocked[0]?.at ?? Number.POSITIVE_INFINITY;
      const firstDialog = dialogs[0]?.at ?? Number.POSITIVE_INFINITY;
      // A write attempted before any native dialog was NOT guarded by it (a confirm blocks the write
      // until answered; the probe dismisses it, so a guarded action never writes).
      const guard: GuardKind =
        blocked.length > 0 && firstWrite < firstDialog ? "none" : dialogs.length > 0 ? "native-dialog" : domDialog ? "dom-dialog" : navigated && blocked.length === 0 ? "navigation" : "none";
      const writes = [...new Set(blocked.map((b) => b.endpoint))];
      out.push({
        ...base,
        status: "probed",
        guard,
        blockedWrites: writes,
        detail:
          guard === "none"
            ? writes.length > 0
              ? `no guard: the click attempted ${writes.join(", ")} (blocked by the probe)`
              : "no guard and no write attempted"
            : `guarded by ${guard === "native-dialog" ? `a native ${dialogs[0]?.type ?? "dialog"} (dismissed)` : guard === "dom-dialog" ? "a dialog on the page" : "a navigation to another page"}`,
      });
    } catch (e) {
      out.push({ ...base, status: "failed", detail: redactText(`the probe could not click it: ${errText(e)}`, opts.secrets) });
    } finally {
      page.off("dialog", onDialog);
      await page.unroute("**/*", handler).catch(() => undefined);
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
  const { handler } = writeBlocker(opts.secrets, seq);
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
        await page.goto(screen.url, { waitUntil: "domcontentloaded", timeout: PROBE_TIMEOUT_MS });
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
