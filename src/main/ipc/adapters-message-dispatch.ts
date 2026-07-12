import { adapterRegistry } from '@main/adapters/registry';
import { isAgentId } from '@main/adapters/options-builder';
import type { AgentAdapter } from '@main/adapters/types';
import { sessionManager } from '@main/session/manager';
import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import { sessionRepo } from '@main/store/session-repo';
import type { SessionAdapterId, SessionRecord, UploadedAttachmentRef } from '@shared/types';

export interface AdapterMessageDispatchDependencies {
  successorFor: (sourceSessionId: string) => string | null;
  unarchiveOnUserSend: (sessionId: string) => Promise<void>;
  getSession: (sessionId: string) => SessionRecord | null;
  getAdapter: (agentId: SessionAdapterId) => AgentAdapter | undefined;
}

const productionDependencies: AdapterMessageDispatchDependencies = {
  successorFor: (sourceSessionId) => handOffCutoverCoordinator.successorFor(sourceSessionId),
  unarchiveOnUserSend: (sessionId) => sessionManager.unarchiveOnUserSend(sessionId),
  getSession: (sessionId) => sessionRepo.get(sessionId),
  getAdapter: (agentId) => adapterRegistry.get(agentId),
};

/** Re-check after unarchive so an IPC send already in flight follows a concurrent handoff commit. */
export async function dispatchAdapterMessageWithHandOffRedirect(
  input: {
    sourceSessionId: string;
    sourceAdapter: AgentAdapter;
    text: string;
    attachments: UploadedAttachmentRef[];
  },
  deps: AdapterMessageDispatchDependencies = productionDependencies,
): Promise<void> {
  const initialRedirect = deps.successorFor(input.sourceSessionId);
  await deps.unarchiveOnUserSend(initialRedirect ?? input.sourceSessionId);
  const redirect = deps.successorFor(input.sourceSessionId) ?? initialRedirect;
  if (!redirect) {
    if (!input.sourceAdapter.sendMessage) throw new Error('adapter cannot send message');
    await input.sourceAdapter.sendMessage(
      input.sourceSessionId,
      input.text,
      input.attachments,
    );
    return;
  }

  const successor = deps.getSession(redirect);
  const successorAdapter =
    successor && isAgentId(successor.agentId)
      ? deps.getAdapter(successor.agentId)
      : undefined;
  if (!successor || !successorAdapter?.enqueueMessage) {
    throw new Error('handoff successor cannot receive redirected source input');
  }
  await successorAdapter.enqueueMessage(
    redirect,
    input.text,
    input.attachments,
  );
}
