/**
 * plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.5 测试 (A1-MED-1 codex):
 * Edit / Write / MultiEdit 的 file-changed emit 延迟到 user.tool_result + status='completed'。
 *
 * **测试覆盖**:
 * - status='completed' → emit + delete intent
 * - status='failed' → 仅 delete 不 emit
 * - 多 intent 共存 + 部分成功 + 部分失败 → 仅成功的 emit
 * - 没 intent (toolUseId 没匹配) → no-op (图片工具走另一路径)
 *
 * **Phase 1.5 (deep-review-batch-a1-b-followup-r3-20260519, M6)** 补 case：SDK 流终止前 push
 * intent 但 tool_result 没回 → stream-processor.consume finally clear 清掉 pendingFileChangeIntents
 * 防 leak（与 toolUseNames / pendingPermissions 等同款保险，不依赖 internal GC 时机）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pushFileChangeIntent,
  consumePendingFileChangeIntent,
} from '../sdk-message-translate';
import { makeInternalSession } from '../types';
import { StreamProcessor } from '../stream-processor';
import { MockSdkQuery } from '@main/__tests__/_shared/mocks/sdk-query';
import type { AgentEvent } from '@shared/types';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

// Phase 1.5: stream-processor.consume finally clear 测试需要 mock sessionManager
// （consume finally 调 sessionManager.releaseSdkClaim）。
vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    expectSdkSession: vi.fn(() => () => undefined),
    renameSdkSession: vi.fn(),
  },
}));

function setupInternal(): {
  internal: ReturnType<typeof makeInternalSession>;
  emit: (kind: AgentEvent['kind'], payload: unknown) => void;
  emitted: Array<{ kind: string; payload: unknown }>;
} {
  const internal = makeInternalSession({ cwd: '/tmp/test', applicationSid: 'sess-test' });
  const emitted: Array<{ kind: string; payload: unknown }> = [];
  const emit = (kind: AgentEvent['kind'], payload: unknown): void => {
    emitted.push({ kind, payload });
  };
  return { internal, emit, emitted };
}

describe('Phase 3 Step 3.5 — file-changed emit 延迟到 tool-use-end + completed (A1-MED-1 codex)', () => {
  it('Edit intent → status=completed → emit file-changed + delete intent', () => {
    const { internal, emit, emitted } = setupInternal();
    pushFileChangeIntent(
      internal,
      'Edit',
      { file_path: '/tmp/foo.ts', old_string: 'OLD', new_string: 'NEW' },
      'tool_use_xx',
    );
    expect(internal.pendingFileChangeIntents.size).toBe(1);
    expect(emitted.length).toBe(0); // 还没 emit

    consumePendingFileChangeIntent(emit, internal, 'tool_use_xx', 'completed');
    expect(emitted.length).toBe(1);
    expect(emitted[0].kind).toBe('file-changed');
    const p = emitted[0].payload as Record<string, unknown>;
    expect(p.filePath).toBe('/tmp/foo.ts');
    expect(p.before).toBe('OLD');
    expect(p.after).toBe('NEW');
    expect(p.toolCallId).toBe('tool_use_xx');
    expect(internal.pendingFileChangeIntents.size).toBe(0); // delete after emit
  });

  it('Write intent → status=failed → 仅 delete intent 不 emit', () => {
    const { internal, emit, emitted } = setupInternal();
    pushFileChangeIntent(
      internal,
      'Write',
      { file_path: '/tmp/bar.ts', content: 'NEW_CONTENT' },
      'tool_use_yy',
    );
    expect(internal.pendingFileChangeIntents.size).toBe(1);

    consumePendingFileChangeIntent(emit, internal, 'tool_use_yy', 'failed');
    expect(emitted.length).toBe(0); // failed 不 emit
    expect(internal.pendingFileChangeIntents.size).toBe(0); // intent 仍 delete (避免 leak)
  });

  it('MultiEdit intent + failed → 同样仅 delete 不 emit', () => {
    const { internal, emit, emitted } = setupInternal();
    pushFileChangeIntent(
      internal,
      'MultiEdit',
      {
        file_path: '/tmp/baz.ts',
        edits: [
          { old_string: 'A', new_string: 'B' },
          { old_string: 'X', new_string: 'Y' },
        ],
      },
      'tool_use_zz',
    );
    consumePendingFileChangeIntent(emit, internal, 'tool_use_zz', 'failed');
    expect(emitted.length).toBe(0);
    expect(internal.pendingFileChangeIntents.size).toBe(0);
  });

  it('多 intent 部分成功部分失败 → 仅成功的 emit', () => {
    const { internal, emit, emitted } = setupInternal();
    pushFileChangeIntent(internal, 'Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }, 'id-success');
    pushFileChangeIntent(internal, 'Edit', { file_path: '/c', old_string: 'c', new_string: 'd' }, 'id-fail');
    expect(internal.pendingFileChangeIntents.size).toBe(2);

    consumePendingFileChangeIntent(emit, internal, 'id-success', 'completed');
    consumePendingFileChangeIntent(emit, internal, 'id-fail', 'failed');

    expect(emitted.length).toBe(1);
    expect((emitted[0].payload as Record<string, unknown>).filePath).toBe('/a');
    expect(internal.pendingFileChangeIntents.size).toBe(0);
  });

  it('toolUseId 没匹配 (典型图片工具走 maybeEmitImageFileChanged 另路径) → no-op', () => {
    const { internal, emit, emitted } = setupInternal();
    consumePendingFileChangeIntent(emit, internal, 'unknown_tool_use', 'completed');
    expect(emitted.length).toBe(0);
    expect(internal.pendingFileChangeIntents.size).toBe(0);
  });

  it('toolName 不是 Edit/Write/MultiEdit (如 Bash) → 不 push intent (no-op)', () => {
    const { internal, emit } = setupInternal();
    pushFileChangeIntent(internal, 'Bash', { command: 'ls' }, 'tool_use_bash');
    expect(internal.pendingFileChangeIntents.size).toBe(0); // Bash 不入 intent Map
    consumePendingFileChangeIntent(emit, internal, 'tool_use_bash', 'completed');
    // pendingFileChangeIntents 没 entry → consumePendingFileChangeIntent no-op
  });
});

describe('Phase 1.5 (M6) — consume finally clear pendingFileChangeIntents 防 leak', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('SDK 流终止前 push intent 但 tool_result 没回 → consume finally clear → size === 0', async () => {
    // 场景：SDK 流终止前 Edit / Write / MultiEdit tool_use 已 push intent 到 pendingFileChangeIntents
    // 但对应 tool_result 没回（典型：SDK 网络断 / CLI 子进程崩 / 用户主动 close session），
    // consume finally 必须显式 clear 防 intent 滞留（虽然 internal 整体被 GC 但显式 clear 与
    // toolUseNames / pendingPermissions 等同款保险，与 ts-cleanup 模式对齐）。
    const internal = makeInternalSession({ cwd: '/tmp/test-leak', applicationSid: 'sess-test-leak' });
    const mockQuery = new MockSdkQuery();
    internal.query = mockQuery as unknown as Query;

    const emitted: AgentEvent[] = [];
    const processor = new StreamProcessor({
      sessions: new Map([['temp-key', internal]]),
      emit: (e) => emitted.push(e),
    });

    // 推 first id frame 让 consume 走 first-id 路径
    mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: 'real-sid' });

    // 启动 consume（不 await，模拟 SDK 流 in-flight）
    const consumePromise = processor.consume(internal, 'temp-key', () => undefined);

    // 让 microtask 跑（让 consume 处理 first id frame）
    await vi.advanceTimersByTimeAsync(0);

    // 在 SDK 流中模拟 tool_use 推 intent（实际 production 由 translateSdkMessage 触发，
    // 测试直接 manual 调 helper 等效）
    pushFileChangeIntent(
      internal,
      'Edit',
      { file_path: '/tmp/foo.ts', old_string: 'OLD', new_string: 'NEW' },
      'leaked-tool-use-1',
    );
    pushFileChangeIntent(
      internal,
      'Write',
      { file_path: '/tmp/bar.ts', content: 'leaked content' },
      'leaked-tool-use-2',
    );
    pushFileChangeIntent(
      internal,
      'MultiEdit',
      {
        file_path: '/tmp/baz.ts',
        edits: [{ old_string: 'A', new_string: 'B' }],
      },
      'leaked-tool-use-3',
    );

    // 验证 intent 已被 push（finally 清之前）
    expect(internal.pendingFileChangeIntents.size).toBe(3);

    // SDK 流终止（tool_result 没回 → 3 个 intent 留在 Map 等清理）
    mockQuery.endStream();
    await vi.advanceTimersByTimeAsync(0);

    // 等 consume 走完 finally
    await consumePromise;

    // **核心 invariant**: finally 清空 pendingFileChangeIntents 防 leak（详 stream-processor.ts:327）
    expect(internal.pendingFileChangeIntents.size).toBe(0);

    // 3 个 leaked intent 都没 emit file-changed（tool_result 没回 → no-op）
    const fileChangedEmits = emitted.filter((e) => e.kind === 'file-changed');
    expect(fileChangedEmits).toHaveLength(0);

    // 与 toolUseNames / pendingPermissions / pendingAskUserQuestions / pendingExitPlanModes
    // 同款保险：finally 全部 clear
    expect(internal.toolUseNames.size).toBe(0);
    expect(internal.pendingPermissions.size).toBe(0);
    expect(internal.pendingAskUserQuestions.size).toBe(0);
    expect(internal.pendingExitPlanModes.size).toBe(0);
  });

  it('多 intent + 部分 tool_result 回（completed）+ 部分没回 → finally clear 剩余防 leak', async () => {
    // 部分 intent 走正常路径（completed → emit + delete），剩余 intent 因 SDK 流断没等到
    // tool_result → finally clear 清掉。验证 finally clear 对部分清/部分未清 case 都收口。
    const internal = makeInternalSession({ cwd: '/tmp/test-mixed', applicationSid: 'sess-test-mixed' });
    const mockQuery = new MockSdkQuery();
    internal.query = mockQuery as unknown as Query;

    const emitted: AgentEvent[] = [];
    const processor = new StreamProcessor({
      sessions: new Map([['temp-key', internal]]),
      emit: (e) => emitted.push(e),
    });

    mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: 'real-sid-mixed' });
    const consumePromise = processor.consume(internal, 'temp-key', () => undefined);
    await vi.advanceTimersByTimeAsync(0);

    // push 3 intent
    pushFileChangeIntent(internal, 'Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }, 'id-completed');
    pushFileChangeIntent(internal, 'Edit', { file_path: '/c', old_string: 'c', new_string: 'd' }, 'id-leaked-1');
    pushFileChangeIntent(internal, 'Edit', { file_path: '/e', old_string: 'e', new_string: 'f' }, 'id-leaked-2');
    expect(internal.pendingFileChangeIntents.size).toBe(3);

    // 模拟 1 个 intent 正常 completed → emit + delete
    consumePendingFileChangeIntent(
      (kind, payload) => emitted.push({ kind, payload } as AgentEvent),
      internal,
      'id-completed',
      'completed',
    );
    expect(internal.pendingFileChangeIntents.size).toBe(2);

    // SDK 流断（剩 2 intent 没等到 tool_result）
    mockQuery.endStream();
    await vi.advanceTimersByTimeAsync(0);
    await consumePromise;

    // finally clear 清剩余 2 个
    expect(internal.pendingFileChangeIntents.size).toBe(0);

    // 仅 completed 的 1 个 file-changed 被 emit
    const fileChangedEmits = emitted.filter((e) => e.kind === 'file-changed');
    expect(fileChangedEmits).toHaveLength(1);
    expect((fileChangedEmits[0].payload as { filePath: string }).filePath).toBe('/a');
  });
});
