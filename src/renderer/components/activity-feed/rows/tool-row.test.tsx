// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentEvent } from '@shared/types';
import { ToolEndRow, ToolStartRow } from './tool-row';

vi.mock('@renderer/components/diff/DiffViewer', () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));

vi.mock('@renderer/components/ImageThumb', () => ({
  ImageThumb: () => <div data-testid="image-thumb" />,
}));

vi.mock('@renderer/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <div>{text}</div>,
}));

function ev(kind: AgentEvent['kind'], payload: unknown): AgentEvent {
  return { sessionId: 's', agentId: 'codex-cli', kind, payload, ts: 0 };
}

describe('ToolStartRow tool input disclosure', () => {
  it('keeps generic tool inputs collapsed until the user clicks the start row', () => {
    const { container } = render(
      <ToolStartRow
        event={ev('tool-use-start', {
          toolName: 'mcp__agent-deck__spawn_session',
          toolUseId: 'tool-1',
          toolInput: {
            adapter: 'codex-cli',
            codexSandbox: 'workspace-write',
            prompt: 'review this patch',
          },
        })}
        sessionId="s"
      />,
    );

    expect(container.textContent).not.toContain('"codexSandbox": "workspace-write"');
    expect(screen.queryByRole('button', { name: '查看入参' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /mcp__agent-deck__spawn_session/ }));
    expect(container.textContent).toContain('"codexSandbox": "workspace-write"');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows Task/Agent prompt controls and exposes raw input from the start row', () => {
    const { container } = render(
      <ToolStartRow
        event={ev('tool-use-start', {
          toolName: 'Agent',
          toolUseId: 'agent-1',
          toolInput: {
            subagent_type: 'reviewer-codex',
            prompt: 'review this patch',
            reasoning_effort: 'xhigh',
          },
        })}
        sessionId="s"
      />,
    );

    expect(screen.getByRole('button', { name: '查看指令' })).toBeTruthy();
    expect(container.textContent).toContain('默认模型 · xhigh');
    expect(container.textContent).not.toContain('"reasoning_effort": "xhigh"');
    expect(screen.queryByRole('button', { name: '查看入参' })).toBeNull();
    fireEvent.click(within(container).getByRole('button', { name: /Agent/ }));
    expect(container.textContent).toContain('"reasoning_effort": "xhigh"');
  });

  it('surfaces Codex collab operation, runtime, targets, and full raw parameters', () => {
    const { container } = render(
      <ToolStartRow
        event={ev('tool-use-start', {
          toolName: 'Agent',
          toolUseId: 'agent-2',
          toolInput: {
            collab_tool: 'spawn_agent',
            task_name: 'audit_adapter',
            fork_turns: 'all',
            sender_thread_id: 'lead-thread',
            receiver_thread_ids: ['child-thread'],
            prompt: 'inspect the adapter',
            message: 'gAAAA-encrypted-raw-prompt',
            model: 'gpt-5.6-codex',
            reasoning_effort: 'xhigh',
          },
        })}
        sessionId="s"
      />,
    );

    expect(container.textContent).toContain('spawn_agent');
    expect(container.textContent).toContain('audit_adapter');
    expect(container.textContent).toContain('任务 audit_adapter');
    expect(container.textContent).not.toContain('→ audit_adapter');
    expect(container.textContent).toContain('fork_turns=all');
    expect(container.textContent).toContain('gpt-5.6-codex · xhigh');
    expect(container.textContent).toContain('1 个目标');
    expect(container.textContent).not.toContain('codex-collab-agent');
    expect(container.textContent).not.toContain('"sender_thread_id": "lead-thread"');
    expect(container.textContent).not.toContain('gAAAA-encrypted-raw-prompt');
    fireEvent.click(within(container).getByRole('button', { name: /Agent/ }));
    expect(container.textContent).toContain('"sender_thread_id": "lead-thread"');
    expect(container.textContent).toContain('"receiver_thread_ids"');
    expect(container.textContent).toContain('gAAAA-encrypted-raw-prompt');
  });

  it('shows the exact Codex collaboration wait timeout', () => {
    const { container } = render(
      <ToolStartRow
        event={ev('tool-use-start', {
          toolName: 'Agent',
          toolUseId: 'call-wait-1',
          toolInput: { collab_tool: 'wait_agent', timeout_ms: 30000 },
        })}
        sessionId="s"
      />,
    );

    expect(container.textContent).toContain('wait_agent');
    expect(container.textContent).toContain('超时 30 秒');
    fireEvent.click(within(container).getByRole('button', { name: /Agent/ }));
    expect(container.textContent).toContain('"timeout_ms": 30000');
  });
});

describe('ToolEndRow tool output disclosure', () => {
  it('does not show the paired input button and expands tool output from the end row', () => {
    const startEvent = ev('tool-use-start', {
      toolName: 'Skill',
      toolUseId: 'skill-1',
      toolInput: { skill: 'prompt-asset-improver', args: 'audit durable prompts' },
    });

    const { container } = render(
      <ToolEndRow
        event={ev('tool-use-end', {
          toolName: 'Skill',
          toolUseId: 'skill-1',
          toolResult: 'tool output done',
          status: 'completed',
        })}
        sessionId="s"
        startEvent={startEvent}
      />,
    );

    expect(screen.queryByRole('button', { name: '查看入参' })).toBeNull();
    expect(container.textContent).not.toContain('"skill": "prompt-asset-improver"');
    expect(container.textContent).not.toContain('tool output done');
    fireEvent.click(screen.getByRole('button', { name: /Skill 完成/ }));
    expect(container.textContent).toContain('tool output done');
    expect(container.textContent).not.toContain('"skill": "prompt-asset-improver"');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('merges richer completion metadata with safe start-only Agent parameters', () => {
    const startEvent = ev('tool-use-start', {
      toolName: 'Agent',
      toolUseId: 'agent-merge-1',
      toolInput: { collab_tool: 'spawn_agent', task_name: 'audit', fork_turns: 'all' },
    });
    const { container } = render(
      <ToolEndRow
        event={ev('tool-use-end', {
          toolName: 'Agent',
          toolUseId: 'agent-merge-1',
          toolInput: {
            collab_tool: 'spawn_agent',
            receiver_thread_ids: ['child-thread'],
            model: 'gpt-5.6-codex',
            reasoning_effort: 'xhigh',
          },
          status: 'completed',
        })}
        sessionId="s"
        startEvent={startEvent}
      />,
    );

    expect(container.textContent).toContain('spawn_agent');
    expect(container.textContent).toContain('audit');
    expect(container.textContent).toContain('gpt-5.6-codex/xhigh');
    expect(container.textContent).toContain('fork_turns=all');
    expect(container.textContent).toContain('1 个目标');
  });

  it('renders a normalized Codex sub-agent activity even without a raw start event', () => {
    const { container } = render(
      <ToolEndRow
        event={ev('tool-use-end', {
          toolName: 'Agent',
          toolUseId: 'call-followup-1',
          toolInput: {
            target: '/root/audit_adapter',
            receiver_thread_ids: ['child-thread'],
            activity_kind: 'interacted',
            description: '已向子代理发送消息',
          },
          toolResult: { activity_kind: 'interacted' },
          status: 'completed',
        })}
        sessionId="s"
      />,
    );

    expect(container.textContent).toContain('Agent 完成');
    expect(container.textContent).toContain('→ /root/audit_adapter');
    expect(container.textContent).toContain('1 个目标');
    expect(container.textContent).toContain('已向子代理发送消息');
  });

  it('expands Codex collaboration raw output inline', () => {
    const { container } = render(
      <ToolEndRow
        event={ev('tool-use-end', {
          toolName: 'Agent',
          toolUseId: 'agent-output-1',
          toolResult: 'gAAAA-encrypted-raw-output',
        })}
        sessionId="s"
      />,
    );

    expect(container.textContent).not.toContain('gAAAA-encrypted-raw-output');
    fireEvent.click(within(container).getByRole('button', { name: /Agent 完成/ }));
    expect(container.textContent).toContain('gAAAA-encrypted-raw-output');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders a canonical failed Grok completion with the shared failure treatment', () => {
    const { container } = render(
      <ToolEndRow
        event={ev('tool-use-end', {
          toolName: 'search_tool',
          toolKind: 'search',
          toolUseId: 'grok-search-1',
          toolResult: 'search unavailable',
          status: 'failed',
        })}
        sessionId="s"
      />,
    );

    expect(container.textContent).toContain('search_tool 失败');
    expect(container.firstElementChild?.className).toContain('border-status-error');
  });

  it('distinguishes denied terminal state and exposes its reason', () => {
    const { container } = render(
      <ToolEndRow
        event={ev('tool-use-end', {
          toolName: 'Bash',
          toolUseId: 'denied-1',
          status: 'denied',
          error: 'user rejected',
          reason: 'user rejected',
          durationMs: 1250,
          toolInputTruncated: true,
          toolResultTruncated: true,
        })}
        sessionId="s"
      />,
    );

    expect(container.textContent).toContain('Bash 已拒绝');
    expect(container.textContent).toContain('1.3s');
    expect(container.textContent).toContain('输入和结果已截断');
    expect(container.firstElementChild?.className).toContain('border-status-error');
    fireEvent.click(screen.getByRole('button', { name: /Bash 已拒绝/ }));
    expect(container.textContent).toContain('user rejected');
  });
});
