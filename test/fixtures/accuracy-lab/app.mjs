#!/usr/bin/env node
// #644 Seeded-defect accuracy lab: a tiny fictional "Acme CRM" served by plain node:http.
//
//   node app.mjs --port 0 --variant clean                 (CLI; prints the ready line below)
//   const { url, close } = await startAccuracyLab({ variant, port: 0 });
//
// One variant is active per server:
//   clean       J1/J2/J3 all behave
//   j1-5xx      J1 Save's PUT returns 500, but the UI still says "Saved"
//   j2-stall    J2 Send does nothing: no request, no feedback
//   j3-effort   J3 adds 3 extra confirmation screens before the import
//   j3-deadend  J3's final Import button is disabled with no explanation
//
// No dependencies, no build. All state is in memory and reset per start; the CLI adds the
// process-level `ACME_CRM_LISTENING <port> variant=<v>` ready line the harness waits for.
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VARIANTS = ["clean", "j1-5xx", "j2-stall", "j3-effort", "j3-deadend", "j2-phantom", "j3-phantom"];

const SAMPLE_CSV = "name,email\nGrace Hopper,grace@example.com\nAlan Turing,alan@example.com";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const shell = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Acme CRM</title></head><body>
<header><nav aria-label="Primary">
<a href="/" data-testid="nav-home">Acme CRM</a> ·
<a href="/profile" data-testid="nav-profile">Profile</a> ·
<a href="/contacts" data-testid="nav-contacts">Contacts</a> ·
<a href="/import" data-testid="nav-import">Import</a>
</nav></header><main>${body}</main></body></html>`;

// ── J1: update my profile ───────────────────────────────────────────────────
const profilePage = (state) => shell(
  "My profile",
  `<h1>Update my profile</h1>
<form data-testid="profile-form" method="post" action="/profile/save">
  <p><label for="profile-name">Name</label>
     <input id="profile-name" name="name" data-testid="profile-name" value="${esc(state.profile.name)}"></p>
  <p><label for="profile-email">Email</label>
     <input id="profile-email" name="email" type="email" data-testid="profile-email" value="${esc(state.profile.email)}"></p>
  <p><button type="submit" data-testid="profile-save">Save</button></p>
  <p data-testid="profile-status" role="status" aria-live="polite"></p>
</form>
<p>Current saved values: <span data-testid="profile-current" data-name="${esc(state.profile.name)}" data-email="${esc(state.profile.email)}">${esc(state.profile.name)} / ${esc(state.profile.email)}</span></p>
<script>
(function () {
  var form = document.querySelector('[data-testid="profile-form"]');
  var status = document.querySelector('[data-testid="profile-status"]');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.querySelector('[data-testid="profile-name"]').value;
    var email = document.querySelector('[data-testid="profile-email"]').value;
    // The UI shows "Saved" as soon as Save is pressed, whatever the store answers.
    fetch('/api/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name, email: email }) })
      .catch(function () {})
      .then(function () { status.textContent = 'Saved'; });
  });
})();
</script>`,
);

// ── J2: send a message to a contact ─────────────────────────────────────────
const contactsPage = (state, variant) => {
  const stall = variant === "j2-stall";
  const options = state.contacts
    .map((c) => `<option value="${esc(c.email)}">${esc(c.name)} &lt;${esc(c.email)}&gt;</option>`)
    .join("");
  const sentRows = state.sent
    .map((m) => `<li data-testid="sent-row" data-to="${esc(m.to)}">${esc(m.to)} — ${esc(m.body)}</li>`)
    .join("");
  const contactRows = state.contacts
    .map((c) => `<li data-testid="contact-row" data-email="${esc(c.email)}">${esc(c.name)} &lt;${esc(c.email)}&gt;</li>`)
    .join("");
  const script = stall
    ? `<script>
(function () {
  var form = document.querySelector('[data-testid="message-form"]');
  form.addEventListener('submit', function (e) { e.preventDefault(); });
})();
</script>`
    : `<script>
(function () {
  var form = document.querySelector('[data-testid="message-form"]');
  var list = document.querySelector('[data-testid="sent-list"]');
  var status = document.querySelector('[data-testid="message-status"]');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var to = document.querySelector('[data-testid="contact-select"]').value;
    var body = document.querySelector('[data-testid="message-body"]').value;
    fetch('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: to, body: body }) })
      .then(function (r) { return r.json(); })
      .then(function (m) {
        if (!m.ok) { status.textContent = 'Message failed'; return; }
        var li = document.createElement('li');
        li.setAttribute('data-testid', 'sent-row');
        li.setAttribute('data-to', m.to);
        li.textContent = m.to + ' — ' + m.body;
        list.appendChild(li);
        status.textContent = 'Message sent';
        document.querySelector('[data-testid="message-body"]').value = '';
      })
      .catch(function () { status.textContent = 'Message failed'; });
  });
})();
</script>`;
  return shell(
    "Contacts",
    `<h1>Send a message to a contact</h1>
<form data-testid="message-form" method="post" action="/contacts/send">
  <p><label for="contact-select">Contact</label>
     <select id="contact-select" name="contact" data-testid="contact-select">${options}</select></p>
  <p><label for="message-body">Message</label>
     <textarea id="message-body" name="body" data-testid="message-body" rows="4" cols="50"></textarea></p>
  <p><button type="submit" data-testid="send-message">Send</button></p>
  <p data-testid="message-status" role="status" aria-live="polite"></p>
</form>
<h2>All contacts</h2>
<ul data-testid="contact-list">${contactRows}</ul>
<h2>Sent messages</h2>
<ul data-testid="sent-list">${sentRows}</ul>${script}`,
  );
};

// ── J3: import contacts from a CSV ──────────────────────────────────────────
const importPage = (variant) => {
  const extra = variant === "j3-effort" ? 3 : 0;
  const deadend = variant === "j3-deadend";
  const extraSections = Array.from({ length: extra }, (_, i) => {
    const n = i + 1;
    return `<section data-testid="import-extra-${n}" data-step="${n}" hidden>
  <h2>Confirmation ${n} of ${extra}</h2>
  <p>Please confirm that you want to continue with this import.</p>
  <p><button type="button" data-testid="import-continue-${n}" data-continue="${n}">Continue</button></p>
</section>`;
  }).join("\n");
  const importDisabled = deadend ? " disabled" : "";
  return shell(
    "Import contacts",
    `<h1>Import contacts from a CSV</h1>
<div data-testid="import-wizard">
  <section data-testid="import-step-source">
    <h2>Step 1: choose your CSV</h2>
    <p><label for="csv-text">Paste CSV text</label></p>
    <p><textarea id="csv-text" data-testid="csv-text" rows="4" cols="50">${esc(SAMPLE_CSV)}</textarea></p>
    <p><label for="csv-file">Or choose a CSV file</label>
       <input id="csv-file" type="file" accept=".csv,text/csv" data-testid="csv-file"></p>
    <p><button type="button" data-testid="import-continue" data-continue="map">Continue</button></p>
  </section>
  <section data-testid="import-step-map" hidden>
    <h2>Step 2: map the columns</h2>
    <p><label for="map-name">Name column</label>
       <select id="map-name" data-testid="map-name"></select></p>
    <p><label for="map-email">Email column</label>
       <select id="map-email" data-testid="map-email"></select></p>
    <p><button type="button" data-testid="import-map-continue" data-continue="after-map">Continue</button></p>
  </section>
${extraSections}
  <section data-testid="import-step-confirm" hidden>
    <h2>Step ${extra + 3}: confirm the import</h2>
    <p>Contacts found: <span data-testid="import-count">0</span>.</p>
    <p><button type="button" data-testid="import-confirm"${importDisabled}>Import</button></p>
  </section>
  <section data-testid="import-step-result" hidden>
    <h2>Imported contacts</h2>
    <ul data-testid="imported-list"></ul>
  </section>
</div>
<script>
(function () {
  var extra = ${extra};
  var current = 0;
  var contacts = [];
  function show(testid) {
    var ids = ['import-step-source', 'import-step-map', 'import-step-confirm', 'import-step-result'];
    for (var i = 1; i <= extra; i++) ids.push('import-extra-' + i);
    ids.forEach(function (id) {
      var el = document.querySelector('[data-testid="' + id + '"]');
      if (el) el.hidden = id !== testid;
    });
  }
  function parseCsv(text) {
    var lines = text.split(/\\r?\\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l !== ''; });
    if (lines.length === 0) return { headers: [], rows: [] };
    var headers = lines[0].split(',').map(function (h) { return h.trim(); });
    var rows = lines.slice(1).map(function (line) {
      var cells = line.split(',').map(function (c) { return c.trim(); });
      return headers.map(function (_, i) { return cells[i] === undefined ? '' : cells[i]; });
    });
    return { headers: headers, rows: rows };
  }
  function fillSelects(headers) {
    ['map-name', 'map-email'].forEach(function (id) {
      var sel = document.querySelector('[data-testid="' + id + '"]');
      sel.innerHTML = headers.map(function (h, i) {
        return '<option value="' + i + '">' + h.replace(/[<>&]/g, '') + '</option>';
      }).join('');
    });
    var nameIndex = 0;
    var emailIndex = headers.length > 1 ? 1 : 0;
    headers.forEach(function (h, i) {
      if (/name/i.test(h)) nameIndex = i;
      if (/e-?mail/i.test(h)) emailIndex = i;
    });
    document.querySelector('[data-testid="map-name"]').value = String(nameIndex);
    document.querySelector('[data-testid="map-email"]').value = String(emailIndex);
  }
  function collect() {
    var nameIndex = Number(document.querySelector('[data-testid="map-name"]').value);
    var emailIndex = Number(document.querySelector('[data-testid="map-email"]').value);
    contacts = window.__acmeRows.map(function (r) {
      return { name: r[nameIndex] === undefined ? '' : r[nameIndex], email: r[emailIndex] === undefined ? '' : r[emailIndex] };
    });
  }
  function advanceAfterMap() {
    if (extra > 0) { show('import-extra-1'); } else { collect(); show('import-step-confirm'); document.querySelector('[data-testid="import-count"]').textContent = String(contacts.length); }
  }
  document.querySelector('[data-testid="import-continue"]').addEventListener('click', function () {
    var parsed = parseCsv(document.querySelector('[data-testid="csv-text"]').value);
    window.__acmeHeaders = parsed.headers;
    window.__acmeRows = parsed.rows;
    fillSelects(parsed.headers);
    show('import-step-map');
  });
  document.querySelector('[data-testid="csv-file"]').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { document.querySelector('[data-testid="csv-text"]').value = String(reader.result); };
    reader.readAsText(file);
  });
  document.querySelector('[data-testid="import-map-continue"]').addEventListener('click', function () { advanceAfterMap(); });
  for (var i = 1; i <= extra; i++) {
    (function (n) {
      document.querySelector('[data-testid="import-continue-' + n + '"]').addEventListener('click', function () {
        if (n < extra) { show('import-extra-' + (n + 1)); }
        else { collect(); show('import-step-confirm'); document.querySelector('[data-testid="import-count"]').textContent = String(contacts.length); }
      });
    })(i);
  }
  var confirm = document.querySelector('[data-testid="import-confirm"]');
  confirm.addEventListener('click', function () {
    if (confirm.disabled) return;
    collect();
    fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contacts: contacts }) })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        var list = document.querySelector('[data-testid="imported-list"]');
        list.innerHTML = result.contacts.map(function (c) {
          return '<li data-testid="imported-row">' + c.name + ' — ' + c.email + '</li>';
        }).join('');
        show('import-step-result');
      });
  });
})();
</script>`,
  );
};

// ── request plumbing ────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const send = (res, status, type, body) => {
  res.writeHead(status, { "content-type": type });
  res.end(body);
};
const json = (res, status, data) => send(res, status, "application/json", JSON.stringify(data));

/** The request handler for one variant, closing over a fresh in-memory store. */
function createHandler(variant) {
  const state = {
    profile: { name: "Ada Lovelace", email: "ada@example.com" },
    contacts: [
      { name: "Grace Hopper", email: "grace@example.com" },
      { name: "Alan Turing", email: "alan@example.com" },
    ],
    sent: [],
    imported: [],
  };

  return async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/") {
        return send(res, 200, "text/html; charset=utf-8", shell(
          "Home",
          `<h1>Acme CRM</h1><p>Choose a job:</p><ul>
<li><a href="/profile" data-testid="job-update-profile">Update my profile</a></li>
<li><a href="/contacts" data-testid="job-send-message">Send a message to a contact</a></li>
<li><a href="/import" data-testid="job-import-contacts">Import contacts from a CSV</a></li>
</ul>`,
        ));
      }
      if (req.method === "GET" && path === "/profile") return send(res, 200, "text/html; charset=utf-8", profilePage(state));
      if (req.method === "GET" && path === "/contacts") return send(res, 200, "text/html; charset=utf-8", contactsPage(state, variant));
      if (req.method === "GET" && path === "/import") return send(res, 200, "text/html; charset=utf-8", importPage(variant));

      if (req.method === "PUT" && path === "/api/profile") {
        // Seeded defect j1-5xx: the store rejects the save, but the page already said "Saved".
        if (variant === "j1-5xx") return json(res, 500, { ok: false, error: "profile store unavailable" });
        const body = JSON.parse((await readBody(req)) || "{}");
        if (typeof body.name === "string") state.profile.name = body.name;
        if (typeof body.email === "string") state.profile.email = body.email;
        return json(res, 200, { ok: true, profile: state.profile });
      }

      if (req.method === "POST" && path === "/api/messages") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const message = { to: String(body.to ?? ""), body: String(body.body ?? "") };
        // #645 j2-phantom: answers success but stores nothing — the job only looks done.
        if (variant !== "j2-phantom") state.sent.push(message);
        return json(res, 200, { ok: true, ...message });
      }

      if (req.method === "POST" && path === "/api/import") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const contacts = Array.isArray(body.contacts) ? body.contacts : [];
        // #645 j3-phantom: answers success but writes nothing — the job only looks done.
        if (variant !== "j3-phantom") {
          state.imported.push(...contacts);
          // Imported contacts join the contact list, as in any CRM: the clean variant must be clean
          // end to end (a run that checks Contacts after importing finds them there).
          state.contacts.push(...contacts.filter((c) => c && typeof c.email === "string").map((c) => ({ name: String(c.name ?? c.email), email: c.email })));
        }
        return json(res, 200, { ok: true, contacts });
      }

      return send(res, 404, "text/html; charset=utf-8", shell("Not found", `<h1>Not found</h1><p>${esc(path)}</p>`));
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  };
}

/**
 * Start one variant on 127.0.0.1 and resolve with its URL and an idempotent `close`.
 * Throws on an unknown variant so a mislabelled cell fails loudly rather than running "clean".
 */
export function startAccuracyLab({ variant = "clean", port = 0 } = {}) {
  if (!VARIANTS.includes(variant)) {
    throw new Error(`unknown variant ${JSON.stringify(variant)}; one of ${VARIANTS.join(", ")}`);
  }
  const server = createServer(createHandler(variant));
  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolveStart({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

/** CLI: the harness waits for `ACME_CRM_LISTENING <port> variant=<v>` on stdout. */
function main() {
  const argValue = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const port = Number(argValue("--port") ?? "0");
  const variant = argValue("--variant") ?? "clean";
  if (!VARIANTS.includes(variant)) {
    process.stderr.write(`unknown variant ${JSON.stringify(variant)}; one of ${VARIANTS.join(", ")}\n`);
    process.exit(2);
  }
  startAccuracyLab({ variant, port }).then(({ port: actual }) => {
    process.stdout.write(`ACME_CRM_LISTENING ${actual} variant=${variant}\n`);
  }, (err) => {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
