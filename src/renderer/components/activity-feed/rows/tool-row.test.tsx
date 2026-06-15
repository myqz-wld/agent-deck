// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
            model_reasoning_effort: 'xhigh',
          },
        })}
        sessionId="s"
      />,
    );

    expect(screen.getByRole('button', { name: '查看指令' })).toBeTruthy();
    expect(container.textContent).not.toContain('"model_reasoning_effort": "xhigh"');
    expect(screen.queryByRole('button', { name: '查看入参' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Agent/ }));
    expect(container.textContent).toContain('"model_reasoning_effort": "xhigh"');
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
  });
});
