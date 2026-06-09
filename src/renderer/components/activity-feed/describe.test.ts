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
});
