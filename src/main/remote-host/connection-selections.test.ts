import { describe, expect, it } from 'vitest';

import { RemoteHostConnectionSelections } from './connection-selections';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nQUFBQQ==\n-----END OPENSSH PRIVATE KEY-----\n';
const CREDENTIAL = {
  schemaVersion: 1,
  kind: 'agent-deck-remote-connection-credential',
  label: 'Production',
  topology: 'relay',
  instanceId: 'instance-a',
  credentialId: 'desktop-a',
  endpoint: { hostname: 'relay.example.test', port: 22, username: 'agentdeck' },
  hostKeys: [{ algorithm: 'ssh-ed25519', publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH' }],
  identity: { algorithm: 'ssh-ed25519', privateKey: PRIVATE_KEY },
};

describe('RemoteHostConnectionSelections', () => {
  it('returns only a redacted preview and keeps internal fields main-owned', () => {
    const selections = new RemoteHostConnectionSelections({
      createId: () => 'opaque-selection',
      readFile: () => CREDENTIAL,
    });
    const preview = selections.capture('/private/connection.agentdeck-connection');

    expect(preview).toEqual({
      selectionId: 'opaque-selection',
      label: 'Production',
      endpoint: {
        ...CREDENTIAL.endpoint,
        hostKeyFingerprint: expect.stringMatching(/^SHA256:/),
      },
    });
    expect(JSON.stringify(preview)).not.toContain('instance-a');
    expect(JSON.stringify(preview)).not.toContain('desktop-a');
    expect(JSON.stringify(preview)).not.toContain('PRIVATE KEY');
    expect(selections.resolve(preview.selectionId)).toMatchObject({ topology: 'relay' });
  });

  it('expires and consumes selections', () => {
    let now = 1;
    const selections = new RemoteHostConnectionSelections({
      createId: () => 'selection-a', now: () => now, ttlMs: 10, readFile: () => CREDENTIAL,
    });
    const preview = selections.capture('/private/a');
    selections.consume(preview.selectionId);
    expect(() => selections.resolve(preview.selectionId)).toThrow('重新导入');
    const next = selections.capture('/private/b');
    now = 11;
    expect(() => selections.resolve(next.selectionId)).toThrow('重新导入');
  });
});
