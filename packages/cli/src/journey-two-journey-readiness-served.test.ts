import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #608/#609 end to end — the complete fictional two-journey objective through the CLI against a
 * local app: `open-comment-conversation` (draft) discovers the selected thread/account and returns
 * a typed `bizops-comment@1` record; `prepare-comment-reply` (draft, prepare-only) reopens it,
 * checks the observed account/thread/comment/context, and fills the exact multiline reply without
 * ever clicking Send. The server counts every write; no approval is granted or faked.
 */

const THREADS: Record<string, { commentId: string; text: string }> = {
  "thread-001": { commentId: "c-1001", text: "Will the panels arrive by Tuesday?" },
  "thread-002": { commentId: "c-2002", text: "Can I change the delivery address?" },
  "thread-003": { commentId: "c-3003", text: "Is the warranty transferable?" },
};

const page = `<!doctype html><html><head><title>Conversations</title></head><body><main>
  <h1>Conversations</h1>
  <label>Thread <select aria-label="Thread">
    ${Object.keys(THREADS).map((id) => `<option value="${id}">${id}</option>`).join("")}
  </select></label>
  <label>Reply as <select aria-label="Reply as">
    <option value="mcpl">mcpl</option>
    <option value="personal">personal</option>
    <option value="ops">ops</option>
  </select></label>
  <button type="button" id="open">Open</button>
  <section id="thread" data-threadid="" data-account=""></section>
  <label>Reply <textarea aria-label="Reply"></textarea></label>
  <button type="button" id="send">Send</button>
  <script>
    // BROWSER CODE
    const THREADS = ${JSON.stringify(THREADS)};
    const thread = document.querySelector('select[aria-label="Thread"]');
    const account = document.querySelector('select[aria-label="Reply as"]');
    const view = document.getElementById("thread");
    const composer = document.querySelector("textarea");
    document.getElementById("open").addEventListener("click", () => {
      const t = THREADS[thread.value];
      view.setAttribute("data-threadid", thread.value);
      view.setAttribute("data-account", account.value);
      view.innerHTML = "";
      const article = document.createElement("article");
      article.className = "comment";
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.setAttribute("data-commentid", t.commentId);
      meta.setAttribute("data-account", account.value);
      meta.setAttribute("data-threadid", thread.value);
      meta.setAttribute("data-permalink", "/c/" + t.commentId);
      meta.textContent = t.commentId;
      const source = document.createElement("p");
      source.className = "source";
      source.textContent = t.text;
      article.append(meta, source);
      view.append(article);
    });
    // A read-only draft mirror (GET) so the test can read back exactly what the composer holds.
    composer.addEventListener("input", () => {
      const q = new URLSearchParams({ thread: view.getAttribute("data-threadid"), account: view.getAttribute("data-account"), text: composer.value });
      fetch("/api/draft?" + q.toString());
    });
    document.getElementById("send").addEventListener("click", () => {
      fetch("/api/replies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread: thread.value, text: composer.value }) });
    });
  </script>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
let journeysDir: string;
let catalogDir: string;
/** Every request the app received, in order. */
const requests: { method: string; path: string }[] = [];
/** The composer's last mirrored value per `<thread>|<account>`. */
const drafts = new Map<string, string>();

const PRODUCER = "open-comment-conversation";
const CONSUMER = "prepare-comment-reply";
const CONTRACT = "bizops-comment@1";

const REPLY_1 = "Thanks!\n\nWe'll follow up Tuesday.";
const REPLY_2 = "Hi,\nthe address can change until Friday.\n\n— Support";

function producer(): Journey {
  return {
    metadata: {
      id: PRODUCER,
      name: "Open a comment conversation",
      goal: "Open the selected conversation as the selected reply identity and return its comment record",
      successCriteria: [{ description: "The selected thread is open for the selected account" }],
      job: "reply-to-comment",
      persona: "community-manager",
      promoted: false,
      params: ["threadId", "replyIdentity"],
      anchors: [{ name: "thread-open", step: 4, stepId: "s-open01" }],
      createdAtIso: "2026-10-19T00:00:00.000Z",
      outputs: {
        contract: CONTRACT,
        collection: "records",
        key: ["commentId", "account"],
        fields: {
          commentId: { type: "id" },
          account: { type: "id" },
          threadId: { type: "id" },
          sourceText: { type: "text" },
          permalink: { type: "path" },
        },
      },
      endState: [
        { kind: "page", assertion: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } } },
        { kind: "page", assertion: { kind: "valueEquals", target: { label: "Reply as" }, value: { var: "replyIdentity" } } },
      ],
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/conversations",
          steps: [
            { objective: "Open the conversations inbox", step: { kind: "navigate", url: "/conversations", expect: { kind: "textIncludes", target: { css: "h1" }, text: "Conversations" } } },
            {
              objective: "Choose the requested thread",
              variableName: "threadId",
              step: { kind: "select", target: { label: "Thread" }, value: { var: "threadId" }, expect: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } } },
            },
            {
              objective: "Choose the requested reply identity",
              variableName: "replyIdentity",
              step: { kind: "select", target: { label: "Reply as" }, value: { var: "replyIdentity" }, expect: { kind: "valueEquals", target: { label: "Reply as" }, value: { var: "replyIdentity" } } },
            },
            {
              objective: "Open the thread and confirm the handoff is the requested thread",
              stepId: "s-open01",
              step: { kind: "click", target: { role: "button", name: "Open" }, expect: { kind: "attr", target: { css: "#thread" }, name: "data-threadid", value: { var: "threadId" } } },
            },
            {
              objective: "Return the open comment as a typed record",
              step: {
                kind: "forEach",
                items: { css: "#thread article.comment" },
                as: "records",
                steps: [
                  { kind: "extract", target: { css: ".meta" }, as: "commentId", attr: "data-commentid", expect: { kind: "attr", target: { css: ".meta" }, name: "data-commentid" } },
                  { kind: "extract", target: { css: ".meta" }, as: "account", attr: "data-account", expect: { kind: "attr", target: { css: ".meta" }, name: "data-account" } },
                  { kind: "extract", target: { css: ".meta" }, as: "threadId", attr: "data-threadid", expect: { kind: "attr", target: { css: ".meta" }, name: "data-threadid" } },
                  { kind: "extract", target: { css: ".meta" }, as: "permalink", attr: "data-permalink", expect: { kind: "attr", target: { css: ".meta" }, name: "data-permalink" } },
                  { kind: "extract", target: { css: ".source" }, as: "sourceText", expect: { kind: "attr", target: { css: ".meta" }, name: "data-commentid" } },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}

function consumer(): Journey {
  return {
    metadata: {
      id: CONSUMER,
      name: "Prepare a comment reply",
      goal: "Reopen the discovered comment as its account and prepare the approved reply without sending it",
      successCriteria: [{ description: "The composer holds the exact approved reply for the right thread and account, and nothing was sent" }],
      job: "reply-to-comment",
      persona: "community-manager",
      promoted: false,
      params: ["threadId", "replyIdentity", "expected_commentid", "expected_account", "expected_sourcetext", "replyText"],
      anchors: [{ name: "reply-prepared", step: 8, stepId: "s-fill01" }],
      // #609: the pre-fill context checks are intentional defenses against a wrong thread/account —
      // declared, so a targeted proof may relax them (one at a time) to prove the end state too.
      mutationPairs: [
        { check: "step:5", mustFailWhen: "swap-param:replyIdentity" },
        { check: "step:6", mustFailWhen: "swap-param:threadId" },
        { check: "step:7", mustFailWhen: "swap-param:threadId" },
      ],
      createdAtIso: "2026-10-19T00:00:00.000Z",
      inputs: {
        accepts: CONTRACT,
        request: { fields: { commentId: { type: "id" }, account: { type: "id" }, replyText: { type: "text" } }, key: ["commentId", "account"] },
        bindings: {
          threadId: { record: "threadId" },
          replyIdentity: { record: "account" },
          expected_commentid: { record: "commentId" },
          expected_account: { record: "account" },
          expected_sourcetext: { record: "sourceText" },
          replyText: { request: "replyText" },
        },
      },
      boundary: {
        kind: "prepare-only",
        stopBefore: { target: { role: "button", name: "Send" }, label: "Send" },
        nextStep: "A person reads the prepared reply and clicks Send in the app.",
      },
      endState: [
        { kind: "page", assertion: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } } },
        { kind: "page", assertion: { kind: "valueEquals", target: { label: "Reply as" }, value: { var: "replyIdentity" } } },
        { kind: "page", assertion: { kind: "valueEquals", target: { label: "Reply" }, value: { var: "replyText" } } },
      ],
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/conversations",
          steps: [
            { objective: "Open the conversations inbox", step: { kind: "navigate", url: "/conversations", expect: { kind: "textIncludes", target: { css: "h1" }, text: "Conversations" } } },
            {
              objective: "Choose the record's thread",
              variableName: "threadId",
              step: { kind: "select", target: { label: "Thread" }, value: { var: "threadId" }, expect: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } } },
            },
            {
              objective: "Choose the record's account as the reply identity",
              variableName: "replyIdentity",
              step: { kind: "select", target: { label: "Reply as" }, value: { var: "replyIdentity" }, expect: { kind: "valueEquals", target: { label: "Reply as" }, value: { var: "replyIdentity" } } },
            },
            {
              objective: "Reopen the thread and confirm it is the record's thread",
              step: { kind: "click", target: { role: "button", name: "Open" }, expect: { kind: "attr", target: { css: "#thread" }, name: "data-threadid", value: { var: "threadId" } } },
            },
            { objective: "Confirm the observed account before touching the composer", step: { kind: "assert", check: { kind: "attr", target: { css: "#thread" }, name: "data-account", value: { var: "expected_account" } } } },
            { objective: "Confirm the observed comment before touching the composer", step: { kind: "assert", check: { kind: "attr", target: { css: "#thread .meta" }, name: "data-commentid", value: { var: "expected_commentid" } } } },
            { objective: "Confirm the comment's context before touching the composer", step: { kind: "assert", check: { kind: "textIncludes", target: { css: "#thread .source" }, text: { var: "expected_sourcetext" } } } },
            {
              objective: "Prepare the exact approved reply",
              stepId: "s-fill01",
              variableName: "replyText",
              step: { kind: "fill", target: { label: "Reply" }, value: { var: "replyText" }, expect: { kind: "valueEquals", target: { label: "Reply" }, value: { var: "replyText" } } },
            },
          ],
        },
      ],
    },
  };
}

async function cli(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager(join(dir, "profiles")),
    journeysDir,
    catalogDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    environmentsFile: join(dir, "no-environments.json"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(dir, "no-targets.json") },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), exitCode };
}

type Envelope = { ok?: boolean; data?: any; error?: { code: string; message: string } };
const envelope = (out: string): Envelope => JSON.parse(out.trim().split("\n").pop() ?? "{}") as Envelope;

async function requestsFile(name: string, lines: readonly Record<string, string>[]): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

interface Selection {
  readonly threadId: string;
  readonly account: string;
  readonly commentId: string;
  readonly reply: string;
}

const SELECTIONS: readonly Selection[] = [
  { threadId: "thread-001", account: "mcpl", commentId: "c-1001", reply: REPLY_1 },
  { threadId: "thread-002", account: "personal", commentId: "c-2002", reply: REPLY_2 },
];

/** The params the chain binds for the consumer from the record + request (the documented bindings). */
const consumerParams = (s: Selection): string[] => [
  `threadId=${s.threadId}`,
  `replyIdentity=${s.account}`,
  `expected_commentid=${s.commentId}`,
  `expected_account=${s.account}`,
  `expected_sourcetext=${THREADS[s.threadId]!.text}`,
  `replyText=${s.reply}`,
];

const paramFlags = (kvs: readonly string[]): string[] => kvs.flatMap((kv) => ["--param", kv]);

let chains: { env: Envelope; exitCode: number | undefined; draft: string | undefined }[];
let missing: { env: Envelope; requestsReached: number };
let replay: Envelope;
let verifyProducer: Envelope;
let verifyConsumer: Envelope;
let prove: Envelope;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    requests.push({ method: req.method ?? "GET", path: url.pathname });
    if (req.method === "POST" && url.pathname === "/api/replies") {
      res.writeHead(201, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (url.pathname === "/api/draft") {
      drafts.set(`${url.searchParams.get("thread")}|${url.searchParams.get("account")}`, url.searchParams.get("text") ?? "");
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/conversations") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-two-journey-"));
  catalogDir = join(dir, ".jevitate");
  journeysDir = join(catalogDir, "journeys");
  await mkdir(catalogDir, { recursive: true });
  // Draft (unapproved) catalog entries: approval stays a person's call.
  await writeFile(join(catalogDir, "personas.json"), JSON.stringify([{ name: "community-manager", description: "answers comments for the brand accounts", role: "community-manager" }]));
  await writeFile(
    join(catalogDir, "jobs.json"),
    JSON.stringify([{ id: "reply-to-comment", trigger: "an approved reply exists for an open comment", motivation: "answer the commenter as the right account", outcome: "the reply is prepared for a person to send", personas: ["community-manager"] }]),
  );
  const store = new FsJourneyStore(journeysDir);
  await store.put(producer());
  await store.put(consumer());

  chains = [];
  for (const [i, s] of SELECTIONS.entries()) {
    const file = await requestsFile(`requests-${i}.jsonl`, [{ commentId: s.commentId, account: s.account, replyText: s.reply }]);
    const r = await cli(["journey", "chain", "--from", PRODUCER, "--to", CONSUMER, ...paramFlags([`threadId=${s.threadId}`, `replyIdentity=${s.account}`]), "--requests", file, "--allow-draft", "--json"]);
    chains.push({ env: envelope(r.out), exitCode: r.exitCode, draft: drafts.get(`${s.threadId}|${s.account}`) });
  }

  const before = requests.length;
  const m = await cli(["journey", "chain", "--from", PRODUCER, "--to", CONSUMER, "--param", "threadId=thread-001", "--requests", join(dir, "requests-0.jsonl"), "--allow-draft", "--json"]);
  missing = { env: envelope(m.out), requestsReached: requests.length - before };

  const selection = SELECTIONS[0]!;
  const readinessArgs = (mode: string): string[] => [
    "journey", "readiness", PRODUCER, "--with", CONSUMER, "--mode", mode, "--base-url", origin,
    ...paramFlags([`threadId=${selection.threadId}`, `replyIdentity=${selection.account}`]),
    "--requests", join(dir, "requests-0.jsonl"), "--json",
  ];
  replay = envelope((await cli(readinessArgs("replay"))).out);
  verifyProducer = envelope((await cli(["journey", "verify", PRODUCER, "--mutate", ...paramFlags([`threadId=${selection.threadId}`, `replyIdentity=${selection.account}`]), "--json"])).out);
  verifyConsumer = envelope((await cli(["journey", "verify", CONSUMER, "--mutate", ...paramFlags(consumerParams(selection)), "--json"])).out);
  prove = envelope((await cli(readinessArgs("prove"))).out);
}, 1_800_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const checkOf = (receipt: Envelope, check: string, journey: string): any => receipt.data?.checks?.find((c: { check: string; journey: string }) => c.check === check && c.journey === journey);

describe("two-journey discover → prepare-only reply, end to end (#608, #609, served)", () => {
  it.each([0, 1])("journey chain for selection %i runs every matched request ok", (i) => {
    expect(chains[i]!.env.data?.runs?.map((r: { outcome: string }) => r.outcome)).toEqual(["ok"]);
  });

  it.each([0, 1])("journey chain for selection %i exits 0", (i) => {
    expect(chains[i]!.exitCode ?? 0).toBe(0);
  });

  it.each([0, 1])("journey chain for selection %i leaves the composer holding the exact multiline reply", (i) => {
    expect(chains[i]!.draft).toBe(SELECTIONS[i]!.reply);
  });

  it.each([0, 1])("journey chain for selection %i stamps the run with the producer's contract", (i) => {
    expect(chains[i]!.env.data?.runs?.[0]?.contract).toBe(CONTRACT);
  });

  it("no run (chain, replay or mutation proof) ever sent a write to the app", () => {
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("a missing producer param is refused with E_CHAIN_PARAMS", () => {
    expect(missing.env.error?.code).toBe("E_CHAIN_PARAMS");
  });

  it("a missing producer param opens no page: no request reaches the app", () => {
    expect(missing.requestsReached).toBe(0);
  });

  it("readiness replay passes the pair's replay check (no param mismatch)", () => {
    expect(checkOf(replay, "replay", PRODUCER)?.state).toBe("pass");
  });

  it("journey verify --mutate proves the producer conclusively", () => {
    expect(verifyProducer.data?.verdict).toBe("proven");
  });

  it("journey verify --mutate proves the consumer conclusively with its bound params", () => {
    expect(verifyConsumer.data?.verdict).toBe("proven");
  });

  it("the layered defenses are proven independently through a targeted proof (relaxedSites)", () => {
    const relaxed = [...(verifyProducer.data?.assertions ?? []), ...(verifyConsumer.data?.assertions ?? [])].filter((a: { relaxedSites?: string[] }) => (a.relaxedSites?.length ?? 0) > 0);
    expect(relaxed.length).toBeGreaterThan(0);
  });

  it.each([PRODUCER, CONSUMER])("readiness prove passes the proof check of %s", (id) => {
    expect(checkOf(prove, "proof", id)?.state).toBe("pass");
  });

  it("readiness prove reports no proof blocker", () => {
    expect(prove.data?.blockers?.filter((b: { check: string }) => b.check === "proof")).toEqual([]);
  });

  it("readiness prove passes the pair's replay check", () => {
    expect(checkOf(prove, "replay", CONSUMER)?.state).toBe("pass");
  });

  // Remaining blocker (reported, not worked around): `review-strict` restates the draft catalog links —
  // which the `catalog` check already lists as awaiting a person — as a strict blocker. No approval is faked.
  it("readiness prove is blocked only by review-strict restating the unvetted (draft) catalog links", () => {
    const why = (prove.data?.blockers ?? []).map((b: { check: string; why: string }) => `${b.check}: ${b.why.split("; ").filter((t) => !/^(Unvetted catalog links|its links are not approved): /.test(t)).join("; ")}`);
    expect(why).toEqual([`review-strict: `, `review-strict: `]);
  });

  it("readiness prove names promotion of both Journeys as awaiting a person", () => {
    expect(prove.data?.awaitingHuman?.filter((a: { check: string }) => a.check === "promotion").map((a: { journey: string }) => a.journey)).toEqual([PRODUCER, CONSUMER]);
  });
});
