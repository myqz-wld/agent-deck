import { realpathSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { getClaudeConfigRoot } from './fork-session';
import { resolveClaudeGatewayProfile } from './gateway-profiles';
import type { ClaudeGatewayForkSafetyHost } from './gateway-fork-safety-core';

function comparableConfigRoot(configRoot: string): string {
  const absolute = resolve(configRoot);
  try {
    return normalize(realpathSync(absolute)).normalize('NFC');
  } catch {
    return normalize(absolute).normalize('NFC');
  }
}

export const desktopClaudeGatewayForkSafetyHost: ClaudeGatewayForkSafetyHost = {
  getMainConfigRoot: (env) => getClaudeConfigRoot(env),
  resolveGatewayProfile: (gateway, paths) => resolveClaudeGatewayProfile(gateway, paths),
  canonicalizeConfigRoot: (configRoot) => comparableConfigRoot(configRoot),
};
