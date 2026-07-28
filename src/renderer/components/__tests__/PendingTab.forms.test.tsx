// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  AgentEvent,
  AskUserQuestionRequest,
  PermissionRequest,
  SessionRecord,
} from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { AskRow } from '../pending-rows/AskRow';
import { PermissionRow } from '../pending-rows/PermissionRow';
import { PendingTab } from '../PendingTab';

vi.mock('@renderer/components/diff/DiffViewer', () => ({
  DiffViewer: ({ payload, sessionId, expanded }: {
    payload: { filePath?: string };
    sessionId?: string;
    expanded?: boolean;
  }) => (
    <div data-testid="permission-diff-viewer">
      {payload.filePath}:{sessionId}:{String(expanded)}
    </div>
  ),
}));

function event(payload: unknown): AgentEvent {
  return {
    sessionId: 'session-1',
    agentId: 'codex-cli',
    kind: 'waiting-for-user',
    payload,
    ts: 1,
    source: 'sdk',
  };
}

function askPayload(
  requestId: string,
  reverse = false,
): AskUserQuestionRequest {
  const questions: AskUserQuestionRequest['questions'] = [
    {
      header: '第一项',
      question: '选择方案',
      options: [{ label: '甲' }],
    },
    {
      header: '第二项',
      question: '选择方案',
      options: [{ label: '乙' }],
    },
  ];
  return {
    type: 'ask-user-question',
    requestId,
    questions: reverse ? [...questions].reverse() : questions,
  };
}

function renderAsk(
  payload: AskUserQuestionRequest,
  onResolved = vi.fn(),
) {
  return render(
    <AskRow
      event={event(payload)}
      payload={payload}
      sessionId="session-1"
      agentId="codex-cli"
      isSdk
      stillPending
      wasCancelled={false}
      onResolved={onResolved}
    />,
  );
}

function permission(
  requestId: string,
  toolName = 'Edit',
): PermissionRequest {
  return {
    type: 'permission-request',
    requestId,
    toolName,
    toolInput: toolName === 'Edit'
      ? {
          file_path: '/workspace/example.ts',
          old_string: 'before',
          new_string: 'after',
        }
      : {
          file_path: '/workspace/new.ts',
          content: 'new file',
        },
  };
}

function session(): SessionRecord {
  return {
    id: 'session-1',
    agentId: 'codex-cli',
    cwd: '/workspace/project',
    title: 'Review session',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'waiting',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
  };
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: new Map(),
    pendingPermissionsBySession: new Map(),
    pendingAskQuestionsBySession: new Map(),
    pendingExitPlanModesBySession: new Map(),
    pendingDiffReviewsBySession: new Map(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AskRow draft identity and response fencing', () => {
  it('keeps duplicate question text drafts attached when questions reorder', async () => {
    const respond = vi.fn(async () => undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { respondAskUserQuestion: respond } as unknown as Window['api'],
    });
    const view = renderAsk(askPayload('ask-1'));

    fireEvent.click(within(screen.getByText('第一项').parentElement!)
      .getByRole('button', { name: '甲' }));
    fireEvent.click(within(screen.getByText('第二项').parentElement!)
      .getByRole('button', { name: '乙' }));

    const reordered = askPayload('ask-1', true);
    view.rerender(
      <AskRow
        event={event(reordered)}
        payload={reordered}
        sessionId="session-1"
        agentId="codex-cli"
        isSdk
        stillPending
        wasCancelled={false}
        onResolved={vi.fn()}
      />,
    );

    expect(within(screen.getByText('第一项').parentElement!)
      .getByRole('button', { name: '甲' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByText('第二项').parentElement!)
      .getByRole('button', { name: '乙' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect((respond.mock.calls[0] as unknown[] | undefined)?.[3]).toEqual({
      answers: [
        { question: '选择方案', selected: ['乙'], other: undefined, note: undefined },
        { question: '选择方案', selected: ['甲'], other: undefined, note: undefined },
      ],
    });
  });

  it('shows an actionable local error without resolving the row', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        respondAskUserQuestion: vi.fn(async () => {
          throw new Error('internal request details');
        }),
      } as unknown as Window['api'],
    });
    const onResolved = vi.fn();
    renderAsk(askPayload('ask-error'), onResolved);
    fireEvent.click(screen.getByRole('button', { name: '甲' }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    expect((await screen.findByRole('alert')).textContent)
      .toBe('回答提交失败，请确认问题仍在等待后重试。');
    expect(screen.queryByText('internal request details')).toBeNull();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('does not let an old request failure paint the replacement row', async () => {
    let rejectOld!: (error: Error) => void;
    const oldResponse = new Promise<void>((_resolve, reject) => {
      rejectOld = reject;
    });
    const respond = vi.fn((_agentId: string, _sessionId: string, requestId: string) =>
      requestId === 'ask-old' ? oldResponse : Promise.resolve());
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { respondAskUserQuestion: respond } as unknown as Window['api'],
    });
    const view = renderAsk(askPayload('ask-old'));
    fireEvent.click(screen.getByRole('button', { name: '甲' }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    const replacement = askPayload('ask-new');
    const onResolved = vi.fn();
    view.rerender(
      <AskRow
        event={event(replacement)}
        payload={replacement}
        sessionId="session-1"
        agentId="codex-cli"
        isSdk
        stillPending
        wasCancelled={false}
        onResolved={onResolved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '甲' }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('session-1', 'ask-new'));

    rejectOld(new Error('stale failure'));
    await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not let an old success resolve the replacement row', async () => {
    let resolveOld!: () => void;
    const oldResponse = new Promise<void>((resolve) => {
      resolveOld = resolve;
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        respondAskUserQuestion: vi.fn(() => oldResponse),
      } as unknown as Window['api'],
    });
    const oldResolved = vi.fn();
    const view = renderAsk(askPayload('ask-old-success'), oldResolved);
    fireEvent.click(screen.getByRole('button', { name: '甲' }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    const replacement = askPayload('ask-replacement');
    view.rerender(
      <AskRow
        event={event(replacement)}
        payload={replacement}
        sessionId="session-1"
        agentId="codex-cli"
        isSdk
        stillPending
        wasCancelled={false}
        onResolved={vi.fn()}
      />,
    );
    resolveOld();
    await Promise.resolve();
    await Promise.resolve();

    expect(oldResolved).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Permission and batch response surfaces', () => {
  it('mounts a settled permission diff only after the shared expansion action', () => {
    const payload = permission('permission-1');
    render(
      <PermissionRow
        event={event(payload)}
        payload={payload}
        sessionId="session-1"
        agentId="codex-cli"
        isSdk
        stillPending={false}
        wasCancelled={false}
        onResolved={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('permission-diff-viewer')).toBeNull();
    const trigger = screen.getByRole('button', { name: '展开权限请求内容' });
    expect(trigger.className).toContain('h-11');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '权限请求 · Edit' })).toBeTruthy();
    expect(screen.getByTestId('permission-diff-viewer').textContent)
      .toContain('/workspace/example.ts:session-1:true');
  });

  it('normalizes cyclic and non-JSON permission input into a bounded fallback', () => {
    const toolInput: Record<string, unknown> = {
      count: 12n,
      optional: undefined,
      oversized: 'x'.repeat(5_000),
      entries: Array.from({ length: 100 }, (_, index) => index),
    };
    toolInput.self = toolInput;
    const payload: PermissionRequest = {
      type: 'permission-request',
      requestId: 'permission-non-json',
      toolName: 'CustomTool',
      toolInput,
    };

    render(
      <PermissionRow
        event={event(payload)}
        payload={payload}
        sessionId="session-1"
        agentId="codex-cli"
        isSdk
        stillPending={false}
        wasCancelled={false}
        onResolved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '展开权限请求内容' }));

    const dialog = screen.getByRole('dialog', { name: '权限请求 · CustomTool' });
    expect(dialog.textContent).toContain('非 JSON 值：BigInt');
    expect(dialog.textContent).toContain('非 JSON 值：undefined');
    expect(dialog.textContent).toContain('无法展开：循环引用');
    expect(dialog.textContent).toContain('已截断');
    expect(dialog.textContent?.length).toBeLessThan(10_000);
  });

  it('keys a batch failure to the permission row that failed', async () => {
    useSessionStore.setState({
      sessions: new Map([['session-1', session()]]),
      pendingPermissionsBySession: new Map([[
        'session-1',
        [permission('permission-1', 'Edit'), permission('permission-2', 'Write')],
      ]]),
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        respondPermission: vi.fn(async (
          _agentId: string,
          _sessionId: string,
          requestId: string,
        ) => {
          if (requestId === 'permission-1') throw new Error('batch transport failed');
        }),
      } as unknown as Window['api'],
    });
    render(<PendingTab onOpenSession={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '全部允许' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent)
      .toBe('批量响应在此项失败。请单独重试，或重新执行批量操作。');
    expect(alert.closest('li')?.textContent).toContain('Edit');
    expect(alert.closest('li')?.textContent).not.toContain('Write');
  });
});
