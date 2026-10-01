import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { ScriptedJudge, withSession } from "../testkit.js";
import { capFormText } from "../fill.js";

/**
 * #285 — a `type` into a textarea must keep the value's line breaks: a "paste a list / CSV (one per
 * line)" field joined into one line is a different value (the app imports 0 rows instead of 3).
 */
const PAGE = `<!doctype html><html><body>
<label for="csv">Paste a CSV or list (one person per line: name, email)</label>
<textarea id="csv"></textarea>
<button type="button" id="imp" onclick="const rows=document.getElementById('csv').value.split('\\n').filter(l=>/^[^,]+,\\s*\\S+@\\S+$/.test(l.trim()));document.getElementById('out').textContent=rows.length+' added'">Import</button>
<p id="out"></p>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const LIST = "Alice Johnson, alice.johnson@example.com\nBrian Smith, brian.smith@example.com\nCatherine Lee, catherine.lee@example.com";

describe("type into a textarea keeps newlines (#285)", () => {
  it("capFormText keeps a multi-line value's lines (and still collapses a single-line one)", () => {
    expect(capFormText(`${LIST.replace(/\n/g, "\r\n")}\n`, 600, true)).toBe(LIST);
    expect(capFormText("a   b\t c\n\n\n\nd", 600, true)).toBe("a b c\n\nd");
    expect(capFormText(LIST, 600, false)).toBe(LIST.replace(/\n/g, " "));
    // Over the cap: cut at the last whole line that fits.
    expect(capFormText(LIST, 90, true)).toBe(LIST.split("\n").slice(0, 2).join("\n"));
  });

  it(
    "a goal run types every line into the served textarea and the app imports all of them",
    async () => {
      const result = await withSession(
        "textarea-lines-",
        async (session) => {
          const actor = CastActor.named("csv").whoCan(new BrowseTheWeb(session, [origin]));
          const r = await runGoalBasedMission({
            actor,
            judge: new ScriptedJudge([{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }]),
            gen: new FakeGenerationGateway({ "form.value": { text: LIST } }),
            goal: "Add three people at once to your participant list",
            allowlist: [origin],
            startUrl: `${origin}/`,
            successAssertion: { kind: "textIncludes", target: { css: "#out" }, text: "3 added" },
            oracleTimeoutMs: 2_000,
          });
          const typed = await session.page.locator("#csv").inputValue();
          return { r, typed };
        },
        origin,
      );
      expect(result.typed).toBe(LIST);
      expect(result.r.outcome).toBe("succeeded");
    },
    180_000,
  );
});
