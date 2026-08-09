import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GatewaySandboxSettingsHost } from './gateway-sandbox-settings-core';

export const desktopGatewaySandboxSettingsHost: GatewaySandboxSettingsHost = {
  readSettingsText: (path) => readFileSync(path, 'utf8'),
  materializeDerivedSettings: (serializedSettings) => {
    const temporaryDir = mkdtempSync(
      join(tmpdir(), 'agent-deck-claude-gateway-settings-'),
    );
    try {
      chmodSync(temporaryDir, 0o700);
      const settingsPath = join(temporaryDir, 'settings.json');
      writeFileSync(settingsPath, serializedSettings, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      return {
        settingsPath,
        cleanup: () => {
          try {
            rmSync(temporaryDir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup must not alter provider/session lifecycle.
          }
        },
      };
    } catch (error) {
      try {
        rmSync(temporaryDir, { recursive: true, force: true });
      } catch {
        // Preserve the preparation error.
      }
      throw error;
    }
  },
};
