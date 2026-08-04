import { describe, expect, it } from 'vitest';

import { hostQualifiedCacheKey, type HostQualifiedIdentity } from './identity';

const IDENTITY: HostQualifiedIdentity = {
  profileId: 'profile',
  topology: 'relay',
  instanceId: 'relay-a',
  authoritativeCoreId: 'worker-a',
  authoritativeCoreGeneration: 2,
};

describe('host-qualified cache keys', () => {
  it('uses UTF-8 byte length prefixes and rejects wire controls', () => {
    expect(hostQualifiedCacheKey(IDENTITY, '😀', 'entity')).toContain('4:😀');
    for (const control of ['\t', '\u0001', '\u007f', '\u0085', '\u2028', '\u2029']) {
      expect(() => hostQualifiedCacheKey(IDENTITY, `bad${control}namespace`, 'entity')).toThrowError(
        'wire controls',
      );
      expect(() => hostQualifiedCacheKey(IDENTITY, 'namespace', `bad${control}entity`)).toThrowError(
        'wire controls',
      );
    }
  });
});
