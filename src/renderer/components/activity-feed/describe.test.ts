import { describe as suite, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { formatEventLine } from '../SessionCard';
import { describe as describeActivity } from './describe';

function ev(kind: AgentEvent['kind'], payload: unknown): AgentEvent {
  return { sessionId: 's', agentId: '', kind, payload, ts: 0 };
}

suite('activity-feed describe user-facing fallbacks', () => {
  it('session-start 缺 cwd 时不留下空分隔符', () => {
    expect(describeActivity(ev('session-start', {}))).toBe('会话开始');
  });

  it('file-changed 缺 filePath 时显示用户向兜底', () => {
    expect(describeActivity(ev('file-changed', {}))).toBe('📝 文件改动');
  });

  it('waiting permission-request 显示工具和关键入参', () => {
    expect(
      describeActivity(
        ev('waiting-for-user', {
          type: 'permission-request',
          toolName: 'Bash',
          toolInput: { command: 'pnpm test -- --runInBand' },
        }),
      ),
    ).toBe('⚠️ 等待你授权 Bash · pnpm test -- --runInBand');
  });

  it('waiting message 为结构对象时不显示 [object Object]', () => {
    expect(describeActivity(ev('waiting-for-user', { message: { type: 'internal' } }))).toBe(
      '⚠️ 等待你的输入',
    );
  });

  it('session-end reason 为结构对象时不显示 [object Object]', () => {
    expect(describeActivity(ev('session-end', { reason: { type: 'internal' } }))).toBe(
      '⏹ 会话结束',
    );
  });

  it('团队任务事件使用中文任务文案', () => {
    expect(describeActivity(ev('team-task-created', { description: '修复登录' }))).toBe(
      '📌 新任务 · 修复登录',
    );
    expect(describeActivity(ev('team-task-completed', { description: '修复登录' }))).toBe(
      '✓ 任务完成 · 修复登录',
    );
  });

  it('Codex 协作 Agent 摘要包含操作、目标、模型、思考程度和超时', () => {
    expect(
      describeActivity(
        ev('tool-use-start', {
          toolName: 'Agent',
          toolInput: {
            collab_tool: 'wait_agent',
            target: '/root/reviewer',
            model: 'gpt-5.6-codex',
            reasoning_effort: 'xhigh',
            timeout_ms: 30000,
          },
        }),
      ),
    ).toContain('wait_agent · → /root/reviewer · gpt-5.6-codex/xhigh · 超时 30 秒');
  });
});

suite('SessionCard formatEventLine', () => {
  it('waiting permission-request 显示具体授权原因', () => {
    expect(
      formatEventLine(
        ev('waiting-for-user', {
          type: 'permission-request',
          toolName: 'Bash',
          toolInput: { command: 'pnpm test' },
        }),
      ),
    ).toBe('⚠️ 等待你授权 Bash · pnpm test');
  });

  it('file-changed 缺 filePath 时跳过该弱摘要', () => {
    expect(formatEventLine(ev('file-changed', {}))).toBeNull();
  });

  it('message text 为结构对象时跳过，避免 React 渲染对象', () => {
    expect(formatEventLine(ev('message', { text: { type: 'internal' } }))).toBeNull();
  });

  it('Agent live activity 不再显示虚构的 codex-collab-agent 占位', () => {
    expect(
      formatEventLine(
        ev('tool-use-start', {
          toolName: 'Agent',
          toolInput: {
            collab_tool: 'spawn_agent',
            task_name: 'audit_adapter',
            fork_turns: 'all',
            model: 'gpt-5.6-codex',
            reasoning_effort: 'high',
          },
        }),
      ),
    ).toBe('🤖 Agent · spawn_agent · audit_adapter · gpt-5.6-codex/high · fork_turns=all');
  });
});
