import { afterAll, beforeAll, expect, test } from "vitest";
import { startServer } from "./index.js";

let buggy: { url: string; close(): Promise<void> };
let fixed: { url: string; close(): Promise<void> };
beforeAll(async () => {
  buggy = await startServer();
  fixed = await startServer(0, { demo: { fixed: true } });
});
afterAll(async () => {
  await buggy.close();
  await fixed.close();
});

const save = (base: string, displayName: string) =>
  fetch(`${base}/demo/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName, email: "ada@example.test" }),
  });

test("the demo profile page renders a form with a Save button", async () => {
  const html = await (await fetch(`${buggy.url}/demo/profile`)).text();
  expect(html).toContain("<form");
  expect(html).toContain('aria-label="Display name"');
  expect(html).toContain(">Save</button>");
});

test("a plain display name saves", async () => {
  const res = await save(buggy.url, "Ada Lovelace");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, displayName: "Ada Lovelace" });
});

test("the saved profile is readable, and a failed save leaves it unchanged", async () => {
  await save(buggy.url, "Grace Hopper");
  await save(buggy.url, "Zoë 😀");
  expect(await (await fetch(`${buggy.url}/demo/api/profile`)).json()).toMatchObject({ displayName: "Grace Hopper" });
});

test("empty and over-long names are refused with a 4xx, by design", async () => {
  expect((await save(buggy.url, "")).status).toBe(400);
  expect((await save(buggy.url, "x".repeat(200))).status).toBe(400);
});

test("the planted bug: a name outside Latin-1 returns HTTP 500", async () => {
  expect((await save(buggy.url, "Zoë 😀")).status).toBe(500);
});

test("with the fix switched on, the same name saves", async () => {
  expect((await save(fixed.url, "Zoë 😀")).status).toBe(200);
});
