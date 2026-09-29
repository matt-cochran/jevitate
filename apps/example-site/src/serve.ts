import { startServer } from "./index.js";

/**
 * Serves the example site on a fixed port for the launch demo (docs/demo.md):
 * `pnpm --filter @jevitate/example-site demo`. `PORT` (default 5190) picks the port and
 * `DEMO_FIXED=1` turns on the fix for the `/demo/profile` planted bug. Loopback only.
 */
const port = Number(process.env.PORT ?? 5190);
const fixed = process.env.DEMO_FIXED === "1";
const srv = await startServer(port, { demo: { fixed } });
console.log(`example site: ${srv.url}/demo/profile (planted bug ${fixed ? "FIXED" : "present"}) — Ctrl+C to stop`);
const stop = (): void => {
  void srv.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
