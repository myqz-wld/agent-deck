// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RemoteSessionDetail } from './RemoteSessionDetail';

vi.mock('./RemoteSessionComposer', () => ({
  RemoteSessionComposer: ({ onHandOff }: { onHandOff(): void }) => (
    <button type="button" onClick={onHandOff}>open-handoff</button>
  ),
}));
vi.mock('./RemoteHandOffDialog', () => ({
  RemoteHandOffDialog: ({ onCommitted }: { onCommitted(result: unknown): void }) => (
    <button type="button" onClick={() => onCommitted({
      successorSessionId: 'successor', cutoverEventRevision: 1,
      lateMessagesDelivered: 0, usedLowerBudgetRetry: false,
      sourceFinalizationWarning: '旧源会话收尾未能确认', revision: 2,
    })}>finish-handoff</button>
  ),
}));

afterEach(cleanup);

function source({
  error,
  loadedSessionId,
  selectedSessionId,
  selectSession,
}: {
  error: string | null;
  loadedSessionId: string | null;
  selectedSessionId: string;
  selectSession(sessionId: string | null): void;
}): RemoteSessionSourceView {
  const session = loadedSessionId ? {
    id: loadedSessionId, adapterId: 'codex-cli', title: loadedSessionId,
    status: 'active-idle', createdAt: 1, updatedAt: 2,
  } : null;
  return {
    busy: false, capabilities: new Set(['sessions.handoff']), context: null,
    error, events: null, identity: 'profile-a:core-a:1', runtime: null,
    selectedSession: session, selectedSessionId, summaries: null,
    tasks: null, usable: true, selectSession,
  } as unknown as RemoteSessionSourceView;
}

function NoticeHarness(): JSX.Element {
  const [selectedSessionId, setSelectedSessionId] = useState('source-a');
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>('source-a');
  const [error, setError] = useState<string | null>(null);
  const selectSession = (sessionId: string | null): void => {
    if (!sessionId) return;
    setSelectedSessionId(sessionId);
    setLoadedSessionId(null);
  };
  return (
    <>
      <button type="button" onClick={() => setLoadedSessionId(selectedSessionId)}>load-selected</button>
      <button type="button" onClick={() => {
        setError('另一个会话的错误');
        selectSession('source-b');
      }}>select-other</button>
      <RemoteSessionDetail
        source={source({ error, loadedSessionId, selectedSessionId, selectSession })}
        onClose={vi.fn()}
      />
    </>
  );
}

describe('RemoteSessionDetail handoff notice scope', () => {
  it('shows the notice on the loaded successor without shadowing another session', async () => {
    render(<NoticeHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'open-handoff' }));
    fireEvent.click(screen.getByRole('button', { name: 'finish-handoff' }));
    expect(screen.queryByText('旧源会话收尾未能确认')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'load-selected' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toContain('旧源会话收尾未能确认'));

    fireEvent.click(screen.getByRole('button', { name: 'select-other' }));
    fireEvent.click(screen.getByRole('button', { name: 'load-selected' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe('另一个会话的错误'));
  });
});
