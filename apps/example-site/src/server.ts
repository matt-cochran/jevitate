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

  // Additive fixture for the feature-testing mission's ranking + scope
  // guardrails (ticket #78): a header `<nav>` of 5 links — global chrome,
  // present byte-identically on every page under this fixture — plus, on the
  // `/shop` page only, an in-scope `<section>` of 3 "Buy pack" buttons that
  // mutate the page in place (no navigation, so they never leave scope). The
  // nav links all point OUTSIDE the `/feature-mission/shop` route glob, so a
  // correct mission must record them as boundary edges (never expanded, never
  // counted as a discovered feature path) while still exercising the buttons.
  // `/feature-mission/chrome-only` carries the same nav and nothing else — no
  // control there serves any capability, so a mission scoped to it alone must
  // end `inconclusive`, never `clean`.
  const FEATURE_MISSION_NAV: readonly [string, string][] = [
    ["home", "Home"],
    ["docs", "Docs"],
    ["pricing", "Pricing"],
    ["about", "About"],
    ["contact", "Contact"],
  ];
  const featureMissionChrome = (): string =>
    `<header><nav data-testid="global-nav">${FEATURE_MISSION_NAV.map(
      ([slug, label]) => `<a href="/feature-mission/${esc(slug)}" data-testid="nav-${esc(slug)}">${esc(label)}</a>`,
    ).join("")}</nav></header>`;

  app.get("/feature-mission/shop", async (_req, reply) => {
    const packs = [1, 2, 3]
      .map(
        (n) =>
          `<button data-testid="buy-pack-${n}" onclick="this.textContent='Added pack ${n}'">Buy pack ${n}</button>`,
      )
      .join("");
    reply.type("text/html").send(
      `<!doctype html><html><body>${featureMissionChrome()}<section data-testid="packs"><h1>Buy a pack</h1>${packs}</section></body></html>`,
    );
  });

  for (const [slug] of FEATURE_MISSION_NAV) {
    app.get(`/feature-mission/${slug}`, async (_req, reply) => {
      reply.type("text/html").send(
        `<!doctype html><html><body>${featureMissionChrome()}<main><h1>${esc(slug)}</h1></main></body></html>`,
      );
    });
  }

  app.get("/feature-mission/chrome-only", async (_req, reply) => {
    reply.type("text/html").send(`<!doctype html><html><body>${featureMissionChrome()}</body></html>`);
  });

  // Additive fixture for the coverage/exploratory mission's scope containment (#89, reusing #64's
  // scope model): area-a links to an in-scope sub-page AND to an out-of-scope area-b. A coverage
  // run started at /coverage-scope/area-a must explore area-a and its own detail page, record
  // area-b as a departure, and never expand area-b's own states unless the scope is explicitly
  // widened (--route '/**' or --scope app). Namespaced under /coverage-scope/* to stay clear of
  // other fixtures.
  app.get("/coverage-scope/area-a", async (_req, reply) => {
    reply.type("text/html").send(
      `<!doctype html><html><body><h1>Area A</h1>` +
        `<a href="/coverage-scope/area-a/detail">Detail</a> ` +
        `<a href="/coverage-scope/area-b">Go to Area B</a>` +
        `</body></html>`,
    );
  });
  // Buttons here are inert (no onclick): a mutating label would fingerprint as a SECOND state
  // (before/after click), which is correct behavior elsewhere but would obscure this fixture's
  // single concern — scope containment — under an unrelated state count.
  app.get("/coverage-scope/area-a/detail", async (_req, reply) => {
    reply.type("text/html").send(
      `<!doctype html><html><body><h1>Area A detail</h1><button>Detail action</button></body></html>`,
    );
  });
  app.get("/coverage-scope/area-b", async (_req, reply) => {
    reply.type("text/html").send(
      `<!doctype html><html><body><h1>Area B</h1><button>Area B action</button></body></html>`,
    );
  });

  // Additive fixture for route templating (#95): three item pages under a PREFIXED id
  // (item-1/item-2/item-3), identical apart from the id in the path and a text node (never a
  // control). The coverage mission's state fingerprint (`urlTemplate`) must collapse all three
  // into ONE `/coverage-templating/items/item-:id` state, not three.
  app.get("/coverage-templating/items", async (_req, reply) => {
    reply.type("text/html").send(
      `<!doctype html><html><body><h1>Items</h1>` +
        `<a href="/coverage-templating/items/item-1">Item 1</a> ` +
        `<a href="/coverage-templating/items/item-2">Item 2</a> ` +
        `<a href="/coverage-templating/items/item-3">Item 3</a>` +
        `</body></html>`,
    );
  });
  // The button is inert (no onclick): a mutating label would fingerprint as a second state
  // per item id, obscuring the templating collapse this fixture exists to prove.
  app.get<{ Params: { id: string } }>("/coverage-templating/items/:id", async (req, reply) => {
    reply.type("text/html").send(
      `<!doctype html><html><body><h1>Item</h1><p data-testid="item-id">${esc(req.params.id)}</p>` +
        `<button>Mark reviewed</button></body></html>`,
    );
  });

  // Rich-text editor fixture (#148): three contenteditable prose blocks (persisted per server
  // instance, so `reloadThen` proves an edit saved), `[data-heat]` highlight spans, and an SVG
  // minimap whose cells scroll their block into view and flash it for 800 ms.
  //   ?broken=heat    — the heat spans render with alpha 0 (text and count unchanged)
  //   ?broken=minimap — a cell scrolls to the WRONG block and never flashes
  const blocks = new Map<string, string>(EDITOR_BLOCKS);
  app.get<{ Querystring: { broken?: string } }>("/editor-fixture", async (req, reply) => {
    const broken = req.query.broken ?? "";
    const heatAlpha = broken === "heat" ? "0" : "0.4";
    const ids = [...blocks.keys()];
    const cells = ids
      .map(
        (id, i) =>
          `<rect data-cell="${i + 1}" data-target="${id}" role="button" aria-label="Jump to block ${i + 1}" x="0" y="${i * 40}" width="40" height="36" fill="#8ab"></rect>`,
      )
      .join("");
    const prose = ids.map((id) => `<p id="${id}" class="block" contenteditable="true">${blocks.get(id) ?? ""}</p>`).join("\n");
    reply.type("text/html").send(`<!doctype html><html><head><title>Editor fixture</title><style>
body { font: 16px/1.5 sans-serif; margin: 0; padding: 16px 80px 16px 16px; }
.block { margin: 0 0 150vh; padding: 8px; }
[data-heat] { background-color: rgba(255, 200, 0, ${heatAlpha}); }
.flash { outline: 3px solid orange; }
#minimap { position: fixed; top: 10px; right: 10px; }
</style></head><body><h1>Editor</h1>
<svg id="minimap" width="40" height="${ids.length * 40}">${cells}</svg>
${prose}
<script>
const broken = ${JSON.stringify(broken)};
const ids = ${JSON.stringify(ids)};
for (const p of document.querySelectorAll(".block")) {
  p.addEventListener("input", () => {
    fetch("/editor-fixture/blocks/" + p.id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ html: p.innerHTML }), keepalive: true });
  });
}
for (const cell of document.querySelectorAll("rect[data-cell]")) {
  cell.addEventListener("click", () => {
    let id = cell.getAttribute("data-target");
    if (broken === "minimap") id = ids[(ids.indexOf(id) + 1) % ids.length];
    const block = document.getElementById(id);
    block.scrollIntoView({ block: "center" });
    if (broken === "minimap") return;
    block.classList.add("flash");
    setTimeout(() => block.classList.remove("flash"), 800);
  });
}
</script></body></html>`);
  });
  app.put<{ Params: { id: string }; Body: { html?: string } }>("/editor-fixture/blocks/:id", async (req, reply) => {
    if (!blocks.has(req.params.id) || typeof req.body?.html !== "string") {
      reply.code(400).send({ ok: false });
      return;
    }
    blocks.set(req.params.id, req.body.html);
    reply.send({ ok: true });
  });

  return app;
}

/** The editor fixture's initial prose blocks (#148), by id. */
export const EDITOR_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["b1", 'The draft opens with <span data-heat="3">three risky claims</span> and <span data-heat="1">a soft hedge</span>.'],
  ["b2", "Paragraph two says the quick brown fox jumps over the lazy dog."],
  ["b3", "The closing paragraph thanks the reader for their time."],
];
