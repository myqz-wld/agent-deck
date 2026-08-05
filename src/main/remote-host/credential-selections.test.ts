import { describe, expect, it } from 'vitest';

import { RemoteHostCredentialSelections } from './credential-selections';

describe('RemoteHostCredentialSelections', () => {
  it('returns only an opaque purpose-bound token and expires captured paths', () => {
    let now = 10;
    const selections = new RemoteHostCredentialSelections({
      createId: () => 'opaque-token',
      now: () => now,
      ttlMs: 20,
      validateFile: () => undefined,
    });

    const dto = selections.capture('identity-file', '/private/id_ed25519');

    expect(dto).toEqual({ selectionId: 'opaque-token', kind: 'identity-file' });
    expect(JSON.stringify(dto)).not.toContain('/private');
    expect(() => selections.resolve('known-hosts-file', dto.selectionId)).toThrow('重新选择');
    expect(selections.resolve('identity-file', dto.selectionId)).toBe('/private/id_ed25519');
    now = 30;
    expect(() => selections.resolve('identity-file', dto.selectionId)).toThrow('重新选择');
  });

  it('consumes captured selections without exposing their local paths', () => {
    let next = 0;
    const selections = new RemoteHostCredentialSelections({
      createId: () => `token-${++next}`,
      validateFile: () => undefined,
    });
    const identity = selections.capture('identity-file', '/secret/key');
    const knownHosts = selections.capture('known-hosts-file', '/secret/known_hosts');

    selections.consume([identity.selectionId, knownHosts.selectionId]);

    expect(() => selections.resolve('identity-file', identity.selectionId)).toThrow();
    expect(() => selections.resolve('known-hosts-file', knownHosts.selectionId)).toThrow();
  });
});
