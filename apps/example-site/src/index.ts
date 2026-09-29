import { buildServer, type ServerOptions } from "./server.js";

export { buildServer, EDITOR_BLOCKS, type ServerOptions } from "./server.js";
export { TENANCY_SESSIONS, type TenancyOptions } from "./tenancy.js";
export { type DemoOptions } from "./demo.js";
export { SEED_THREADS } from "./data.js";

export async function startServer(port = 0, opts: ServerOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  const app = buildServer(opts);
  await app.listen({ port, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("failed to bind");
  const url = `http://127.0.0.1:${addr.port}`;
  return { url, close: () => app.close() };
}
