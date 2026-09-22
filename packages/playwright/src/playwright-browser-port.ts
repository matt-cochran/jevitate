import { chromium, type BrowserContext } from "playwright";
import type { BrowserPort, BrowserSession, OpenOptions } from "./browser-port.js";

export class PlaywrightBrowserPort implements BrowserPort {
  async open(opts: OpenOptions): Promise<BrowserSession> {
    // TODO(M3): enforce allowedOrigins via route interception; currently unenforced.
    const context: BrowserContext = await chromium.launchPersistentContext(opts.profileDir, {
      headless: opts.headless,
      baseURL: opts.baseUrl,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      page,
      async startTracing() {
        await context.tracing.start({ screenshots: true, snapshots: true });
      },
      async stopTracingToFile(file: string) {
        await context.tracing.stop({ path: file });
      },
      async close() {
        await context.close();
      },
    };
  }
}
