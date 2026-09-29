import type { Assertion } from "../schema.js";

/**
 * #195 — `never.response`: an app response on the mission's OWN traffic (the primary's page) that
 * must never be seen, e.g. the guaranteed billing 403 of a role (`{ url: "/api/v1/tool/billing/**",
 * status: "403" }`). `url` is a glob: starting with `/` it matches the response URL's PATH (with or
 * without its query); otherwise the whole URL. Only responses from the mission's authorized origins
 * (the start URL's origin unless `--allow` widens it) are ever matched. `status` is an exact code
 * (`"403"` or `403`) or a class (`"4xx"`); `method` optionally narrows it (`GET`, `POST`, …).
 */
export interface NeverResponse {
  url: string;
  status: string | number;
  method?: string;
}

export type InvariantNever = { pageText: string } | { assertion: Assertion } | { response: NeverResponse };

/** Does an HTTP status match a `never.response.status` (#195): an exact code, or a class like `"4xx"`. */
export function matchesResponseStatus(want: string | number, status: number): boolean {
  const s = String(want).toLowerCase();
  const cls = /^([1-5])xx$/.exec(s);
  if (cls !== null) return Math.floor(status / 100) === Number(cls[1]);
  return Number(s) === status;
}
