import { buildServer } from "./server.js";

export { buildServer } from "./server.js";
export { SEED_THREADS } from "./data.js";

export async function startServer(port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const app = buildServer();
  await app.listen({ port, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("failed to bind");
  const url = `http://127.0.0.1:${addr.port}`;
  return { url, close: () => app.close() };
}
