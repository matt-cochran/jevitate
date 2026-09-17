import type { Page } from "playwright";

export interface BrowserSession {
  readonly page: Page;
  startTracing(): Promise<void>;
  stopTracingToFile(file: string): Promise<void>;
  close(): Promise<void>;
}

export interface OpenOptions {
  profileDir: string;
  headless: boolean;
  /** TODO(M3): inert until route-level enforcement lands — not yet a navigation guard. */
  allowedOrigins: string[];
  baseUrl: string;
}

export interface BrowserPort {
  open(opts: OpenOptions): Promise<BrowserSession>;
}
