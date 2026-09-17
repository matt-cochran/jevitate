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
    reply.setCookie("sid", "ok", { path: "/" }).redirect("/inbox");
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

  app.get<{ Params: { id: string } }>("/thread/:id", async (req, reply) => {
    if (!authed(req)) { reply.redirect("/login"); return; }
    const t = SEED_THREADS.find((x) => x.id === req.params.id);
    if (!t) { reply.code(404).send("not found"); return; }
    const msgs = t.messages.map((m) =>
      `<li data-message-id="${esc(m.id)}" data-sender="${esc(m.sender)}" data-received-at="${esc(m.receivedAt)}">${esc(m.text)}</li>`,
    ).join("");
    reply.type("text/html").send(`<!doctype html><html><body><h1>${esc(t.subject)}</h1><ul>${msgs}</ul></body></html>`);
  });

  return app;
}
