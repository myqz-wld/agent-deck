import { describe, expect, it } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import {
  localSessionOptionKeys,
  remoteSessionOptionKeys,
  sessionOptionLabel,
} from './session-option-catalog';

describe('Local and Remote new-session option parity', () => {
  it.each([
    ['claude-code', true, false, false],
    ['codex-cli', false, false, false],
    ['grok-build', false, true, true],
  ] as const)(
    'keeps %s adapter-native controls aligned without cross-adapter fields',
    (adapterId, canSetPermissionMode, canSetSessionMode, hasSessionModes) => {
      const local = localSessionOptionKeys(adapterId, {
        canSetPermissionMode,
        canSetSessionMode,
        hasSessionModes,
      });
      const remote = remoteSessionOptionKeys(
        sessionConsoleCapabilitiesFixture(adapterId, '.'),
      );
      expect(remote).toEqual(local);
      expect(remote.map(sessionOptionLabel)).toEqual(local.map(sessionOptionLabel));
    },
  );

  it('returns no controls for a missing capability descriptor', () => {
    expect(remoteSessionOptionKeys(null)).toEqual([]);
  });
});
