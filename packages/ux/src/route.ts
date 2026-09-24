// route.ts — the dedupe key for "same route": a URL's pathname (query/hash dropped).
/** Normalized route for dedupe: the URL pathname (query/hash dropped). */
export function routeOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}
