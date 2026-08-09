import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  ClaudeGatewayPaths,
  ClaudeGatewayProfileHost,
} from './gateway-profiles-core';

export function defaultDesktopClaudeGatewayPaths(): ClaudeGatewayPaths {
  return {
    gatewaysDir: join(homedir(), '.claude', 'gateways'),
  };
}

export const desktopClaudeGatewayProfileHost: ClaudeGatewayProfileHost = {
  joinPath: (directory, name) => join(directory, name),
  listDirectory: (directory) =>
    readdirSync(directory, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
  isFile: (path) => statSync(path).isFile(),
  pathExists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf8'),
};
