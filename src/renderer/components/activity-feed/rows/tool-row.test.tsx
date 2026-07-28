// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { AgentEvent } from '@shared/types';
import { ToolEndRow, ToolStartRow } from './tool-row';
import {
  localDiffContent,
  localImageContent,
} from '../viewers/content-reference';

vi.mock('@renderer/components/diff/DiffViewer', () => ({
  DiffViewer: ({ payload }: { payload: unknown }) => (
    <div data-testid="diff-viewer">{JSON.stringify(payload)}</div>
  ),
}));

vi.mock('@renderer/components/diff/renderers/ImageBlobLoader', () => ({
  ImageBlobLoader: ({ children }: {
    children: (state: unknown) => React.ReactNode;
  }) => children({
    loading: false,
    result: { ok: true, dataUrl: 'data:image/png;base64,AAAA' },
  }),
}));

vi.mock('@renderer/components/ImageThumb', () => ({
  ImageThumb: ({ onClick }: { onClick?: () => void }) => (
    <div data-testid="image-thumb" role="img" aria-label="ImageRead 缩略图" onClick={onClick} />
  ),
}));

function ev(kind: AgentEvent['kind'], payload: unknown): AgentEvent {
  return { sessionId: 's', agentId: 'codex-cli', kind, payload, ts: 0 };
}

afterEach(() => cleanup());

describe('ToolStartRow unified viewer', () => {
  it('keeps raw input out of the row and exposes it through the top-right 44px action', () => {
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
    expect(container.textContent).not.toContain('"codexSandbox"');
    const trigger = screen.getByRole('button', {
      name: '展开 mcp__agent-deck__spawn_session 详情',
    });
    expect(trigger.className).toContain('h-11');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', {
      name: 'mcp__agent-deck__spawn_session 详情',
    });
    expect(dialog.className).toContain('min-w-0');
    expect(dialog.textContent).toContain('"codexSandbox": "workspace-write"');
  });

  it('preserves Agent summary fields and full raw input in the viewer', () => {
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
    expect(container.textContent).toContain('任务 audit_adapter');
    expect(container.textContent).toContain('spawn_agent');
    expect(container.textContent).toContain('gpt-5.6-codex · xhigh');
    expect(container.textContent).toContain('1 个目标');
    expect(container.textContent).toContain('fork_turns=all');
    expect(container.textContent).not.toContain('"sender_thread_id"');
    fireEvent.click(screen.getByRole('button', { name: '展开 Agent 详情' }));
    const dialog = screen.getByRole('dialog', { name: 'Agent 详情' });
    expect(dialog.textContent).toContain('"sender_thread_id": "lead-thread"');
    expect(dialog.textContent).toContain('gAAAA-encrypted-raw-prompt');
  });

  it('keeps typed diff data intact and mounts the heavy renderer only when opened', () => {
    render(
      <ToolStartRow
        event={ev('tool-use-start', {
          toolName: 'Edit',
          toolUseId: 'edit-1',
          toolInput: {
            file_path: '/repo/a.ts',
            old_string: 'const before = 1;',
            new_string: 'const after = 2;',
          },
        })}
        sessionId="s"
      />,
    );
    expect(screen.queryByTestId('diff-viewer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开 Edit 详情' }));
    const viewer = screen.getByTestId('diff-viewer');
    expect(viewer.textContent).toContain('"filePath":"/repo/a.ts"');
    expect(viewer.textContent).toContain('"before":"const before = 1;"');
    expect(viewer.textContent).toContain('"after":"const after = 2;"');
    expect(viewer.closest('[data-expandable-heavy-view]')?.getAttribute(
      'data-expandable-heavy-view',
    )).toBe('monaco');
  });

  it('closes an open fallback viewer when a same-millisecond tool changes identity', () => {
    const first = ev('tool-use-start', {
      toolName: 'FirstTool',
      toolInput: { value: 'first payload' },
    });
    const second = ev('tool-use-start', {
      toolName: 'SecondTool',
      toolInput: { value: 'second payload' },
    });
    const view = render(<ToolStartRow event={first} sessionId="s" />);
    fireEvent.click(screen.getByRole('button', { name: '展开 FirstTool 详情' }));
    expect(screen.getByRole('dialog').textContent).toContain('first payload');
    view.rerender(<ToolStartRow event={second} sessionId="s" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开 SecondTool 详情' }));
    expect(screen.getByRole('dialog').textContent).toContain('second payload');
  });

  it('maps required typed references to the owning local heavy-view resolver', () => {
    const diff = {
      kind: 'text',
      filePath: '/repo/a.ts',
      before: 'before',
      after: 'after',
      ts: 1,
    } as const;
    const diffContent = localDiffContent({
      sessionId: 's',
      eventId: 'diff-1',
      toolName: 'Edit',
      diff,
    });
    expect(diffContent.resolve(diffContent.payload.reference)).toEqual(diff);
    expect(diffContent.resolve({
      ...diffContent.payload.reference,
      authorization: {
        ...diffContent.payload.reference.authorization,
        grantId: 'wrong-grant',
      },
    })).toBeNull();

    const source = { kind: 'path', path: '/repo/image.png' } as const;
    const imageContent = localImageContent({
      sessionId: 's',
      eventId: 'image-1',
      source,
      alt: '图片',
    });
    expect(imageContent.resolve(imageContent.payload.reference)).toEqual(source);
  });
});

describe('ToolEndRow unified viewer', () => {
  it('shows full paired input, result, status, and truncation in one detail view', () => {
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
          toolResultTruncated: true,
        })}
        sessionId="s"
        startEvent={startEvent}
      />,
    );
    expect(container.textContent).toContain('结果已截断');
    expect(container.textContent).not.toContain('tool output done');
    fireEvent.click(screen.getByRole('button', { name: '展开 Skill 详情' }));
    const dialog = screen.getByRole('dialog', { name: 'Skill 详情' });
    expect(dialog.textContent).toContain('"skill": "prompt-asset-improver"');
    expect(dialog.textContent).toContain('tool output done');
    expect(dialog.textContent).toContain('结果已截断');
  });

  it('shows an unknown provider status safely without duplicating label and detail', () => {
    render(
      <ToolEndRow
        event={ev('tool-use-end', {
          toolName: 'custom_tool',
          toolUseId: 'custom-1',
          status: 'provider_paused',
        })}
        sessionId="s"
      />,
    );
    expect(screen.getByText('状态未知')).toBeTruthy();
    expect(screen.getByText('· 原始状态：provider_paused')).toBeTruthy();
  });

  it('keeps failed and denied terminal states concise and actionable', () => {
    const { rerender, container } = render(
      <ToolEndRow
        event={ev('tool-use-end', {
          toolName: 'search_tool',
          toolUseId: 'failed-1',
          status: 'failed',
        })}
        sessionId="s"
      />,
    );
    expect(container.textContent).toContain('search_tool失败');
    expect(container.firstElementChild?.className).toContain('border-status-error');
    rerender(
      <ToolEndRow
        event={ev('tool-use-end', {
          toolName: 'Bash',
          toolUseId: 'denied-1',
          status: 'denied',
          reason: 'user rejected',
          durationMs: 1250,
          toolInputTruncated: true,
          toolResultTruncated: true,
        })}
        sessionId="s"
      />,
    );
    expect(container.textContent).toContain('Bash已拒绝');
    expect(container.textContent).toContain('1.3s');
    expect(container.textContent).toContain('输入和结果已截断');
  });

  it('opens ImageRead from the thumbnail action and mounts the full image only then', () => {
    render(
      <ToolEndRow
        event={ev('tool-use-end', {
          toolName: 'mcp__image__ImageRead',
          toolUseId: 'image-1',
          status: 'completed',
          toolResult: JSON.stringify({
            kind: 'image-read',
            file: '/repo/image.png',
            description: '完整图片描述',
            provider: 'openai',
            model: 'vision',
          }),
        })}
        sessionId="s"
      />,
    );
    expect(screen.getByTestId('image-thumb')).toBeTruthy();
    expect(document.querySelector('[data-expandable-heavy-view="image"]')).toBeNull();
    const trigger = screen.getByRole('button', { name: '展开 ImageRead 详情' });
    trigger.focus();
    fireEvent.click(screen.getByTestId('image-thumb'));
    expect(screen.getByRole('dialog', { name: 'ImageRead 详情' })).toBeTruthy();
    expect(document.querySelector('[data-expandable-heavy-view="image"]')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    return waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'ImageRead 详情' })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });
});
