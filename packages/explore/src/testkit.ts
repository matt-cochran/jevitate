/**
 * Shared browser/test helpers for @jevitate/explore's Playwright-backed tests.
 * NOT part of the built package (excluded in tsconfig): it depends on
 * `@jevitate/example-site` (a devDependency) and is only ever imported from
 * `*.test.ts`. Vitest resolves it directly via the source alias.
 */
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";

const port = new PlaywrightBrowserPort();

/**
 * Opens a fresh persistent context (its own profile dir → no shared state),
 * runs `body`, and always tears down. `baseUrl` defaults to a harmless
 * loopback origin so `setContent`-only tests need no server.
 */
export async function withSession<T>(
  prefix: string,
  body: (session: BrowserSession) => Promise<T>,
  baseUrl = "http://127.0.0.1:1/",
): Promise<T> {
  const session = await port.open({
    headless: true,
    allowedOrigins: [baseUrl],
    baseUrl,
  });
  try {
    return await body(session);
  } finally {
    await session.close();
  }
}

/** A minimal static login-ish DOM for snapshot/act/decide fixtures. */
export const LOGIN_FIXTURE_HTML = `<!doctype html><html><body>
  <h1>Sign in</h1>
  <form>
    <label>Username <input name="username" aria-label="Username" /></label>
    <label>Password <input name="password" type="password" aria-label="Password" /></label>
    <button type="submit">Sign in</button>
  </form>
  <a href="/help">Need help?</a>
</body></html>`;

/** A different DOM, to prove the freshness signature changes across states. */
export const INBOX_FIXTURE_HTML = `<!doctype html><html><body>
  <h1>Inbox</h1>
  <ul><li><a href="/thread/1">First thread</a></li></ul>
  <button type="button">Compose</button>
</body></html>`;
