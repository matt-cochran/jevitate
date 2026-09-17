import type { BrowserPort } from "@doit/playwright";
import type { ActionRegistry } from "@doit/site-sdk";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";

export interface RunRequest {
  site: string;
  account: string;
  actionId: string;
  version: string;
  input: unknown;
  profileDir: string;
  baseUrl: string;
  headless: boolean;
  allowedOrigins: string[];
}

export interface RunResult {
  output: unknown;
}

export class ActionRunner {
  constructor(
    private readonly browser: BrowserPort,
    private readonly registry: ActionRegistry,
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const action = this.registry.resolve(req.site, req.actionId, req.version);
    const input = action.input.parse(req.input);
    const session = await this.browser.open({
      profileDir: req.profileDir,
      headless: req.headless,
      allowedOrigins: req.allowedOrigins,
      baseUrl: req.baseUrl,
    });
    try {
      const actor = CastActor.named(req.account).whoCan(new BrowseTheWeb(session, req.allowedOrigins));
      const raw = await action.execute(actor, input);
      return { output: action.output.parse(raw) };
    } finally {
      await session.close();
    }
  }
}
