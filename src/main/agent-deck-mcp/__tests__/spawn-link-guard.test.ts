/**
 * spawn-link-guard.ts 单测 —— plan hand-off-session-adopt-teammates-20260520 Phase 2 §D8。
 *
 * 纯函数 helper，无 mock 需求；3 path 守门 + invariant SSOT 防漂移。
 */

import { describe, it, expect } from 'vitest';
import { shouldWriteSpawnLink } from '../tools/handlers/spawn-link-guard';

describe('shouldWriteSpawnLink', () => {
  it('batonMode=true → false（baton 路径不写 spawn-link，REVIEW_39 方案 1 防御 invariant）', () => {
    expect(shouldWriteSpawnLink({ batonMode: true })).toBe(false);
  });

  it('batonMode=false → true（普通 spawn 派 reviewer 路径写 spawn-link，by design）', () => {
    expect(shouldWriteSpawnLink({ batonMode: false })).toBe(true);
  });

  it('batonMode=undefined → true（未传等同 false，普通 spawn 路径默认）', () => {
    expect(shouldWriteSpawnLink({})).toBe(true);
    expect(shouldWriteSpawnLink({ batonMode: undefined })).toBe(true);
  });
});
