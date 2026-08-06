import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Resolve the user-owned Codex home without loading plugin discovery or desktop diagnostics. */
export function getCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.codex');
}
