import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import type {
  RemoteHostMutationAuthorityDto,
  RemoteHostRuntimeControlsDto,
} from '@shared/remote-host';

import type { RemoteSessionSourceView } from './source-types';
import {
  RemoteUserIntentLedger,
  remoteAttachmentIntentPayload,
  remoteSessionCreateIntentPayload,
} from './remote-intent-ledger';
import { pendingPresentationBindingDigest } from './remote-pending-presentation';

type SessionActions = Pick<RemoteSessionSourceView,
  | 'archiveHistorySession'
  | 'commitHandOff'
  | 'createSession'
  | 'createWorkspaceDirectory'
  | 'deleteHistorySession'
  | 'getSessionCapabilities'
  | 'interrupt'
  | 'listWorkspaceDirectories'
  | 'listOutgoing'
  | 'previewHandOff'
  | 'respondPending'
  | 'removeOutgoing'
  | 'send'
  | 'steer'
  | 'updateRuntime'
  | 'unarchiveHistorySession'>;

interface RemoteSessionActionOptions {
  activeProfileId: string | null;
  expectedAuthority: RemoteHostMutationAuthorityDto;
  identityRef: MutableRefObject<string>;
  intents: RemoteUserIntentLedger;
  requireCapability(capability: string): void;
  runBusiness<T>(operation: () => Promise<T>): Promise<T>;
  runTerminalBusiness<T>(operation: () => Promise<T>): Promise<T>;
  runtimeRef: MutableRefObject<RemoteHostRuntimeControlsDto | null>;
  selectSession(sessionId: string | null): void;
  setRuntime: Dispatch<SetStateAction<RemoteHostRuntimeControlsDto | null>>;
  sourceIdentity: string;
  target(): { profileId: string; sessionId: string };
}

/** Identity-fenced Remote session actions shared by detail and creation surfaces. */
export function createRemoteSessionActions(
  options: RemoteSessionActionOptions,
): SessionActions {
  const {
    activeProfileId,
    expectedAuthority,
    identityRef,
    intents,
    requireCapability,
    runBusiness,
    runTerminalBusiness,
    runtimeRef,
    selectSession,
    setRuntime,
    sourceIdentity,
    target,
  } = options;
  const requireProfile = (): string => {
    if (!activeProfileId) throw new Error('请选择远程配置。');
    return activeProfileId;
  };
  const assertIdentity = (
    expectedIdentity: string,
    message = '数据源已切换，请重试。',
  ): void => {
    if (identityRef.current !== expectedIdentity) throw new Error(message);
  };
  const mutationRequest = <T extends object>(request: T): T & {
    expectedAuthority: RemoteHostMutationAuthorityDto;
  } => {
    assertIdentity(sourceIdentity);
    return { ...request, expectedAuthority };
  };

  return {
    archiveHistorySession: (session) => runBusiness(async () => {
      requireCapability('sessions.history.write');
      const request = mutationRequest({
        profileId: requireProfile(), sessionId: session.id,
        expectedArchived: session.archived, expectedUpdatedAt: session.updatedAt,
      });
      await intents.run(sourceIdentity, 'history-archive', request, (intentId) =>
        window.api.archiveRemoteHostSession({ ...request, intentId }));
    }),
    createSession: async (input) => {
      const created = await runBusiness(async () => {
        requireCapability('session-console.create');
        const profileId = requireProfile();
        const intentPayload = await remoteSessionCreateIntentPayload(input);
        assertIdentity(sourceIdentity);
        return intents.run(sourceIdentity, 'create', intentPayload, (intentId) =>
          window.api.createRemoteHostSession(mutationRequest({
            profileId, ...input, intentId,
          })));
      });
      selectSession(created.sessionId);
      return created.sessionId;
    },
    createWorkspaceDirectory: (parentDirectory, name) => runBusiness(async () => {
      requireCapability('workspace.directory.write');
      const request = mutationRequest({ profileId: requireProfile(), parentDirectory, name });
      const result = await intents.run(
        sourceIdentity,
        'workspace-directory-create',
        request,
        (intentId) => window.api.createRemoteHostWorkspaceDirectory({ ...request, intentId }),
      );
      return result.directory;
    }),
    deleteHistorySession: (session) => runBusiness(async () => {
      requireCapability('sessions.history.write');
      const request = mutationRequest({
        profileId: requireProfile(), sessionId: session.id,
        expectedArchived: session.archived, expectedUpdatedAt: session.updatedAt,
      });
      await intents.run(sourceIdentity, 'history-delete', request, (intentId) =>
        window.api.deleteRemoteHostSession({ ...request, intentId }));
    }),
    getSessionCapabilities: async (request) => {
      requireCapability('session-console.read');
      const profileId = requireProfile();
      const expectedIdentity = identityRef.current;
      const result = await window.api.getRemoteHostSessionCapabilities({ profileId, ...request });
      assertIdentity(expectedIdentity);
      return result;
    },
    listWorkspaceDirectories: async (directory) => {
      requireCapability('session-console.read');
      const profileId = requireProfile();
      const expectedIdentity = identityRef.current;
      const result = await window.api.listRemoteHostWorkspaceDirectories({ profileId, directory });
      assertIdentity(expectedIdentity);
      return result;
    },
    listOutgoing: async (adapterId) => {
      requireCapability('sessions.outgoing.read');
      const expectedIdentity = identityRef.current;
      const result = await window.api.listRemoteHostSessionOutgoing({
        ...target(),
        adapterId,
      });
      assertIdentity(expectedIdentity);
      return result;
    },
    previewHandOff: (input) => runBusiness(async () => {
      requireCapability('sessions.handoff');
      const expectedIdentity = identityRef.current;
      const result = await window.api.previewRemoteHostSessionHandOff({ ...target(), ...input });
      assertIdentity(expectedIdentity, '数据源已切换，请重新生成接力预览。');
      return result;
    }),
    commitHandOff: (input) => runTerminalBusiness(async () => {
      requireCapability('sessions.handoff');
      const request = mutationRequest({ ...target(), ...input });
      return intents.run(sourceIdentity, 'handoff', request, (intentId) =>
        window.api.commitRemoteHostSessionHandOff({ ...request, intentId }));
    }),
    interrupt: () => runBusiness(async () => {
      requireCapability('sessions.write');
      const request = mutationRequest(target());
      await intents.run(sourceIdentity, 'interrupt', request, (intentId) =>
        window.api.interruptRemoteHostSession({ ...request, intentId }));
    }),
    respondPending: (presentation, action, value) => runBusiness(async () => {
      requireCapability('pending.respond');
      if (!activeProfileId || presentation.sourceIdentity !== identityRef.current) {
        throw new Error('待处理展示已切换，请刷新后重试。');
      }
      const request = presentation.request;
      const originIdentity = sourceIdentity;
      const payload = {
        profileId: activeProfileId,
        sessionId: request.sessionId,
        requestId: request.id,
        action,
        ...(value === undefined ? {} : { value }),
        expectedRevision: presentation.revision,
        expectedPresentationDigest: await pendingPresentationBindingDigest(request),
      };
      assertIdentity(originIdentity, '待处理展示已切换，请刷新后重试。');
      const boundPayload = mutationRequest(payload);
      await intents.run(originIdentity, 'pending', boundPayload, (intentId) =>
        window.api.respondRemoteHostPending({ ...boundPayload, intentId }));
    }),
    removeOutgoing: (messageId) => runBusiness(async () => {
      requireCapability('sessions.outgoing.write');
      const request = mutationRequest({ ...target(), messageId });
      const result = await intents.run(
        sourceIdentity,
        'outgoing-remove',
        request,
        (intentId) => window.api.removeRemoteHostSessionOutgoing({ ...request, intentId }),
      );
      return result.removed;
    }),
    send: (text, attachments = []) => runBusiness(async () => {
      requireCapability('sessions.write');
      const targetRequest = target();
      const request = { ...targetRequest, text, ...(attachments.length ? { attachments } : {}) };
      const message = await remoteAttachmentIntentPayload(text, attachments);
      assertIdentity(sourceIdentity);
      const boundRequest = mutationRequest(request);
      await intents.run(sourceIdentity, 'send', { target: targetRequest, message }, (intentId) =>
        window.api.sendRemoteHostMessage({ ...boundRequest, intentId }));
    }),
    steer: (text, attachments = []) => runBusiness(async () => {
      requireCapability('sessions.write');
      const targetRequest = target();
      const request = { ...targetRequest, text, ...(attachments.length ? { attachments } : {}) };
      const message = await remoteAttachmentIntentPayload(text, attachments);
      assertIdentity(sourceIdentity);
      const boundRequest = mutationRequest(request);
      await intents.run(sourceIdentity, 'steer', { target: targetRequest, message }, (intentId) =>
        window.api.steerRemoteHostSession({ ...boundRequest, intentId }));
    }),
    updateRuntime: async (patch) => {
      const result = await runBusiness(async () => {
        requireCapability('sessions.runtime.write');
        const controls = runtimeRef.current;
        if (!controls) throw new Error('运行时控制已变化，请刷新后重试。');
        const request = mutationRequest({ ...target(), patch, expectedRevision: controls.revision });
        return intents.run(sourceIdentity, 'runtime', request, (intentId) =>
          window.api.updateRemoteHostRuntime({ ...request, intentId }));
      });
      if (result.replacementSessionId) selectSession(result.replacementSessionId);
      else {
        runtimeRef.current = result.controls;
        setRuntime(result.controls);
      }
    },
    unarchiveHistorySession: (session) => runBusiness(async () => {
      requireCapability('sessions.history.write');
      const request = mutationRequest({
        profileId: requireProfile(), sessionId: session.id,
        expectedArchived: session.archived, expectedUpdatedAt: session.updatedAt,
      });
      await intents.run(sourceIdentity, 'history-unarchive', request, (intentId) =>
        window.api.unarchiveRemoteHostSession({ ...request, intentId }));
    }),
  };
}
