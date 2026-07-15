import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@main/adapters/types';
import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';
import {
  dispatchAdapterMessageWithHandOffRedirect,
  type AdapterMessageDispatchDependencies,
} from '../adapters-message-dispatch';

function successor(): SessionRecord {
  return {
    id: 'successor',
    agentId: 'codex-cli',
    cwd: '/repo',
    title: 'successor',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
  };
}

describe('dispatchAdapterMessageWithHandOffRedirect', () => {
  it('re-checks ownership after an awaited unarchive and queues on the successor', async () => {
    let redirect: string | null = null;
    const sourceSend = vi.fn(async () => undefined);
    const successorEnqueue = vi.fn(async () => undefined);
    const attachments: UploadedAttachmentRef[] = [{
      kind: 'uploaded',
      path: '/uploads/late.png',
      mime: 'image/png',
      bytes: 4,
    }];
    const deps: AdapterMessageDispatchDependencies = {
      successorFor: vi.fn(() => redirect),
      unarchiveOnUserSend: vi.fn(async () => {
        redirect = 'successor';
      }),
      getSession: vi.fn(() => successor()),
      getAdapter: vi.fn(
        () => ({ enqueueMessage: successorEnqueue }) as unknown as AgentAdapter,
      ),
    };

    await dispatchAdapterMessageWithHandOffRedirect(
      {
        sourceSessionId: 'source',
        sourceAdapter: { sendMessage: sourceSend } as unknown as AgentAdapter,
        text: 'arrived during cutover',
        attachments,
      },
      deps,
    );

    expect(deps.successorFor).toHaveBeenCalledTimes(2);
    expect(deps.unarchiveOnUserSend).toHaveBeenCalledWith('source');
    expect(sourceSend).not.toHaveBeenCalled();
    expect(successorEnqueue).toHaveBeenCalledWith(
      'successor',
      'arrived during cutover',
      attachments,
    );
  });

  it('sends on the source when ownership remains unchanged', async () => {
    const sourceSend = vi.fn(async () => undefined);
    const deps: AdapterMessageDispatchDependencies = {
      successorFor: vi.fn(() => null),
      unarchiveOnUserSend: vi.fn(async () => undefined),
      getSession: vi.fn(),
      getAdapter: vi.fn(),
    };

    await dispatchAdapterMessageWithHandOffRedirect(
      {
        sourceSessionId: 'source',
        sourceAdapter: { sendMessage: sourceSend } as unknown as AgentAdapter,
        text: 'ordinary input',
        attachments: [],
      },
      deps,
    );

    expect(sourceSend).toHaveBeenCalledWith('source', 'ordinary input', []);
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('uses retry-safe enqueue semantics for a keyed source turn', async () => {
    const sourceSend = vi.fn(async () => undefined);
    const sourceEnqueue = vi.fn(async () => undefined);
    const deps: AdapterMessageDispatchDependencies = {
      successorFor: vi.fn(() => null),
      unarchiveOnUserSend: vi.fn(async () => undefined),
      getSession: vi.fn(),
      getAdapter: vi.fn(),
    };
    const enqueueOptions = { idempotencyKey: 'plan-late-decision:plan-1' };

    await dispatchAdapterMessageWithHandOffRedirect(
      {
        sourceSessionId: 'source',
        sourceAdapter: {
          sendMessage: sourceSend,
          enqueueMessage: sourceEnqueue,
        } as unknown as AgentAdapter,
        text: 'late plan decision',
        attachments: [],
        enqueueOptions,
      },
      deps,
    );

    expect(sourceSend).not.toHaveBeenCalled();
    expect(sourceEnqueue).toHaveBeenCalledWith(
      'source',
      'late plan decision',
      [],
      enqueueOptions,
    );
  });
});
