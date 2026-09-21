import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { SEED_THREADS } from "./data.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const authed = (req: { cookies: Record<string, string | undefined> }) => req.cookies.sid === "ok";

export function buildServer(): FastifyInstance {
  const app = Fastify();
  app.register(cookie);
  app.register(formbody);

  app.get("/login", async (_req, reply) => {
    reply.type("text/html").send(`<!doctype html><html><body><h1>Sign in</h1>
<form method="post" action="/login">
<label>Username <input name="username" aria-label="Username" /></label>
<button type="submit">Sign in</button></form></body></html>`);
  });

  app.post<{ Body: { username?: string } }>("/login", async (req, reply) => {
    if (!req.body?.username) { reply.code(400).send("username required"); return; }
    // maxAge is required: without it this is a session cookie, and Chromium drops session
    // cookies when a persistent context is closed, so login would not survive across the
    // separate ActionRunner.run() calls that reuse the same profileDir.
    reply.setCookie("sid", "ok", { path: "/", maxAge: 60 * 60 * 24 }).redirect("/inbox");
  });

  app.get("/whoami", async (req, reply) => {
    reply.send({ authenticated: authed(req), account: authed(req) ? "jane" : null });
  });

  app.get("/inbox", async (req, reply) => {
    if (!authed(req)) { reply.redirect("/login"); return; }
    const items = SEED_THREADS.map((t) => {
      const first = t.messages[0];
      return `<li data-thread-id="${esc(t.id)}" data-message-id="${esc(first.id)}" data-sender="${esc(first.sender)}" data-received-at="${esc(first.receivedAt)}">
<a href="/thread/${esc(t.id)}">${esc(t.subject)}</a>
<p>${esc(first.text)}</p></li>`;
    }).join("");
    reply.type("text/html").send(`<!doctype html><html><body><h1>Inbox</h1><ul>${items}</ul></body></html>`);
  });

  // Additive fixture for @jevitate/explore's adversarial mission (ticket #4):
  // a deterministic 5xx so the hard-signal defect oracle has a real HTTP 500 to
  // observe. Namespaced under /adversarial to stay clear of other fixtures.
  app.get("/adversarial/boom", async (_req, reply) => {
    reply.code(500).send("internal error");
  });

  // Additive fixture for @jevitate/explore's adversarial mission (ticket #29):
  // a deterministic 4xx. A legitimate 4xx during MISUSE (a gated/absent route
  // the app declines by design) is EXPECTED and must NOT be scored as a defect,
  // even though Chromium logs it to the console as "Failed to load resource".
  app.get("/adversarial/notfound", async (_req, reply) => {
    reply.code(404).send("not found");
  });

  app.get<{ Params: { id: string } }>("/thread/:id", async (req, reply) => {
    if (!authed(req)) { reply.redirect("/login"); return; }
    const t = SEED_THREADS.find((x) => x.id === req.params.id);
    if (!t) { reply.code(404).send("not found"); return; }
    const msgs = t.messages.map((m) =>
      `<li data-message-id="${esc(m.id)}" data-sender="${esc(m.sender)}" data-received-at="${esc(m.receivedAt)}">${esc(m.text)}</li>`,
    ).join("");
    reply.type("text/html").send(`<!doctype html><html><body><h1>${esc(t.subject)}</h1><ul>${msgs}</ul></body></html>`);
  });

  // Additive, namespaced fixture for the exploratory-testing (state-coverage)
  // mission: two pages that link to each other, forming a real inter-page cycle
  // (cycle-a <-> cycle-b). The induction mission must exercise the return edge
  // without re-expanding the already-visited state or looping forever. Kept
  // under /exploratory-testing/* and separate from the shared inbox/thread
  // routes so parallel Wave-3 fixture edits never collide.
  app.get("/exploratory-testing/cycle-a", async (_req, reply) => {
    reply.type("text/html").send(
      `<!doctype html><html><body><h1>Cycle A</h1><a href="/exploratory-testing/cycle-b">Go to B</a></body></html>`,
    );
  });
  app.get("/exploratory-testing/cycle-b", async (_req, reply) => {
    reply.type("text/html").send(
      `<!doctype html><html><body><h1>Cycle B</h1><a href="/exploratory-testing/cycle-a">Back to A</a></body></html>`,
    );
  });

  return app;
}
