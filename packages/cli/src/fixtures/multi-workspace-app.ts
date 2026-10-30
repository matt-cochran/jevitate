import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * #741 served fixture: an app whose signed-in superadmin belongs to several workspace roles.
 *
 *  - Without a workspace selection (no `org` cookie) `/app` offers a "Choose your workspace"
 *    chooser rendered as one clickable `<button>` card per workspace role (for example
 *    "System Admin", "Workspace A Admin"). Clicking a card writes the organization/role into
 *    cookies and loads that workspace's dashboard.
 *  - With one, `/app` serves the dashboard directly, so a Playwright storage state captured after
 *    `jevitate login` selected the declared `context` reopens straight into it — no chooser.
 *
 * The app is deliberately stateful (server-side session ids), so the reopen is a real boundary:
 * only a captured, still-valid state lands on the dashboard.
 */

/** One workspace membership the superadmin can act as. */
export interface MultiWorkspaceRole {
  readonly organization: string;
  readonly role: string;
}

export interface MultiWorkspaceApp {
  /** The served origin (`http://127.0.0.1:<port>`). */
  readonly origin: string;
  /** The superadmin credentials the sign-in form accepts. */
  readonly user: string;
  readonly password: string;
  /** The workspace roles the chooser renders as cards. */
  readonly memberships: readonly MultiWorkspaceRole[];
  close(): Promise<void>;
}

export interface MultiWorkspaceAppOptions {
  readonly user?: string;
  readonly password?: string;
  readonly memberships?: readonly MultiWorkspaceRole[];
}

const DEFAULT_USER = "root@example.test";
const DEFAULT_PASSWORD = "super-secret";
const DEFAULT_MEMBERSHIPS: readonly MultiWorkspaceRole[] = [
  { organization: "System", role: "Admin" },
  { organization: "Workspace A", role: "Admin" },
  { organization: "Workspace B", role: "Viewer" },
];

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  return (req.headers.cookie ?? "")
    .split(/;\s*/)
    .map((c) => c.split("="))
    .find(([k]) => k === name)?.[1];
}

const html = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The accessible name of a role card (for example "System" + "Admin" → "System Admin"). */
const cardName = (membership: MultiWorkspaceRole): string => `${membership.organization} ${membership.role}`;

const loginPage = (): string =>
  html(`<h1>Sign in</h1>
  <form method="post" action="/login">
    <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username">
    <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>`);

const chooserPage = (memberships: readonly MultiWorkspaceRole[]): string =>
  html(`<h1>Choose your workspace</h1>
  <p>Choose the workspace and role to act as.</p>
  <div class="cards">
    ${memberships
      .map((m) => `<button type="button" data-org="${escapeHtml(m.organization)}" data-role="${escapeHtml(m.role)}">${escapeHtml(cardName(m))}</button>`)
      .join("\n    ")}
  </div>
  <script>
    document.querySelectorAll("button[data-org]").forEach(function (button) {
      button.addEventListener("click", function () {
        document.cookie = "org=" + encodeURIComponent(button.dataset.org) + "; path=/";
        document.cookie = "role=" + encodeURIComponent(button.dataset.role) + "; path=/";
        location.href = "/app";
      });
    });
  </script>`);

const dashboardPage = (organization: string, role: string): string =>
  html(`<h1>Workspace dashboard</h1>
  <dl>
    <dt>Organization</dt><dd id="workspace-org">${organization}</dd>
    <dt>Role</dt><dd id="workspace-role">${role}</dd>
  </dl>`);

/** Starts the served multi-workspace app on an ephemeral loopback port. */
export async function startMultiWorkspaceApp(options: MultiWorkspaceAppOptions = {}): Promise<MultiWorkspaceApp> {
  const user = options.user ?? DEFAULT_USER;
  const password = options.password ?? DEFAULT_PASSWORD;
  const memberships = options.memberships ?? DEFAULT_MEMBERSHIPS;
  const sessions = new Set<string>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/login" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(loginPage());
      return;
    }
    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("email") !== user || form.get("password") !== password) {
          res.writeHead(401, { "content-type": "text/html; charset=utf-8" }).end(loginPage());
          return;
        }
        const sid = randomUUID();
        sessions.add(sid);
        res.writeHead(303, { location: form.get("next") ?? "/app", "set-cookie": `sid=${sid}; Path=/` }).end();
      });
      return;
    }
    if (url.pathname === "/app") {
      const sid = cookieOf(req, "sid");
      if (sid === undefined || !sessions.has(sid)) {
        res.writeHead(302, { location: "/login?next=/app" }).end();
        return;
      }
      const organization = cookieOf(req, "org");
      if (organization === undefined || organization === "") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(chooserPage(memberships));
        return;
      }
      const role = cookieOf(req, "role") ?? "member";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(dashboardPage(decodeURIComponent(organization), decodeURIComponent(role)));
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(302, { location: "/app" }).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", () => resolve()).once("error", reject));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("multi-workspace app has no TCP address");
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    user,
    password,
    memberships,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
