import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { encodeClaudeProjectDir } from '@main/platform';
import type { ClaudeJsonlDiscoveryHost } from './jsonl-discovery-core';

export const desktopClaudeJsonlDiscoveryHost: ClaudeJsonlDiscoveryHost = {
  transcriptPath: (cwd, sessionId) => join(
    homedir(),
    '.claude',
    'projects',
    encodeClaudeProjectDir(cwd),
    `${sessionId}.jsonl`,
  ),
  pathExists: (path) => existsSync(path),
  pathMtimeMs: (path) => statSync(path).mtimeMs,
};
