import { afterAll, beforeAll, expect, test } from "vitest";
import { startServer } from "./index.js";

let srv: { url: string; close(): Promise<void> };
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.close(); });

test("unauthenticated inbox redirects to login", async () => {
  const res = await fetch(`${srv.url}/inbox`, { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login");
});

test("login sets a cookie and whoami reports authenticated", async () => {
  const login = await fetch(`${srv.url}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=jane",
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const who = await fetch(`${srv.url}/whoami`, { headers: { cookie } });
  expect(await who.json()).toMatchObject({ authenticated: true });
});
