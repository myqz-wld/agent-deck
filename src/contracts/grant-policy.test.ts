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
    expect(desktop.productMethods).not.toContain('project.resolve');
    expect(desktop.productMethods).not.toContain('node.assets.list');
    expect(desktop.channelMethods).toEqual(['desktop.broker.next', 'desktop.broker.respond']);
    expect(feishu.channelMethods).toEqual(['subscription.set']);
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
