import type { Page } from "playwright";

/**
 * The page's STATUS TEXT — what a user reads to learn why nothing happened, which is not a control
 * and so never reaches the model through the control table (#79):
 *
 *  - visible live-region text: `role=alert`, `role=status`, `aria-live` (polite/assertive), `<output>`;
 *  - invalid form fields with their message: `aria-invalid=true` (the message is the field's
 *    `aria-errormessage` / `aria-describedby` text when the browser has none), or a native
 *    constraint failure (`validationMessage`) that the user can see was reached — the browser
 *    refused a submit over it (an `invalid` event fired), or the field holds text.
 *
 * Values are never read: only messages and labels. Everything here is untrusted page text, redacted
 * by the model-facing seams like every other page string.
 */
export interface InvalidField {
  /** The field's accessible-name approximation (aria-label → label → placeholder → name attr). */
  readonly name: string;
  readonly message: string;
}

export interface PageStatus {
  /** `role=alert` / `aria-live=assertive` text — what the app flags as a problem. */
  readonly alerts: readonly string[];
  /** `role=status` / `aria-live=polite` / `<output>` text — notices ("Saved", "3 results"). */
  readonly notices: readonly string[];
  readonly invalid: readonly InvalidField[];
}

export const EMPTY_STATUS: PageStatus = { alerts: [], notices: [], invalid: [] };

/** Cap on each status string (a live region can hold a whole transcript). */
const STATUS_CHARS = 200;
/** Cap on how many alerts / invalid fields are kept. */
const STATUS_ITEMS = 5;

/** BROWSER CODE — serialized by `page.evaluate`: no imports, no closure over module scope. */
function readStatusInPage(limits: { chars: number; items: number }): PageStatus {
  const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const cut = (s: string): string => (s.length > limits.chars ? `${s.slice(0, limits.chars)}…` : s);
  const shown = (el: Element): boolean => {
    const h = el as HTMLElement;
    if (h.closest("[hidden],[aria-hidden=true]") !== null) return false;
    const st = window.getComputedStyle(h);
    const r = h.getBoundingClientRect();
    return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };

  // Which fields the browser refused a submit over: recorded from the first read onward.
  const w = window as unknown as { __jevInvalid?: WeakSet<Element> };
  if (w.__jevInvalid === undefined) {
    const seen = new WeakSet<Element>();
    w.__jevInvalid = seen;
    document.addEventListener("invalid", (e) => { if (e.target instanceof Element) seen.add(e.target); }, true);
  }
  const refused = w.__jevInvalid;

  const alerts: string[] = [];
  const notices: string[] = [];
  const live = document.querySelectorAll(
    "[role=alert],[role=status],[aria-live=polite],[aria-live=assertive],output",
  );
  for (const el of Array.from(live)) {
    if (!shown(el)) continue;
    const text = cut(norm((el as HTMLElement).innerText));
    if (text === "") continue;
    // A live region nested in another (or duplicating it) is reported once.
    if ([...alerts, ...notices].some((a) => a.includes(text) || text.includes(a))) continue;
    const assertive = el.getAttribute("role") === "alert" || el.getAttribute("aria-live") === "assertive";
    const into = assertive ? alerts : notices;
    if (into.length < limits.items) into.push(text);
  }

  const labelOf = (el: Element): string => {
    const aria = norm(el.getAttribute("aria-label"));
    if (aria !== "") return aria;
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) return norm(labels[0]!.textContent);
    const owner = el.closest("label");
    if (owner !== null) return norm(owner.textContent);
    return norm(el.getAttribute("placeholder")) || norm(el.getAttribute("name")) || el.tagName.toLowerCase();
  };
  const describedBy = (el: Element): string => {
    const ids = `${el.getAttribute("aria-errormessage") ?? ""} ${el.getAttribute("aria-describedby") ?? ""}`.trim();
    if (ids === "") return "";
    return norm(
      ids
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((n): n is HTMLElement => n !== null && shown(n))
        .map((n) => n.innerText)
        .join(" "),
    );
  };

  const invalid: { name: string; message: string }[] = [];
  const fields = document.querySelectorAll("input:not([type=hidden]),select,textarea,[aria-invalid=true]");
  for (const el of Array.from(fields)) {
    if (!shown(el)) continue;
    const f = el as HTMLInputElement;
    const ariaInvalid = norm(el.getAttribute("aria-invalid")).toLowerCase() === "true";
    const nativeInvalid = typeof f.checkValidity === "function" && f.validity !== undefined && !f.validity.valid;
    const reached = refused.has(el) || (typeof f.value === "string" && f.value !== "");
    if (!ariaInvalid && !(nativeInvalid && reached)) continue;
    const message = norm(nativeInvalid ? f.validationMessage : "") || describedBy(el) || "marked invalid";
    invalid.push({ name: cut(labelOf(el)), message: cut(message) });
    if (invalid.length >= limits.items) break;
  }
  return { alerts, notices, invalid };
}

/** Reads the page's status text. A page that cannot be read (navigating, closed) has none. */
export async function readPageStatus(page: Page): Promise<PageStatus> {
  return page
    .evaluate(readStatusInPage, { chars: STATUS_CHARS, items: STATUS_ITEMS })
    .catch(() => EMPTY_STATUS);
}

/** What appeared in `now` that `before` did not show: new alert texts, new / changed invalid fields. */
export function statusDelta(before: PageStatus, now: PageStatus): PageStatus {
  const alerts = now.alerts.filter((a) => !before.alerts.includes(a));
  const notices = now.notices.filter((a) => !before.notices.includes(a));
  const invalid = now.invalid.filter((f) => !before.invalid.some((b) => b.name === f.name && b.message === f.message));
  return { alerts, notices, invalid };
}

/** One-line rendering for history / prompts: `alert "…"; invalid field "Email": "…"`. */
export function describeStatus(s: PageStatus): string {
  return [
    ...s.alerts.map((a) => `alert "${a}"`),
    ...s.notices.map((a) => `status "${a}"`),
    ...s.invalid.map((f) => `invalid field "${f.name}": "${f.message}"`),
  ].join("; ");
}

export function isEmptyStatus(s: PageStatus): boolean {
  return s.alerts.length === 0 && s.notices.length === 0 && s.invalid.length === 0;
}

/**
 * An IN-PROGRESS status the page shows (#92 reopened): a job the app runs in the background and
 * reports by text, not by a request in flight — Preveti's "SIMULATING…" / "A simulation for this bet
 * is already running (started …)", polled by the app, so the network is idle between polls. It
 * counts as pending work: a `wait` on it is patience, never "nothing is pending".
 *
 * Signals, in order: a visible `aria-busy=true` region; a live region (`role=status`, `aria-live`,
 * `role=progressbar`, `<output>`) whose text says work is under way; a short visible line that is a
 * progress verb trailing off ("Simulating…", "Processing...") or says a job "is running" / "in
 * progress". Returns what it saw (for the transcript), or null.
 */
export const IN_PROGRESS_WORDS =
  "simulating|processing|running|generating|drafting|fetching|rendering|publishing|analy[sz]ing|computing|calculating|loading|preparing|working|thinking|uploading|importing|exporting|syncing|saving|submitting|creating|building|training|indexing|queued|in progress";

/** BROWSER CODE — serialized by `page.evaluate`: no imports, no closure over module scope. */
function inProgressInPage(words: string): string | null {
  const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const cut = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
  const shown = (el: Element): boolean => {
    const h = el as HTMLElement;
    if (h.closest("[hidden],[aria-hidden=true]") !== null) return false;
    const st = window.getComputedStyle(h);
    const r = h.getBoundingClientRect();
    return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };
  const loose = new RegExp(`\\b(?:${words})\\b`, "i");
  const trailing = new RegExp(`^\\W*(?:${words})\\b[^.!?]{0,60}(?:…|\\.\\.\\.)\\s*$`, "i");
  const job =
    /\b(?:is|are)\s+(?:still\s+|already\s+|currently\s+|now\s+)?(?:running|processing|in progress|being (?:processed|generated|simulated|prepared))\b|\bstill (?:running|working|processing)\b|^\W*in progress\W*$/i;
  for (const el of Array.from(document.querySelectorAll('[aria-busy="true"]'))) {
    if (shown(el)) return `aria-busy region${norm((el as HTMLElement).innerText) === "" ? "" : ` "${cut(norm((el as HTMLElement).innerText))}"`}`;
  }
  const live = document.querySelectorAll("[role=status],[aria-live=polite],[aria-live=assertive],[role=progressbar],output");
  for (const el of Array.from(live)) {
    if (!shown(el)) continue;
    const text = norm((el as HTMLElement).innerText || el.getAttribute("aria-valuetext") || el.getAttribute("aria-label"));
    if (text !== "" && loose.test(text)) return `status "${cut(text)}"`;
  }
  const body = document.body ? document.body.innerText : "";
  for (const raw of body.split(/\n+/)) {
    const line = norm(raw);
    if (line === "" || line.length > 200) continue;
    if (trailing.test(line) || job.test(line)) return `status text "${cut(line)}"`;
  }
  return null;
}

/** The in-progress status the page shows, or null (a page that cannot be read shows none). */
export async function readInProgressStatus(page: Page): Promise<string | null> {
  return page.evaluate(inProgressInPage, IN_PROGRESS_WORDS).catch(() => null);
}

/**
 * BROWSER CODE — does the page ACKNOWLEDGE work it is doing (#153)? A visible, enabled Cancel /
 * Stop / Abort control (the app offers to cancel the job), a disabled control whose label is a
 * progress phrase ("Analyzing...", the button the user pressed, now busy), or a determinate
 * progress bar. Returns what it saw. Serialized by `page.evaluate`: self-contained.
 */
function workAcknowledgedInPage(words: string): { busyControl: string | null; cancel: string | null; bar: string | null } {
  const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const shown = (el: Element): boolean => {
    const h = el as HTMLElement;
    if (h.closest("[hidden],[aria-hidden=true]") !== null) return false;
    const st = window.getComputedStyle(h);
    const r = h.getBoundingClientRect();
    return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };
  const label = (el: Element): string =>
    el instanceof HTMLInputElement ? norm(el.value) : norm(el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? el.textContent);
  const disabled = (el: Element): boolean => (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
  const controls = Array.from(document.querySelectorAll("button,[role=button],input[type=button],input[type=submit]")).filter(shown);
  const progress = new RegExp(`^\\W*(?:${words})\\b[^.!?]{0,60}(?:…|\\.\\.\\.)?\\s*$`, "i");
  let cancel: string | null = null;
  let busyControl: string | null = null;
  for (const el of controls) {
    const n = label(el);
    if (cancel === null && !disabled(el) && /^\W*(?:cancel|stop|abort)\b/i.test(n)) cancel = `an enabled "${n.slice(0, 40)}" control`;
    if (busyControl === null && disabled(el) && n !== "" && progress.test(n)) busyControl = `a disabled "${n.slice(0, 40)}" control`;
  }
  let bar: string | null = null;
  for (const el of Array.from(document.querySelectorAll("[role=progressbar][aria-valuenow],progress[value]"))) {
    if (!shown(el)) continue;
    const now = Number(el.getAttribute("aria-valuenow") ?? (el as HTMLProgressElement).value);
    const max = Number(el.getAttribute("aria-valuemax") ?? (el as HTMLProgressElement).max) || 100;
    if (Number.isFinite(now) && now < max) {
      bar = `a progress bar at ${Math.round((now / max) * 100)}%`;
      break;
    }
  }
  return { busyControl, cancel, bar };
}

/**
 * The page is WORKING, not hung (#153) — it acknowledges the work it is doing:
 *  - the control the user pressed is DISABLED and labelled with a progress phrase ("Analyzing...");
 *  - or it shows an in-progress status (#92's detection) together with an enabled Cancel / Stop
 *    control or a determinate progress bar.
 * A bare "Loading…" with nothing else is not enough — a stuck page looks exactly like that. Returns a
 * description for the transcript, or null. Callers bound how long "working" is believed.
 */
export async function readWorkingStatus(page: Page): Promise<string | null> {
  const ack = await page.evaluate(workAcknowledgedInPage, IN_PROGRESS_WORDS).catch(() => null);
  if (ack === null) return null;
  if (ack.busyControl !== null) return ack.cancel === null ? ack.busyControl : `${ack.busyControl} and ${ack.cancel}`;
  const extra = ack.cancel ?? ack.bar;
  if (extra === null) return null;
  const status = await readInProgressStatus(page);
  return status === null ? null : `${status} with ${extra}`;
}
