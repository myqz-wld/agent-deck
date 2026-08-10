// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPermissionPreviewDisplay,
  MCP_DIFF_PRESENTATION_SCHEMA,
  MCP_PLAN_PRESENTATION_SCHEMA,
} from '@contracts/index';
import type { RemoteHostPendingRequestDto } from '@shared/remote-host';
import type { PlanDeepReviewTransport } from '@renderer/plan-review/transport';
import { RemotePendingRequests } from '@renderer/components/pending-rows/RemotePendingRequests';

vi.mock('@renderer/components/diff/DiffViewer', () => ({
  DiffViewer: () => <div>共享差异视图</div>,
}));

function pending(
  id: string,
  kind: RemoteHostPendingRequestDto['kind'],
  display: RemoteHostPendingRequestDto['display'],
  status: RemoteHostPendingRequestDto['status'] = 'pending',
): RemoteHostPendingRequestDto {
  return {
    id,
    sessionId: 'same-session',
    kind,
    status,
    createdAt: 1,
    expiresAt: null,
    display,
  };
}

afterEach(cleanup);

describe('RemotePendingRequests', () => {
  it('opens the shared deep-review dialog when the Remote source supplies a transport', () => {
    const plan = pending('plan-remote', 'exit-plan', {
      schema: MCP_PLAN_PRESENTATION_SCHEMA,
      title: 'Remote review',
      plan: '# Remote plan',
    });
    const transport: PlanDeepReviewTransport = {
      identity: 'remote-a:plan-remote', revision: 1,
      start: vi.fn(), ask: vi.fn(), generateFeedback: vi.fn(), listEvents: vi.fn(),
    };
    render(<RemotePendingRequests
      pending={{ requests: [plan], revision: 9 }}
      sourceIdentity="remote-a:core-a:1"
      agentId="codex-cli"
      busy={false}
      onRespond={vi.fn()}
      planReviewTransport={() => transport}
    />);
    const button = screen.getByRole('button', { name: '深度审阅' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: '计划深度审阅' })).toBeTruthy();
    expect(screen.getByText('Remote review')).toBeTruthy();
  });

  it('routes exact permission and authoritative ask answer shapes through the source responder', async () => {
    const respond = vi.fn(async () => undefined);
    const permission = pending('permission-a', 'permission', createPermissionPreviewDisplay(
      'Bash', { command: 'pwd' },
    ));
    const question = pending('ask-a', 'ask-user-question', {
      questionIds: ['environment', 'reason'],
    });
    render(
      <RemotePendingRequests
        pending={{ requests: [permission, question], revision: 7 }}
        sourceIdentity="remote-a:core-a:1"
        busy={false}
        onRespond={respond}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '允许本次' }));
    fireEvent.change(screen.getByRole('textbox', { name: '回答：environment' }), {
      target: { value: 'production' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '回答：reason' }), {
      target: { value: 'release' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond.mock.calls).toEqual([
      [expect.objectContaining({ request: permission, revision: 7, sourceIdentity: 'remote-a:core-a:1' }), 'approve'],
      [expect.objectContaining({ request: question, revision: 7, sourceIdentity: 'remote-a:core-a:1' }), 'submit', { environment: 'production', reason: 'release' }],
    ]);
  });

  it('uses the answer fallback and disables actions for non-pending records', async () => {
    const respond = vi.fn(async () => undefined);
    render(
      <RemotePendingRequests
        pending={{ requests: [
          pending('fallback', 'ask-user-question', {}),
          pending('resolved', 'permission', {}, 'resolved'),
        ], revision: 8 }}
        sourceIdentity="remote-a:core-a:1"
        busy={false}
        onRespond={respond}
      />,
    );

    expect(screen.queryByRole('button', { name: '允许本次' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '回答：answer' }), {
      target: { value: 'fallback value' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ id: 'fallback' }) }),
      'submit',
      { answer: 'fallback value' },
    ));
  });

  it('remounts answers and errors when the same request gets a new presentation revision', async () => {
    const respond = vi.fn()
      .mockRejectedValueOnce(new Error('stale presentation'))
      .mockResolvedValue(undefined);
    const first = pending('ask-a', 'ask-user-question', {
      prompt: 'first prompt', questionIds: ['answer'],
    });
    const view = render(
      <RemotePendingRequests
        pending={{ requests: [first], revision: 10 }}
        sourceIdentity="remote-a:core-a:1"
        busy={false}
        onRespond={respond}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: '回答：answer' }), {
      target: { value: 'stale answer' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect((await screen.findByRole('alert')).textContent).toContain('stale presentation');

    const changed = pending('ask-a', 'ask-user-question', {
      prompt: 'changed prompt', questionIds: ['answer'],
    });
    view.rerender(
      <RemotePendingRequests
        pending={{ requests: [changed], revision: 10 }}
        sourceIdentity="remote-a:core-a:1"
        busy={false}
        onRespond={respond}
      />,
    );
    const answer = screen.getByRole('textbox', { name: '回答：answer' }) as HTMLTextAreaElement;
    expect(answer.value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: '提交回答' }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.change(answer, { target: { value: 'old revision answer' } });
    view.rerender(
      <RemotePendingRequests
        pending={{ requests: [changed], revision: 11 }}
        sourceIdentity="remote-a:core-a:1"
        busy={false}
        onRespond={respond}
      />,
    );
    const revisedAnswer = screen.getByRole('textbox', { name: '回答：answer' }) as HTMLTextAreaElement;
    expect(revisedAnswer.value).toBe('');
    fireEvent.change(revisedAnswer, { target: { value: 'fresh answer' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(respond).toHaveBeenLastCalledWith(
      expect.objectContaining({ request: changed, revision: 11 }),
      'submit',
      { answer: 'fresh answer' },
    ));
  });

  it('isolates answer state for the same request id across source identities', () => {
    const request = pending('ask-a', 'ask-user-question', { questionIds: ['answer'] });
    const props = { pending: { requests: [request], revision: 3 }, busy: false, onRespond: vi.fn() };
    const view = render(<RemotePendingRequests {...props} sourceIdentity="remote-a:core-a:1" />);
    fireEvent.change(screen.getByRole('textbox', { name: '回答：answer' }), {
      target: { value: 'source A answer' },
    });
    view.rerender(<RemotePendingRequests {...props} sourceIdentity="remote-b:core-b:1" />);
    expect((screen.getByRole('textbox', { name: '回答：answer' }) as HTMLTextAreaElement).value)
      .toBe('');
  });

  it('renders bounded question options and submits the structured answer shape', async () => {
    const respond = vi.fn(async () => undefined);
    const question = pending('ask-options', 'ask-user-question', {
      questionIds: ['environment'],
      questions: [{
        id: 'environment',
        header: '目标环境',
        question: '部署到哪个环境？',
        multiSelect: false,
        options: [
          { label: 'Production', description: '正式环境' },
          { label: 'Staging', description: '预发布环境' },
        ],
      }],
    });
    render(
      <RemotePendingRequests
        pending={{ requests: [question], revision: 4 }}
        sourceIdentity="remote-a:core-a:1"
        busy={false}
        onRespond={respond}
      />,
    );

    expect(screen.getByText('目标环境')).toBeTruthy();
    expect(screen.getByText('部署到哪个环境？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Production' }));
    fireEvent.change(screen.getByPlaceholderText('其他（可选）'), {
      target: { value: 'urgent rollout' },
    });
    fireEvent.change(screen.getByLabelText('目标环境备注'), {
      target: { value: 'watch metrics' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    await waitFor(() => expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ request: question, revision: 4 }),
      'submit',
      {
        environment: {
          selected: ['Production'],
          other: 'urgent rollout',
          note: 'watch metrics',
        },
      },
    ));
  });

  it('reuses the native plan row and preserves its selected target mode', async () => {
    const respond = vi.fn(async () => undefined);
    const plan = pending('native-plan', 'exit-plan', {
      title: 'Deploy',
      summary: '# Deploy safely',
    });
    render(
      <RemotePendingRequests
        pending={{ requests: [plan], revision: 6 }}
        sourceIdentity="remote-a:core-a:1"
        agentId="claude-code"
        busy={false}
        onRespond={respond}
      />,
    );

    expect(screen.getByText('Deploy')).toBeTruthy();
    expect(screen.getByText('Deploy safely')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '批准并切到 自动接受编辑' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ request: plan, revision: 6 }),
      'accept',
      { targetMode: 'acceptEdits' },
    ));
  });

  it('shows bounded permission context and disables only approval when it is incomplete', () => {
    const complete = pending('permission-edit', 'permission', createPermissionPreviewDisplay(
      'Edit', { file_path: '/workspace/app.ts', old_string: 'before', new_string: 'after' },
    ));
    const redacted = pending('permission-mcp', 'permission', createPermissionPreviewDisplay(
      'mcp__service__call', {
        arguments: { endpoint: 'https://example.test', token: 'renderer-raw-secret' },
      },
    ));
    const incomplete = pending('permission-large', 'permission', createPermissionPreviewDisplay(
      'Write', { file_path: '/workspace/large.txt', content: 'x'.repeat(100_000) },
    ));
    render(<RemotePendingRequests
      pending={{ requests: [complete, redacted, incomplete], revision: 6 }}
      sourceIdentity="remote-a:core-a:1"
      agentId="claude-code"
      busy={false}
      onRespond={vi.fn()}
    />);

    expect(screen.getAllByText('共享差异视图')).toHaveLength(2);
    expect(document.body.textContent).toContain('https://example.test');
    expect(document.body.textContent).toContain('[redacted]');
    expect(document.body.textContent).not.toContain('renderer-raw-secret');
    expect(screen.getByText('授权输入未能完整安全展示；仅可拒绝此请求。')).toBeTruthy();
    const approvals = screen.getAllByRole('button', { name: '允许本次' }) as HTMLButtonElement[];
    const denials = screen.getAllByRole('button', { name: '拒绝' }) as HTMLButtonElement[];
    expect(approvals.some((button) => button.disabled)).toBe(true);
    expect(approvals.some((button) => !button.disabled)).toBe(true);
    expect(denials.every((button) => !button.disabled)).toBe(true);
  });

  it('falls back without native target modes for an extended exit-plan display', async () => {
    const respond = vi.fn(async () => undefined);
    const plan = pending('extended-plan', 'exit-plan', {
      title: 'Deploy', summary: '# Deploy safely', hint: 'forward-compatible metadata',
    });
    render(<RemotePendingRequests
      pending={{ requests: [plan], revision: 6 }}
      sourceIdentity="remote-a:core-a:1"
      agentId="claude-code"
      busy={false}
      onRespond={respond}
    />);

    expect(screen.queryByRole('button', { name: /批准并切到/u })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '批准并继续' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ request: plan, revision: 6 }),
      'accept',
      undefined,
    ));
  });

  it('reuses the shared plan and diff presentations with Remote response routing', async () => {
    const respond = vi.fn(async () => undefined);
    const plan = pending('plan-a', 'exit-plan', {
      schema: MCP_PLAN_PRESENTATION_SCHEMA,
      title: '远程计划',
      plan: '# 第一步\n\n完成实现。',
    });
    const diff = pending('diff-a', 'diff-review', {
      schema: MCP_DIFF_PRESENTATION_SCHEMA,
      mode: 'pr',
      rationale: '确认这次变更',
      filePath: 'src/example.ts',
      pr: { before: 'old', after: 'new' },
    });
    render(
      <RemotePendingRequests
        pending={{ requests: [plan, diff], revision: 12 }}
        sourceIdentity="remote-a:core-a:1"
        agentId="codex-cli"
        busy={false}
        onRespond={respond}
      />,
    );

    expect(screen.getByText('远程计划')).toBeTruthy();
    expect(screen.getByText('确认这次变更')).toBeTruthy();
    expect((screen.getByRole('button', { name: '深度审阅' }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认计划' }));
    fireEvent.click(screen.getByRole('button', { name: '提修改意见' }));
    fireEvent.change(screen.getByRole('textbox', { name: '差异修改意见' }), {
      target: { value: '保留旧行为' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提修改意见' }));

    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond.mock.calls).toEqual([
      [expect.objectContaining({ request: plan, revision: 12 }), 'accept'],
      [expect.objectContaining({ request: diff, revision: 12 }), 'reject', {
        feedback: '保留旧行为',
      }],
    ]);
  });

  it('disables MCP plan and diff decisions while another Remote operation is busy', () => {
    const plan = pending('plan-a', 'exit-plan', {
      schema: MCP_PLAN_PRESENTATION_SCHEMA,
      plan: '# Remote plan',
    });
    const diff = pending('diff-a', 'diff-review', {
      schema: MCP_DIFF_PRESENTATION_SCHEMA,
      mode: 'pr',
      rationale: 'Review this change',
      pr: { before: 'old', after: 'new' },
    });
    const respond = vi.fn();
    render(<RemotePendingRequests
      pending={{ requests: [plan, diff], revision: 9 }}
      sourceIdentity="remote-a:core-a:1"
      agentId="codex-cli"
      busy
      onRespond={respond}
    />);

    expect((screen.getByRole('button', { name: '确认计划' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', { name: '确认片段' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(respond).not.toHaveBeenCalled();
  });
});
