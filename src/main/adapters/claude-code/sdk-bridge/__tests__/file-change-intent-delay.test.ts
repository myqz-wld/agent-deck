/**
 * plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.5 测试 (A1-MED-1 codex):
 * Edit / Write / MultiEdit 的 file-changed emit 延迟到 user.tool_result + status='completed'。
 *
 * **测试覆盖**:
 * - status='completed' → emit + delete intent
 * - status='failed' → 仅 delete 不 emit
 * - 多 intent 共存 + 部分成功 + 部分失败 → 仅成功的 emit
 * - 没 intent (toolUseId 没匹配) → no-op (图片工具走另一路径)
 */
import { describe, expect, it } from 'vitest';
import {
  pushFileChangeIntent,
  consumePendingFileChangeIntent,
} from '../sdk-message-translate';
import { makeInternalSession } from '../types';
import type { AgentEvent } from '@shared/types';

function setupInternal(): {
  internal: ReturnType<typeof makeInternalSession>;
  emit: (kind: AgentEvent['kind'], payload: unknown) => void;
  emitted: Array<{ kind: string; payload: unknown }>;
} {
  const internal = makeInternalSession({ cwd: '/tmp/test' });
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
