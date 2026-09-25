import type { FastifyInstance } from "fastify";

/**
 * The launch demo (docs/demo.md): a small profile-settings form under `/demo/*` with ONE planted bug.
 *
 *  - `GET /demo/profile`      a form (Display name, Email, Bio) whose Save sends `PUT /demo/api/profile`;
 *  - `GET /demo/api/profile`  the saved profile as JSON (what an app-declared invariant probes);
 *  - `PUT /demo/api/profile`  saves it: 400 for an empty or over-long (>100) name, by design (a 4xx is
 *                             never a defect), 200 otherwise — EXCEPT the bug below.
 *
 * The bug: a display name with a character outside Latin-1 (an emoji, Arabic, Cyrillic) makes the
 * save return HTTP 500, and the page still says "Saved" because it never checks the response. It is
 * deterministic, so every replay of the repro reproduces it. `fixed` (the server option, or
 * `DEMO_FIXED=1` for `pnpm --filter @jevitate/example-site demo`) turns the fix on, so the demo can
 * show `verify-fix` and the captured regression passing after the fix.
 */

export interface DemoOptions {
  /** The planted bug is fixed: every non-empty name up to 100 characters saves. */
  readonly fixed?: boolean;
}

const MAX_NAME = 100;

export function registerDemo(app: FastifyInstance, opts: DemoOptions = {}): void {
  let saved = { displayName: "Ada Lovelace", email: "ada@example.test", bio: "" };

  app.get("/demo/profile", async (_req, reply) => {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    reply.type("text/html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Profile settings</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}input,textarea{display:block;width:100%;padding:.4rem}button{margin-top:1rem;padding:.5rem 1.25rem}</style>
</head><body><h1>Profile settings</h1>
<form id="profile">
<label>Display name <input name="displayName" aria-label="Display name" value="${esc(saved.displayName)}"></label>
<label>Email <input name="email" type="email" aria-label="Email" value="${esc(saved.email)}"></label>
<label>Bio <textarea name="bio" aria-label="Bio">${esc(saved.bio)}</textarea></label>
<button type="submit">Save</button>
</form>
<p role="status" data-testid="status"></p>
<script>
document.getElementById("profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const res = await fetch("/demo/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // BUG (planted): a 5xx is reported as success, because only a 4xx is checked.
  const status = document.querySelector("[data-testid=status]");
  const ok = !(res.status >= 400 && res.status < 500);
  status.textContent = ok ? "Saved" : "Please check the form.";
  status.dataset.state = ok ? "saved" : "invalid";
});
</script></body></html>`);
  });

  app.get("/demo/api/profile", async (_req, reply) => {
    reply.send(saved);
  });

  app.put<{ Body: { displayName?: unknown; email?: unknown; bio?: unknown } }>("/demo/api/profile", async (req, reply) => {
    const name = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
    if (name === "" || name.length > MAX_NAME) {
      reply.code(400).send({ ok: false, error: `display name must be 1-${MAX_NAME} characters` });
      return;
    }
    // BUG (planted): the "legacy search index" only takes Latin-1, and its write error escapes.
    if (opts.fixed !== true && /[^\u0000-\u00ff]/.test(name)) {
      reply.code(500).send({ ok: false, error: "internal error" });
      return;
    }
    saved = {
      displayName: name,
      email: typeof req.body?.email === "string" ? req.body.email : saved.email,
      bio: typeof req.body?.bio === "string" ? req.body.bio : saved.bio,
    };
    reply.send({ ok: true, displayName: saved.displayName });
  });
}
