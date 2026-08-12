import { describe, expect, it } from 'vitest';
import { parseSessionPermissionsGetResult } from './session-permissions';

const valid = {
  sessionId: 'session-a',
  adapterId: 'codex-cli',
  effective: {
    adapterId: 'codex-cli', approvalPolicy: 'never', approvalPolicySource: 'session',
    sandbox: 'workspace-write', sandboxSource: 'session',
  },
  workspace: { read: 'allowed', write: 'allowed', network: 'provider-default' },
  rules: { state: 'unavailable', items: [], omittedCount: 0, truncated: false },
  revision: 4,
} as const;

describe('session permissions contract', () => {
  it('accepts an exact path-free effective projection', () => {
    expect(parseSessionPermissionsGetResult(valid)).toEqual(valid);
  });

  it.each(['token', 'apiKey', 'credentialPath', 'raw', 'cwd', 'env', 'config', 'auth'])
  ('rejects forbidden or unknown deceptive key %s', (key) => {
    expect(() => parseSessionPermissionsGetResult({ ...valid, [key]: 'secret' })).toThrow();
  });

  it('rejects secret-shaped values even under an allowlisted Grok sandbox field', () => {
    expect(() => parseSessionPermissionsGetResult({
      ...valid,
      adapterId: 'grok-build',
      effective: {
        adapterId: 'grok-build', sessionMode: 'default', sessionModeSource: 'session',
        sandbox: 'xai-secretmarker123', sandboxSource: 'session',
      },
    })).toThrow();
  });
});
