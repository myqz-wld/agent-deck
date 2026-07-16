// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentEvent, ExitPlanModeRequest } from '@shared/types';
import { ExitPlanRow } from './ExitPlanRow';

const payload: ExitPlanModeRequest = {
  type: 'exit-plan-mode',
  requestId: 'plan-1',
  reviewSource: 'mcp',
  title: 'Lifecycle plan',
  plan: '## Plan\n\nValidate handoff cleanup.',
};

const event: AgentEvent = {
  sessionId: 'source',
  agentId: 'codex-cli',
  kind: 'waiting-for-user',
  payload,
  ts: 1,
  source: 'sdk',
};

afterEach(() => cleanup());

describe('ExitPlanRow', () => {
  it('clears the authoritative successor bucket returned after a handoff race', async () => {
    const respondExitPlanMode = vi.fn(async () => ({ resolvedSessionId: 'successor' }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { respondExitPlanMode } as unknown as Window['api'],
    });
    const onResolved = vi.fn();
    render(
      <ExitPlanRow
        event={event}
        payload={payload}
        sessionId="source"
        agentId="codex-cli"
        isSdk
        stillPending
        wasCancelled={false}
        onResolved={onResolved}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '确认计划' }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('successor', 'plan-1'));
    expect(respondExitPlanMode).toHaveBeenCalledWith(
      'codex-cli',
      'source',
      'plan-1',
      { decision: 'approve', targetMode: 'default' },
    );
  });
});
