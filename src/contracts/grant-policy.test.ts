import { describe, expect, it } from 'vitest';

import {
  CHANNEL_INTERNAL_METHODS,
  REMOTE_OWNER_PRODUCT_V1_METHODS,
  UNGRANTED_REMOTE_CORE_METHODS,
  allCoreMethods,
  assertRemoteOwnerGrantForSurface,
  copyRemoteOwnerGrantClaim,
  decodeRemoteOwnerGrantClaim,
  encodeRemoteOwnerGrantClaim,
  issueRemoteOwnerGrantClaim,
} from './grant-policy';

describe('Remote Owner Product v1 grant policy', () => {
  it('decodes the preceding release grant without moving permissions or granting refresh', () => {
    // Captured from the 60-method revision-1 directory before appending component refresh.
    const decoded = decodeRemoteOwnerGrantClaim({ policy: 'Remote Owner Product v1', policyVersion: 1,
      policyRevision: 1, productBits: '8ffffffffffff77', channelBits: '300000000000000' });
    expect([...decoded.productMethods].sort()).toEqual(REMOTE_OWNER_PRODUCT_V1_METHODS.filter(
      method => method !== 'session.components.refresh').sort());
    expect(decoded.channelMethods).toEqual(['desktop.broker.next', 'desktop.broker.respond']);
    const feishu = decodeRemoteOwnerGrantClaim({ policy: 'Remote Owner Product v1', policyVersion: 1,
      policyRevision: 1, productBits: '8ffffffffffff77', channelBits: '000000000000088' });
    expect(feishu.channelMethods).toEqual(['subscription.set', 'feishu.assistants.register']);
  });
  it('classifies the complete Core method directory exactly once', () => {
    const groups = [
      REMOTE_OWNER_PRODUCT_V1_METHODS,
      CHANNEL_INTERNAL_METHODS.desktop,
      CHANNEL_INTERNAL_METHODS.feishu,
      UNGRANTED_REMOTE_CORE_METHODS,
    ];
    const classified = groups.flat();
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...allCoreMethods()].sort());
  });

  it('issues equal product grants and only surface-specific channel plumbing', () => {
    const desktop = issueRemoteOwnerGrantClaim('desktop');
    const feishu = issueRemoteOwnerGrantClaim('feishu');
    expect(desktop.productMethods).toEqual(feishu.productMethods);
    expect(desktop.productMethods).toContain('session.delete');
    expect(UNGRANTED_REMOTE_CORE_METHODS).toEqual(['system.health']);
    expect(desktop.channelMethods).toEqual(['desktop.broker.next', 'desktop.broker.respond']);
    expect(feishu.channelMethods).toEqual(['subscription.set', 'feishu.assistants.register']);
    expect(() => assertRemoteOwnerGrantForSurface(desktop, 'feishu')).toThrow('surface');
  });

  it('round-trips a detached immutable compact claim', () => {
    const source = issueRemoteOwnerGrantClaim('desktop');
    const decoded = decodeRemoteOwnerGrantClaim(encodeRemoteOwnerGrantClaim(source));
    const copied = copyRemoteOwnerGrantClaim(decoded);
    expect(copied).toEqual(source);
    expect(Object.isFrozen(copied)).toBe(true);
    expect(Object.isFrozen(copied.productMethods)).toBe(true);
    expect(Object.isFrozen(copied.channelMethods)).toBe(true);
  });
});
