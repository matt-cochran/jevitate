import type { Page, Response } from "playwright";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
import { globRegex, matchesPattern, walkExpression, type CaptureWhen, type EvalValue, type ExprNode, type ObservedList } from "@jevitate/recording";
import type { InvariantAction, InvariantValue } from "./types.js";
import { parseConnectUnaryError } from "../rpc-status.js";

/**
 * Constants and free helpers used by `InvariantMonitor` (in `../declared-invariants.ts`). None were
 * exported from the pre-split file, so this module is never re-exported by the barrel.
 */

export const DOM_TIMEOUT_MS = 1_000;
export const PROBE_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_VALUE_CHARS = 120;
export const DEFAULT_SETTLE_POLL_MS = 1_000;
export const PENDING_BODY_WAIT_MS = 2_000;
export const OBSERVER_NAV_TIMEOUT_MS = 15_000;
export const OBSERVER_IDLE_MS = 5_000;
export const MAX_APP_EVIDENCE = 5;
/** #195: matching responses kept per `never.response` invariant between two checks (the rest are counted). */
export const MAX_RESPONSE_HITS = 20;
/** #195: at run end, how long to wait for an in-flight request a `never.response` glob names. */
export const FLUSH_WAIT_MS = 5_000;
export const FLUSH_POLL_MS = 50;
/** An observer bounced here lost its session: "undecided", never "denied" (#147, cf. #82). */
export const LOGIN_PATH_RE = /(^|\/)(log-?in|sign-?in|signin|auth|sso)(\/|$)/i;
/** gRPC status codes → the Connect code names (#73/#110: gRPC-web reports errors in a header). */
export const GRPC_CODES: Readonly<Record<string, string>> = {
  "1": "canceled",
  "2": "unknown",
  "3": "invalid_argument",
  "4": "deadline_exceeded",
  "5": "not_found",
  "6": "already_exists",
  "7": "permission_denied",
  "8": "resource_exhausted",
  "9": "failed_precondition",
  "10": "aborted",
  "11": "out_of_range",
  "12": "unimplemented",
  "13": "internal",
  "14": "unavailable",
  "15": "data_loss",
  "16": "unauthenticated",
};

export function namesUsing(ast: ExprNode, fns: ReadonlyArray<"before" | "after" | "delta">): string[] {
  const out = new Set<string>();
  walkExpression(ast, (n) => {
    if (n.t === "obs" && fns.includes(n.fn)) out.add(n.name);
  });
  return [...out];
}

export function matchesActionWhen(w: CaptureWhen, action: InvariantAction | null): boolean {
  if (action === null || action.op === null) return false;
  if (w.op !== undefined && !w.op.includes(action.op)) return false;
  if (w.control !== undefined && (action.control === null || !matchesPattern(w.control.name, action.control, true))) return false;
  if (w.route !== undefined && !globRegex(w.route).test(pathnameOf(action.url))) return false;
  return true;
}

/** The Connect/gRPC error code of a response, if it carries one (header, or a Connect JSON error body). */
export async function connectCodeOf(response: Response): Promise<string | null> {
  const headers = response.headers();
  const grpc = headers["grpc-status"];
  if (grpc !== undefined) return GRPC_CODES[grpc.trim()] ?? null;
  if (response.status() < 400 || !(headers["content-type"] ?? "").includes("json")) return null;
  const buf = await response.body().catch(() => null);
  if (buf === null || buf.length > MAX_BODY_BYTES) return null;
  return parseConnectUnaryError(buf.toString("utf8"));
}

export function pageOf(actor: Actor): Page {
  return actor.ability(BrowseTheWebToken).session.page;
}

export function matchesUrlGlob(glob: string, url: string): boolean {
  const re = globRegex(glob);
  if (glob.startsWith("/")) {
    try {
      const u = new URL(url);
      return re.test(`${u.pathname}${u.search}`) || re.test(u.pathname);
    } catch {
      return false;
    }
  }
  return re.test(url);
}

export function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

export function display(v: InvariantValue): string {
  if (v !== null && typeof v === "object") return "items" in v ? `(${v.items} items)` : "(unreadable)";
  return JSON.stringify(v);
}

export function isList(v: EvalValue): v is ObservedList {
  return Array.isArray(v);
}

export function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
}

export function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}
