import type { ActionDefinition } from "./action.js";

export class UnknownActionError extends Error {
  constructor(site: string, id: string, version: string) {
    super(`Unknown action: ${site}/${id}@${version}`);
    this.name = "UnknownActionError";
  }
}

type AnyAction = ActionDefinition<any, any>;

export class ActionRegistry {
  private readonly actions = new Map<string, AnyAction>();

  private key(site: string, id: string, version: string): string {
    return `${site}::${id}::${version}`;
  }

  register(site: string, def: AnyAction): void {
    this.actions.set(this.key(site, def.id, def.version), def);
  }

  resolve(site: string, id: string, version: string): AnyAction {
    const found = this.actions.get(this.key(site, id, version));
    if (!found) throw new UnknownActionError(site, id, version);
    return found;
  }
}
