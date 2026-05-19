/**
 * Phase 3 (deep-review-batch-a1-b-followup-r3-20260519, H3) 测试：translateSdkMessage 处理 SDK
 * status frame `permissionMode` 字段时，**先同步 internal cache 再走 DB 比对路径**。
 *
 * **修法理由**（详 sdk-message-translate.ts L181 jsdoc）：旧 impl 仅写 sessionRepo（DB） +
 * emit upsert，**没**同步 internal.permissionMode (canUseTool bypass 短路读 internal cache 不读
 * sessionRepo)。SDK 上行 init/status frame 把 mode 改为 bypassPermissions 等关键档位时,
 * canUseTool 仍按旧 cache 走 fail-secure → 弹 unwanted permission-request (CLI 实际已是 bypass
 * 但应用以为还在 default)。
 *
 * **不变量 2**：DB/UI ↔ internal cache 单一源（跨字段约束）— 凡 internal cache 镜像 sessionRepo
 * 字段，任一方向 update 必同时更新两边。本 step 修 permissionMode 路径。
 *
 * **测试覆盖** (3 case)：
 * - SDK status frame `permissionMode='bypassPermissions'` → internal.permissionMode 同步 +
 *   sessionRepo.setPermissionMode 调 + emit session-upserted
 * - SDK frame mode 与 DB cur 相同 → internal cache 仍同步 (即使 cur 相同也 set 内部 cache)，
 *   sessionRepo 不写 DB (no-op 跳过 emit)
 * - SDK frame 非白名单 mode (typo / 不支持) → internal cache 不变 + DB 不写
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { translateSdkMessage } from '../sdk-message-translate';
import { makeInternalSession } from '../types';
import type { AgentEvent } from '@shared/types';

// session-repo / event-bus mock
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(),
    setPermissionMode: vi.fn(),
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
  },
}));

import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';

beforeEach(() => {
  vi.mocked(sessionRepo.get).mockReset();
  vi.mocked(sessionRepo.setPermissionMode).mockReset();
  vi.mocked(eventBus.emit).mockReset();
});

describe('Phase 3 (H3) — translateSdkMessage status frame permissionMode 同步 internal cache + DB', () => {
  it('SDK status frame permissionMode=bypassPermissions → internal cache 同步 + DB 写 + emit upsert', () => {
    const internal = makeInternalSession({ cwd: '/tmp/h3-1', permissionMode: 'default' });
    expect(internal.permissionMode).toBe('default');

    // mock sessionRepo.get 返回 cur 是 default (与 next 不同 → 走完整 DB 写 + emit 路径)
    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({
        id: 'sid-h3-1',
        permissionMode: 'default',
      } as never)
      .mockReturnValueOnce({
        id: 'sid-h3-1',
        permissionMode: 'bypassPermissions',
      } as never);

    const emitted: AgentEvent[] = [];
    const e = (event: AgentEvent): void => {
      emitted.push(event);
    };

    translateSdkMessage(
      e,
      'sid-h3-1',
      { type: 'system', subtype: 'status', permissionMode: 'bypassPermissions' },
      internal,
    );

    // **核心断言**：internal cache 同步 (canUseTool 通过此读 mode)
    expect(internal.permissionMode).toBe('bypassPermissions');
    // DB 也同步
    expect(vi.mocked(sessionRepo.setPermissionMode)).toHaveBeenCalledWith(
      'sid-h3-1',
      'bypassPermissions',
    );
    // emit session-upserted
    const upsertedCalls = vi.mocked(eventBus.emit).mock.calls.filter(
      (call) => call[0] === 'session-upserted',
    );
    expect(upsertedCalls).toHaveLength(1);
  });

  it('SDK frame mode 与 cur 相同 → internal cache 仍同步 (no-op DB 跳过 emit)', () => {
    // 边界场景：cur 已经是 bypassPermissions，新 frame 也是 bypassPermissions → DB 不写
    // 但 internal cache 仍 set (修法：先 internal.permissionMode = next 再走 DB 比对)
    const internal = makeInternalSession({ cwd: '/tmp/h3-2', permissionMode: 'default' });

    vi.mocked(sessionRepo.get).mockReturnValueOnce({
      id: 'sid-h3-2',
      permissionMode: 'plan', // cur 与 next 相同
    } as never);

    const emitted: AgentEvent[] = [];
    const e = (event: AgentEvent): void => {
      emitted.push(event);
    };

    translateSdkMessage(
      e,
      'sid-h3-2',
      { type: 'system', subtype: 'init', permissionMode: 'plan' },
      internal,
    );

    // internal cache 仍同步（即使 cur 相同也 set 内部 cache）
    expect(internal.permissionMode).toBe('plan');
    // DB 不写 (cur === next 跳过)
    expect(vi.mocked(sessionRepo.setPermissionMode)).not.toHaveBeenCalled();
    // emit session-upserted 不调 (DB 没写就不需要 upsert)
    const upsertedCalls = vi.mocked(eventBus.emit).mock.calls.filter(
      (call) => call[0] === 'session-upserted',
    );
    expect(upsertedCalls).toHaveLength(0);
  });

  it('SDK frame permissionMode 非白名单 (typo / 不支持) → internal cache 不变 + DB 不写', () => {
    const internal = makeInternalSession({ cwd: '/tmp/h3-3', permissionMode: 'default' });
    expect(internal.permissionMode).toBe('default');

    vi.mocked(sessionRepo.get).mockReturnValueOnce({
      id: 'sid-h3-3',
      permissionMode: 'default',
    } as never);

    const emitted: AgentEvent[] = [];
    const e = (event: AgentEvent): void => {
      emitted.push(event);
    };

    translateSdkMessage(
      e,
      'sid-h3-3',
      { type: 'system', subtype: 'status', permissionMode: 'unknown_mode_typo' },
      internal,
    );

    // 非白名单 mode → 整段 if block 不执行 → internal cache 不变 + DB 不写
    expect(internal.permissionMode).toBe('default');
    expect(vi.mocked(sessionRepo.setPermissionMode)).not.toHaveBeenCalled();
    const upsertedCalls = vi.mocked(eventBus.emit).mock.calls.filter(
      (call) => call[0] === 'session-upserted',
    );
    expect(upsertedCalls).toHaveLength(0);
  });
});
