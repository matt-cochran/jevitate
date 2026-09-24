// route.ts — the dedupe key for "same route": a URL's pathname (query/hash dropped), with
// id-like/prefixed-id path segments templated (#95), reusing `@jevitate/recording`'s shared
// route-normalization helper so a resource id (`/decisions/candidate-<uuid>`) doesn't fragment
// screen attribution and finding grouping into one row per instance visited.
import { urlTemplate } from "@jevitate/recording";

/** Normalized route for dedupe: the URL pathname (query/hash dropped, id-like segments templated). */
export function routeOf(url: string): string {
  try {
    return urlTemplate(new URL(url).pathname || "/");
  } catch {
    return urlTemplate(url.split(/[?#]/)[0] ?? url);
  }
}
