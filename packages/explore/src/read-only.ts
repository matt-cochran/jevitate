import type { Page, Route, Request } from "playwright";
import type { WriteClassifier } from "@jevitate/recording";
import { controlRisk } from "./safety.js";
import type { Control } from "./snapshot.js";

/**
 * A find-out goal is READ-ONLY by default (#158). Dogfood (Allumata round 2): asked "what does the
 * Design Partner plan cost?", the goal model clicked "Upgrade to Design Partner" (a checkout session
 * reserved one of 250 limited seats) and then "Manage subscription" — although the answer was already
 * on the page.
 *
 * A find-out goal (no `--success` check, ended by `report` #101) that does not itself ask for a
 * change runs under this guard — INDEPENDENT CODE, never the model:
 *  - before an action: a click on a control that is session-ending / destructive / paid (#116's
 *    categories, with NO goal-word lift), that starts a flow (create, add, save, submit, confirm,
 *    manage subscription…) or that submits a form is refused; so are `send` (a message is a write)
 *    and `upload`. Reading ops — navigate by link, open a tab/disclosure, scroll, type into a search
 *    field, select a filter — stay allowed.
 *  - at the network: a write request (the shared #110 classifier) that STARTS inside a model-chosen
 *    action's window — from the act until the page settled after it — is ABORTED before it leaves the
 *    browser, and reported. The app's own background writes outside that window (token refresh,
 *    heartbeat, telemetry) pass through and are listed as `background` side effects: blocking a
 *    rotating refresh token would sign the run out mid-mission. Common auth-refresh endpoints
 *    (`DEFAULT_ALLOWED_WRITES`) and operator globs (`--allow-write`) pass even inside a window.
 * `--allow-writes` (or a goal that asks for a change — "create…", "update…") lifts the guard; the
 * #116 safety policy still applies then.
 */

/**
 * Imperative words that make a find-out goal ask for a change (then it is not read-only). Kept
 * narrow on purpose: a missed change verb only keeps the guard on (the safe side; `--allow-writes`
 * lifts it), while a noun-like reading ("what is the plan set to", "when does the quota reset")
 * must never switch the guard off.
 */
const CHANGE_VERBS =
  /\b(?:create|add|save|submit|send|post|publish|update|edit|modify|rename|delete|remove|revoke|rotate|buy|purchase|upgrade|downgrade|subscribe|unsubscribe|invite|enable|disable|activate|deactivate|sign ?up|register|archive|restore|import|upload|transfer|assign|ask|reply|fill (?:in|out))\b/i;

/** A change verb that is only asked ABOUT ("how do I add…", "what happens if I cancel…"), not asked FOR. */
const ASKED_ABOUT =
  /\b(?:how (?:do|can|would|should|to) (?:i |you |we |users? |one )?|how to |whether (?:i |you |we )?(?:can |could )?|(?:what happens |what if )?(?:if|when|after|before) (?:i |you |we )?|(?:can|could) (?:i|you|we) )\w+/gi;

/** Does the goal itself ask for a change? (then the find-out guard does not apply) */
export function goalAsksForChange(goal: string): boolean {
  return CHANGE_VERBS.test(goal.replace(ASKED_ABOUT, " "));
}

/**
 * A (non-link) control whose name starts a flow that changes state (beyond #116's paid/destructive
 * words). A link only navigates (a GET — whatever it loads that writes is blocked at the network).
 */
const FLOW =
  /\b(?:create|add|new|save|submit|send|post|publish|confirm|continue|proceed|finish|complete|apply|redeem|claim|activate|enable|disable|connect|join|register|sign ?up|book|reserve|request|invite|accept|approve|reject|decline|archive|restore|reset|import|upload|transfer|assign|manage (?:subscription|billing|plan|payment)|billing portal|change (?:plan|tier)|downgrade|switch (?:plan|to)|get started|start|try (?:it|now|free)|install)\b/i;

/** A form submit that only reads (a search/filter form). */
const READ_SUBMIT = /\b(?:search|find|filter|go|look ?up|show|view|apply filters?)\b/i;

/** Auth-refresh endpoints a read-only run never blocks (a blocked rotating refresh signs the run out). */
export const DEFAULT_ALLOWED_WRITES: readonly string[] = ["**/refresh*", "**/token*", "**/oauth/**", "**/auth/**/refresh*"];

/** A path glob: `**` spans segments, `*` stays within one; case-insensitive. */
export function pathGlob(glob: string): RegExp {
  let src = "";
  const g = glob.trim();
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        src += ".*";
        i++;
      } else src += "[^/]*";
    } else src += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`, "i");
}

export const READ_ONLY_NOTE =
  "this is a find-out goal and it is READ-ONLY: find the answer on the pages without changing anything — " +
  "never buy, upgrade, subscribe, create, save, submit, send or delete (such actions are refused and their write requests blocked); " +
  "end with `report` as soon as the page shows the answer";

export interface BlockedWrite {
  readonly method: string;
  /** Path only (never the query — it can carry a token). */
  readonly path: string;
}

export class ReadOnlyGuard {
  readonly #isWrite: WriteClassifier;
  readonly #blocked: BlockedWrite[] = [];
  readonly #allowed: readonly RegExp[];
  #page: Page | null = null;
  #armed = false;
  /** A model-chosen action's window is open (from its act until the page settled after it). */
  #inAction = false;
  readonly #handler = (route: Route, request: Request): Promise<void> => this.#route(route, request);

  constructor(isWrite: WriteClassifier, opts: { readonly allowWrites?: readonly string[] } = {}) {
    this.#isWrite = isWrite;
    this.#allowed = [...DEFAULT_ALLOWED_WRITES, ...(opts.allowWrites ?? [])].filter((g) => g.trim() !== "").map(pathGlob);
  }

  /** A model-chosen action is about to be dispatched: its writes are blocked until `settled()`. */
  beginAction(): void {
    this.#inAction = true;
  }

  /** The page settled after the action: the window closes. True when one was open. */
  settled(): boolean {
    const was = this.#inAction;
    this.#inAction = false;
    return was;
  }

  /** Why an op on a control may not run on a read-only goal, or null when it may. */
  refuses(op: string, control: Pick<Control, "name" | "role" | "submits"> | null): string | null {
    const name = (control?.name ?? "").replace(/\s+/g, " ").trim();
    if (op === "send") return `refused: this find-out goal is read-only — sending a message is a write (pass --allow-writes to permit it)`;
    if (op === "upload") return `refused: this find-out goal is read-only — uploading is a write (pass --allow-writes to permit it)`;
    if (op !== "click" || control === null) return null;
    const risk = controlRisk(name);
    const why =
      risk !== null
        ? `${risk.risk === "session-end" ? "ends the session" : risk.risk === "destructive" ? "is destructive" : "may cost money or contact real people"} (${risk.risk})`
        : control.role !== "link" && FLOW.test(name)
          ? "starts a flow that changes state"
          : control.submits === true && !READ_SUBMIT.test(name)
            ? "submits a form"
            : null;
    if (why === null) return null;
    return `refused: this find-out goal is read-only — "${name}" ${why}; find the answer on the page instead (pass --allow-writes to permit it)`;
  }

  /** From now on, a write request that starts inside an action window is aborted before it leaves the browser. */
  async arm(page: Page): Promise<void> {
    if (this.#armed) return;
    this.#armed = true;
    this.#page = page;
    await page.route("**/*", this.#handler);
  }

  async #route(route: Route, request: Request): Promise<void> {
    let path = "/";
    try {
      path = new URL(request.url()).pathname;
    } catch {
      /* keep "/" */
    }
    const write = this.#isWrite({ method: request.method(), path, contentType: request.headers()["content-type"] ?? null });
    if (!write || !this.#inAction || this.#allowed.some((g) => g.test(path))) {
      await route.fallback().catch(() => undefined);
      return;
    }
    this.#blocked.push({ method: request.method().toUpperCase(), path });
    await route.abort("blockedbyclient").catch(() => undefined);
  }

  /** The writes blocked since the last call. */
  drain(): BlockedWrite[] {
    return this.#blocked.splice(0, this.#blocked.length);
  }

  async disarm(): Promise<void> {
    const page = this.#page;
    this.#page = null;
    this.#armed = false;
    if (page !== null && !page.isClosed()) await page.unroute("**/*", this.#handler).catch(() => undefined);
  }
}
