import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getCodexHome } from './codex-home';
import type {
  CodexGatewayPaths,
  CodexGatewayProfileHost,
} from './gateway-profiles-core';

export function defaultDesktopCodexGatewayPaths(): CodexGatewayPaths {
  return {
    gatewaysDir: join(getCodexHome(), 'gateways'),
  };
}

export const desktopCodexGatewayProfileHost: CodexGatewayProfileHost = {
  joinPath: (directory, name) => join(directory, name),
  isFile: (path) => statSync(path).isFile(),
  pathExists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf8'),
};
