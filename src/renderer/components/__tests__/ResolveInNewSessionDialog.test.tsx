// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IssueRecord } from '@shared/types';
import { ResolveInNewSessionDialog } from '../ResolveInNewSessionDialog';

let issuesResolveInNewSession: ReturnType<typeof vi.fn>;

function sessionCreationDefaults(
  approvalPolicy: 'untrusted' | 'on-request' | 'never' = 'on-request',
) {
  return {
    provider: '',
    model: '',
    thinking: 'high' as const,
    permissionMode: 'bypassPermissions' as const,
    sessionMode: 'default' as const,
    approvalPolicy,
    codexSandbox: 'workspace-write' as const,
    claudeCodeSandbox: 'workspace-write' as const,
    grokSandbox: 'workspace',
  };
}

function makeIssue(): IssueRecord {
  const now = Date.now();
  return {
    id: 'issue-1',
    title: '修复模型选择',
    description: '确保新会话使用所选模型',
    repro: null,
    kind: 'follow-up',
    status: 'open',
    severity: 'medium',
    sourceSessionId: 'source-session',
    cwd: '/repo',
    branchName: null,
    logsRef: null,
    resolutionSessionId: null,
    labels: [],
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    deletedAt: null,
  };
}

beforeEach(() => {
  issuesResolveInNewSession = vi.fn();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([
        {
          id: 'codex-cli',
          displayName: 'Codex',
          capabilities: { canCreateSession: true, canSetPermissionMode: false },
        },
      ]),
      getAdapterSessionCreationDefaults: vi.fn().mockResolvedValue(
        sessionCreationDefaults('untrusted'),
      ),
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
      listCodexModelProviders: vi.fn().mockResolvedValue([]),
      issuesResolveInNewSession,
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('ResolveInNewSessionDialog model options', () => {
  it('把问题解决会话选择的 provider、模型与思考程度透传给 IPC', async () => {
    const issue = makeIssue();
    const updated = { ...issue, resolutionSessionId: 'resolution-session' };
    issuesResolveInNewSession.mockResolvedValue({
      sessionId: 'resolution-session',
      issue: updated,
    });
    const onResolved = vi.fn();
    render(
      <ResolveInNewSessionDialog
        issue={issue}
        onClose={vi.fn()}
        onResolved={onResolved}
      />,
    );

    await screen.findByText('Codex');
    const disclosure = screen.getByText('模型配置').closest('details');
    expect(disclosure?.open).toBe(false);
    fireEvent.click(screen.getByText('模型配置'));
    expect(disclosure?.open).toBe(true);
    fireEvent.change(await screen.findByLabelText('Provider'), {
      target: { value: 'openai-custom' },
    });
    fireEvent.change(screen.getByLabelText('模型'), {
      target: { value: 'gpt-custom-preview' },
    });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));
    const approvalPicker = screen.getByLabelText('审批策略（沿用上次选择）');
    await waitFor(() => {
      expect(approvalPicker.textContent).toContain('非可信命令前询问');
    });
    fireEvent.click(approvalPicker);
    fireEvent.click(screen.getByRole('option', { name: '按需询问' }));
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    await waitFor(() => {
      expect(issuesResolveInNewSession).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: 'issue-1',
          adapter: 'codex-cli',
          provider: 'openai-custom',
          model: 'gpt-custom-preview',
          thinking: 'ultra',
          approvalPolicy: 'on-request',
        }),
      );
    });
    expect(onResolved).toHaveBeenCalledWith(updated);
  });

  it('forwards a custom Grok sandbox profile for issue resolution', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listAdapters: vi.fn().mockResolvedValue([
          {
            id: 'grok-build',
            displayName: 'Grok Build',
            capabilities: {
              canCreateSession: true,
              canSetSessionMode: true,
            },
            sessionModes: ['default', 'plan', 'ask'],
          },
        ]),
        getAdapterSessionCreationDefaults: vi.fn().mockResolvedValue(sessionCreationDefaults()),
        listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
        listCodexModelProviders: vi.fn().mockResolvedValue([]),
        issuesResolveInNewSession,
      },
    });
    const issue = makeIssue();
    issuesResolveInNewSession.mockResolvedValue({
      sessionId: 'resolution-session',
      issue: { ...issue, resolutionSessionId: 'resolution-session' },
    });
    render(
      <ResolveInNewSessionDialog
        issue={issue}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByLabelText('Grok 沙盒请求档位'));
    fireEvent.click(screen.getByRole('option', { name: '广泛只读' }));
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    await waitFor(() => {
      expect(issuesResolveInNewSession).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: 'issue-1',
          adapter: 'grok-build',
          grokSandbox: 'read-only',
        }),
      );
    });
  });
});
