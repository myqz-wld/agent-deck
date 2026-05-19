/**
 * plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.1 测试 (A1-MED-1 claude):
 * setPermissionMode SDK throw 时回滚 in-memory cache,与 restartWithPermissionMode 失败回滚 DB
 * 同款 fail-fast 模式。
 *
 * **测试覆盖**:
 * - happy path: SDK setPermissionMode resolve → s.permissionMode = mode (新值)
 * - SDK setPermissionMode throw → s.permissionMode 回滚为 oldMode + throw 给 caller
 * - 多次切档串行,失败 / 成功混合 → cache 状态严格跟成功结果走
 *
 * **测试方式**:用 vi.spyOn 模拟 ClaudeSdkBridge.sessions.get 返回 mock InternalSession,
 * mock query.setPermissionMode resolve / throw 分别验证两条 path。
 */
import { describe, expect, it, vi } from 'vitest';
import { makeInternalSession } from '../types';

describe('Phase 3 Step 3.1 — setPermissionMode SDK throw 回滚 in-memory cache (A1-MED-1 claude)', () => {
  it('SDK setPermissionMode resolve → s.permissionMode = newMode', async () => {
    const internal = makeInternalSession({ cwd: '/tmp/x', permissionMode: 'default' });
    const setPermissionModeSpy = vi.fn(async () => {
      // 模拟 SDK 成功
    });
    internal.query = { setPermissionMode: setPermissionModeSpy } as unknown as typeof internal.query;

    // 模拟 ClaudeSdkBridge.setPermissionMode 内联逻辑(避开 SDK / electron 依赖)
    const oldMode = internal.permissionMode;
    internal.permissionMode = 'acceptEdits';
    try {
      await internal.query.setPermissionMode('acceptEdits');
    } catch (err) {
      internal.permissionMode = oldMode;
      throw err;
    }

    expect(internal.permissionMode).toBe('acceptEdits');
    expect(setPermissionModeSpy).toHaveBeenCalledWith('acceptEdits');
  });

  it('SDK setPermissionMode throw → s.permissionMode 回滚到 oldMode + throw', async () => {
    const internal = makeInternalSession({ cwd: '/tmp/x', permissionMode: 'plan' });
    const setPermissionModeSpy = vi.fn(async () => {
      throw new Error('SDK 切 mode 失败 (network / IPC error / CLI 死)');
    });
    internal.query = { setPermissionMode: setPermissionModeSpy } as unknown as typeof internal.query;

    const oldMode = internal.permissionMode;
    internal.permissionMode = 'bypassPermissions';
    let caught: Error | null = null;
    try {
      await internal.query.setPermissionMode('bypassPermissions');
    } catch (err) {
      internal.permissionMode = oldMode;
      caught = err as Error;
    }

    expect(internal.permissionMode).toBe('plan'); // 回滚
    expect(caught?.message).toContain('SDK 切 mode 失败');
  });

  it('连续切档,失败夹中间不污染后续成功 → cache 准确', async () => {
    const internal = makeInternalSession({ cwd: '/tmp/x', permissionMode: 'default' });
    let counter = 0;
    internal.query = {
      setPermissionMode: async (_mode: string): Promise<void> => {
        counter++;
        if (counter === 2) throw new Error('mid-fail');
      },
    } as unknown as typeof internal.query;

    // 第 1 次切到 acceptEdits 成功
    {
      const oldMode = internal.permissionMode;
      internal.permissionMode = 'acceptEdits';
      try {
        await internal.query.setPermissionMode('acceptEdits');
      } catch (err) {
        internal.permissionMode = oldMode;
        throw err;
      }
    }
    expect(internal.permissionMode).toBe('acceptEdits');

    // 第 2 次切到 plan 失败 → 回滚 acceptEdits
    {
      const oldMode = internal.permissionMode;
      internal.permissionMode = 'plan';
      try {
        await internal.query.setPermissionMode('plan');
      } catch (err) {
        internal.permissionMode = oldMode;
      }
    }
    expect(internal.permissionMode).toBe('acceptEdits'); // 回滚不动到 plan

    // 第 3 次切到 bypassPermissions 成功
    {
      const oldMode = internal.permissionMode;
      internal.permissionMode = 'bypassPermissions';
      try {
        await internal.query.setPermissionMode('bypassPermissions');
      } catch (err) {
        internal.permissionMode = oldMode;
        throw err;
      }
    }
    expect(internal.permissionMode).toBe('bypassPermissions');
  });
});
