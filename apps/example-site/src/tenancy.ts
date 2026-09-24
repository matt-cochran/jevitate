import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Additive fixture for multi-actor missions (#147): a two-tenant app under `/tenancy/*`.
 *
 *  - `GET  /tenancy/login?as=a|b`  sets that tenant's session cookie (`tsid`), then → /tenancy/items;
 *  - `POST /tenancy/items`         creates an item for the caller's tenant → 201 `{id, title}`;
 *  - `GET  /tenancy/items`         the caller's items, plus a create form (JS: POST, then show it in place at its URL);
 *  - `GET  /tenancy/items/:id`     one item — 404 "Item not found" for another tenant's;
 *  - `GET  /tenancy/api/items`     the caller's items as JSON (`{items: [{id, title}]}`).
 *
 * `leaky` mode (the server option, or `?leaky=1` on a request) is the isolation BUG under test:
 * the list and the JSON list return EVERY tenant's items and any id is served to anyone. An
 * unauthenticated request is bounced to the login page (HTML) or gets a 401 (JSON). Every item page
 * says which tenant is viewing it, so a test can prove an observer's page text never reaches an
 * artifact. `log` records each request's tenant, method and path (the observer-behaviour check).
 */

export interface TenancyOptions {
  /** The isolation bug: lists and item pages ignore the tenant. Mutable at runtime. */
  leaky?: boolean;
  /** Every `/tenancy/*` request: which tenant's session made it (null: none), method and path. */
  readonly log?: Array<{ tenant: string | null; method: string; path: string }>;
}

/** The per-tenant session tokens `/tenancy/login` sets (opaque — a test greps artifacts for them). */
export const TENANCY_SESSIONS: Readonly<Record<string, string>> = {
  a: "tsid-a-7f3c9e21d4b8",
  b: "tsid-b-2a6d0f95c1e3",
};

interface Item {
  readonly id: string;
  readonly tenant: string;
  readonly title: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function registerTenancy(app: FastifyInstance, opts: TenancyOptions = {}): void {
  const items: Item[] = [{ id: "item-1", tenant: "b", title: "Tenant B roadmap" }];
  let next = 1001;
  const tenantOf = (req: FastifyRequest): string | null => {
    const sid = (req.cookies as Record<string, string | undefined>).tsid;
    return Object.entries(TENANCY_SESSIONS).find(([, v]) => v === sid)?.[0] ?? null;
  };
  const leaky = (req: FastifyRequest): boolean => opts.leaky === true || (req.query as Record<string, string | undefined>).leaky === "1";
  const visible = (req: FastifyRequest, tenant: string): Item[] => (leaky(req) ? items : items.filter((i) => i.tenant === tenant));

  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/tenancy/")) opts.log?.push({ tenant: tenantOf(req), method: req.method, path: req.url.split("?")[0] ?? req.url });
  });

  const page = (reply: FastifyReply, body: string, code = 200): void => {
    reply.code(code).type("text/html").send(`<!doctype html><html><body>${body}</body></html>`);
  };

  app.get<{ Querystring: { as?: string } }>("/tenancy/login", async (req, reply) => {
    const token = req.query.as === undefined ? undefined : TENANCY_SESSIONS[req.query.as];
    if (token === undefined) {
      page(reply, `<h1>Sign in</h1><a href="/tenancy/login?as=a">Tenant A</a> <a href="/tenancy/login?as=b">Tenant B</a>`);
      return;
    }
    reply.setCookie("tsid", token, { path: "/", maxAge: 60 * 60 * 24 }).redirect("/tenancy/items");
  });

  app.get("/tenancy/items", async (req, reply) => {
    const tenant = tenantOf(req);
    if (tenant === null) {
      reply.redirect("/tenancy/login");
      return;
    }
    const list = visible(req, tenant)
      .map((i) => `<li data-item-id="${esc(i.id)}"><a href="/tenancy/items/${esc(i.id)}">${esc(i.title)}</a></li>`)
      .join("");
    page(
      reply,
      `<h1>Items</h1>
<form id="create"><label>Title <input name="title" aria-label="Title" /></label><button type="submit">Create item</button></form>
<ul>${list}</ul>
<script>
document.getElementById("create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = e.target.elements.title.value;
  const res = await fetch("/tenancy/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
  const item = await res.json();
  // SPA-style: show the new item in place and move the URL to it (no document load).
  history.pushState({}, "", "/tenancy/items/" + item.id);
  const h = document.createElement("h1");
  h.dataset.itemId = item.id;
  h.textContent = item.title;
  document.body.replaceChildren(h);
});
</script>`,
    );
  });

  app.post<{ Body: { title?: string } }>("/tenancy/items", async (req, reply) => {
    const tenant = tenantOf(req);
    if (tenant === null) {
      reply.code(401).send({ code: "unauthenticated" });
      return;
    }
    const title = typeof req.body?.title === "string" && req.body.title.trim() !== "" ? req.body.title.trim() : "Untitled";
    const item: Item = { id: `item-${next++}`, tenant, title };
    items.push(item);
    reply.code(201).send({ id: item.id, title: item.title });
  });

  app.get<{ Params: { id: string } }>("/tenancy/items/:id", async (req, reply) => {
    const tenant = tenantOf(req);
    if (tenant === null) {
      reply.redirect("/tenancy/login");
      return;
    }
    const item = visible(req, tenant).find((i) => i.id === req.params.id);
    if (item === undefined) {
      page(reply, `<h1>Item not found</h1><a href="/tenancy/items">Back to items</a>`, 404);
      return;
    }
    page(reply, `<h1 data-item-id="${esc(item.id)}">${esc(item.title)}</h1><p>Viewing as tenant ${esc(tenant)}</p><a href="/tenancy/items">Back to items</a>`);
  });

  app.get("/tenancy/api/items", async (req, reply) => {
    const tenant = tenantOf(req);
    if (tenant === null) {
      reply.code(401).send({ code: "unauthenticated" });
      return;
    }
    reply.send({ items: visible(req, tenant).map((i) => ({ id: i.id, title: i.title })) });
  });
}
