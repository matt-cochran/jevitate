import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ProfileStatus {
  name: string;
  dir: string;
  exists: boolean;
}

export class ProfileManager {
  constructor(private readonly rootDir: string) {}

  private dirFor(name: string): string {
    return join(this.rootDir, name);
  }

  async create(name: string): Promise<ProfileStatus> {
    const dir = this.dirFor(name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return { name, dir, exists: true };
  }

  async status(name: string): Promise<ProfileStatus> {
    const dir = this.dirFor(name);
    try {
      await stat(dir);
      return { name, dir, exists: true };
    } catch {
      return { name, dir, exists: false };
    }
  }
}
