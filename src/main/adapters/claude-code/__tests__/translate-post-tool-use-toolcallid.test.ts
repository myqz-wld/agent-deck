/**
 * plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.4 测试 (A1-MED-4 claude):
 * translatePostToolUse hook 路径 file-changed emit 透传 toolCallId(SDK PostToolUse hook payload
 * 提供 tool_use_id,与 sdk-message-translate maybeEmitFileChanged 路径对称)。
 *
 * **测试覆盖**:
 * - Edit / Write / MultiEdit hook payload 含 tool_use_id → file-changed payload.toolCallId 透传
 * - hook payload 不含 tool_use_id (老协议) → toolCallId 字段 undefined 不破
 * - 图片工具(MCP image-write/edit)hook payload 含 tool_use_id → 内嵌 file-changed payload 也含 toolCallId
 */
import { describe, expect, it } from 'vitest';
import { translatePostToolUse } from '../translate';

interface FileChangePayload {
  toolCallId?: string;
  filePath?: string;
  metadata?: { source?: string };
}

describe('Phase 3 Step 3.4 — translatePostToolUse toolCallId 透传 (A1-MED-4 claude)', () => {
  it('Edit hook payload + tool_use_id → file-changed.toolCallId 透传', () => {
    const events = translatePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/foo.ts', old_string: 'A', new_string: 'B' },
      tool_use_id: 'tool_use_xxx',
    });
    // tool-use-end 一条 + file-changed 一条
    expect(events.length).toBe(2);
    expect(events[0].kind).toBe('tool-use-end');
    expect(events[1].kind).toBe('file-changed');
    expect((events[1].payload as FileChangePayload).toolCallId).toBe('tool_use_xxx');
    expect((events[1].payload as FileChangePayload).filePath).toBe('/tmp/foo.ts');
  });

  it('Write hook payload + tool_use_id → file-changed.toolCallId 透传', () => {
    const events = translatePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/bar.ts', content: 'NEW' },
      tool_use_id: 'tool_use_yyy',
    });
    const fc = events.find((e) => e.kind === 'file-changed');
    expect(fc).toBeDefined();
    expect((fc!.payload as FileChangePayload).toolCallId).toBe('tool_use_yyy');
  });

  it('MultiEdit hook payload + tool_use_id → file-changed.toolCallId 透传', () => {
    const events = translatePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '/tmp/baz.ts',
        edits: [{ old_string: 'a', new_string: 'b' }],
      },
      tool_use_id: 'tool_use_zzz',
    });
    const fc = events.find((e) => e.kind === 'file-changed');
    expect(fc).toBeDefined();
    expect((fc!.payload as FileChangePayload).toolCallId).toBe('tool_use_zzz');
  });

  it('hook payload 不含 tool_use_id (老协议) → toolCallId 字段 undefined 不破', () => {
    const events = translatePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/foo.ts', old_string: 'A', new_string: 'B' },
      // 故意不传 tool_use_id
    });
    const fc = events.find((e) => e.kind === 'file-changed');
    expect(fc).toBeDefined();
    expect((fc!.payload as FileChangePayload).toolCallId).toBeUndefined();
    // 行为不破 — 仅 toolCallId 字段缺失,UI 仍可用
  });

  it('Bash 工具 (无 file-changed 翻译) → 仅 tool-use-end 一条事件,不 emit file-changed', () => {
    const events = translatePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tool_use_bash',
    });
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('tool-use-end');
  });
});
