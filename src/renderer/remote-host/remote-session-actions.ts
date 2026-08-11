import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import type { RemoteHostRuntimeControlsDto } from '@shared/remote-host';

import type { RemoteSessionSourceView } from './source-types';
import {
  RemoteUserIntentLedger,
  remoteAttachmentIntentPayload,
  remoteSessionCreateIntentPayload,
} from './remote-intent-ledger';
import { pendingPresentationBindingDigest } from './remote-pending-presentation';

type SessionActions = Pick<RemoteSessionSourceView,
  | 'commitHandOff'
  | 'createSession'
  | 'getSessionCapabilities'
  | 'interrupt'
  | 'listWorkspaceDirectories'
  | 'previewHandOff'
  | 'respondPending'
  | 'send'
  | 'steer'
  | 'updateRuntime'>;

interface RemoteSessionActionOptions {
  activeProfileId: string | null;
  identityRef: MutableRefObject<string>;
  intents: RemoteUserIntentLedger;
  requireCapability(capability: string): void;
  runBusiness<T>(operation: () => Promise<T>): Promise<T>;
  runTerminalBusiness<T>(operation: () => Promise<T>): Promise<T>;
  runtimeRef: MutableRefObject<RemoteHostRuntimeControlsDto | null>;
  selectSession(sessionId: string | null): void;
  setRuntime: Dispatch<SetStateAction<RemoteHostRuntimeControlsDto | null>>;
  target(): { profileId: string; sessionId: string };
}

/** Identity-fenced Remote session actions shared by detail and creation surfaces. */
export function createRemoteSessionActions(
  options: RemoteSessionActionOptions,
): SessionActions {
  const {
    activeProfileId,
    identityRef,
    intents,
    requireCapability,
    runBusiness,
    runTerminalBusiness,
    runtimeRef,
    selectSession,
    setRuntime,
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

  return {
    createSession: async (input) => {
      const created = await runBusiness(async () => {
        requireCapability('session-console.create');
        const profileId = requireProfile();
        const intentPayload = await remoteSessionCreateIntentPayload(input);
        return intents.run(identityRef.current, 'create', intentPayload, (intentId) =>
          window.api.createRemoteHostSession({ profileId, ...input, intentId }));
      });
      selectSession(created.sessionId);
      return created.sessionId;
    },
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
    previewHandOff: (input) => runBusiness(async () => {
      requireCapability('sessions.handoff');
      const expectedIdentity = identityRef.current;
      const result = await window.api.previewRemoteHostSessionHandOff({ ...target(), ...input });
      assertIdentity(expectedIdentity, '数据源已切换，请重新生成接力预览。');
      return result;
    }),
    commitHandOff: (input) => runTerminalBusiness(async () => {
      requireCapability('sessions.handoff');
      const request = { ...target(), ...input };
      return intents.run(identityRef.current, 'handoff', request, (intentId) =>
        window.api.commitRemoteHostSessionHandOff({ ...request, intentId }));
    }),
    interrupt: () => runBusiness(async () => {
      requireCapability('sessions.write');
      const request = target();
      await intents.run(identityRef.current, 'interrupt', request, (intentId) =>
        window.api.interruptRemoteHostSession({ ...request, intentId }));
    }),
    respondPending: (presentation, action, value) => runBusiness(async () => {
      requireCapability('pending.respond');
      if (!activeProfileId || presentation.sourceIdentity !== identityRef.current) {
        throw new Error('待处理展示已切换，请刷新后重试。');
      }
      const request = presentation.request;
      const payload = {
        profileId: activeProfileId,
        sessionId: request.sessionId,
        requestId: request.id,
        action,
        ...(value === undefined ? {} : { value }),
        expectedRevision: presentation.revision,
        expectedPresentationDigest: await pendingPresentationBindingDigest(request),
      };
      await intents.run(identityRef.current, 'pending', payload, (intentId) =>
        window.api.respondRemoteHostPending({ ...payload, intentId }));
    }),
    send: (text, attachments = []) => runBusiness(async () => {
      requireCapability('sessions.write');
      const request = { ...target(), text, ...(attachments.length ? { attachments } : {}) };
      const message = await remoteAttachmentIntentPayload(text, attachments);
      await intents.run(identityRef.current, 'send', { target: target(), message }, (intentId) =>
        window.api.sendRemoteHostMessage({ ...request, intentId }));
    }),
    steer: (text, attachments = []) => runBusiness(async () => {
      requireCapability('sessions.write');
      const request = { ...target(), text, ...(attachments.length ? { attachments } : {}) };
      const message = await remoteAttachmentIntentPayload(text, attachments);
      await intents.run(identityRef.current, 'steer', { target: target(), message }, (intentId) =>
        window.api.steerRemoteHostSession({ ...request, intentId }));
    }),
    updateRuntime: async (patch) => {
      const result = await runBusiness(async () => {
        requireCapability('sessions.runtime.write');
        const controls = runtimeRef.current;
        if (!controls) throw new Error('运行时控制已变化，请刷新后重试。');
        const request = { ...target(), patch, expectedRevision: controls.revision };
        return intents.run(identityRef.current, 'runtime', request, (intentId) =>
          window.api.updateRemoteHostRuntime({ ...request, intentId }));
      });
      if (result.replacementSessionId) selectSession(result.replacementSessionId);
      else {
        runtimeRef.current = result.controls;
        setRuntime(result.controls);
      }
    },
  };
}
