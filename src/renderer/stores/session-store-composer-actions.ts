import {
  clearAttachmentPayloadSession,
} from '@renderer/hooks/image-attachments/payload-sidecar';
import type { UploadedAttachmentEntry } from '@renderer/hooks/image-attachments/types';
import {
  createComposerSession,
  mergeRecoveredAttachments,
  removeComposerSession,
  resolveComposerSessionId,
  type ComposerRequestKind,
  type ComposerSessionState,
} from './session-store-composer';

export interface ComposerStoreFields {
  composerBySession: Map<string, ComposerSessionState>;
  composerAliases: Map<string, string>;
  composerRequestSequence: number;
}

export interface ComposerStoreActions {
  ensureComposerSession: (sessionId: string, ephemeral?: boolean) => void;
  removeComposerState: (sessionId: string) => void;
  updateComposer: (
    sessionId: string,
    update: (current: ComposerSessionState) => ComposerSessionState,
  ) => boolean;
  beginComposerRequest: (
    sessionId: string,
    kind: ComposerRequestKind,
    update?: (current: ComposerSessionState) => ComposerSessionState,
  ) => number | null;
  completeComposerRequest: (
    sessionId: string,
    kind: ComposerRequestKind,
    generation: number,
    update?: (current: ComposerSessionState) => ComposerSessionState,
  ) => boolean;
  restoreFailedComposerSend: (
    sessionId: string,
    generation: number,
    text: string,
    attachments: UploadedAttachmentEntry[],
    error: string,
  ) => boolean;
}

type ComposerSetState<S extends ComposerStoreFields> = (
  updater: (state: S) => Partial<S>,
) => void;

export function createComposerStoreFields(): ComposerStoreFields {
  return {
    composerBySession: new Map(),
    composerAliases: new Map(),
    composerRequestSequence: 0,
  };
}

export function createComposerStoreActions<S extends ComposerStoreFields>(
  set: ComposerSetState<S>,
): ComposerStoreActions {
  return {
    ensureComposerSession: (sessionId, ephemeral = false) =>
      set((state) => {
        const key = resolveComposerSessionId(state.composerAliases, sessionId);
        if (state.composerBySession.has(key)) return {};
        const composerBySession = new Map(state.composerBySession);
        composerBySession.set(key, createComposerSession(ephemeral));
        return { composerBySession } as Partial<S>;
      }),

    removeComposerState: (sessionId) => {
      let releasedId = sessionId;
      set((state) => {
        const composers = removeComposerSession(
          state.composerBySession,
          state.composerAliases,
          sessionId,
        );
        releasedId = composers.resolvedId;
        return {
          composerBySession: composers.composerBySession,
          composerAliases: composers.composerAliases,
        } as Partial<S>;
      });
      clearAttachmentPayloadSession(releasedId);
    },

    updateComposer: (sessionId, update) => {
      let updated = false;
      set((state) => {
        const key = resolveComposerSessionId(state.composerAliases, sessionId);
        const current = state.composerBySession.get(key);
        if (!current) return {};
        const composerBySession = new Map(state.composerBySession);
        composerBySession.set(key, update(current));
        updated = true;
        return { composerBySession } as Partial<S>;
      });
      return updated;
    },

    beginComposerRequest: (sessionId, kind, update) => {
      let generation: number | null = null;
      set((state) => {
        const key = resolveComposerSessionId(state.composerAliases, sessionId);
        const current = state.composerBySession.get(key);
        if (!current || current.requests[kind].busy) return {};
        generation = state.composerRequestSequence + 1;
        const base = update?.(current) ?? current;
        const composerBySession = new Map(state.composerBySession);
        composerBySession.set(key, {
          ...base,
          requests: {
            ...base.requests,
            [kind]: { generation, busy: true },
          },
        });
        return {
          composerBySession,
          composerRequestSequence: generation,
        } as Partial<S>;
      });
      return generation;
    },

    completeComposerRequest: (sessionId, kind, generation, update) => {
      let completed = false;
      set((state) => {
        const key = resolveComposerSessionId(state.composerAliases, sessionId);
        const current = state.composerBySession.get(key);
        if (!current || current.requests[kind].generation !== generation) return {};
        const base = update?.(current) ?? current;
        const composerBySession = new Map(state.composerBySession);
        composerBySession.set(key, {
          ...base,
          requests: {
            ...base.requests,
            [kind]: { generation, busy: false },
          },
        });
        completed = true;
        return { composerBySession } as Partial<S>;
      });
      return completed;
    },

    restoreFailedComposerSend: (sessionId, generation, text, attachments, error) => {
      let restored = false;
      set((state) => {
        const key = resolveComposerSessionId(state.composerAliases, sessionId);
        const current = state.composerBySession.get(key);
        if (!current) return {};
        const request = current.requests.send;
        if (request.generation !== generation) return {};
        const composerBySession = new Map(state.composerBySession);
        composerBySession.set(key, {
          ...current,
          text: current.text.length === 0 ? text : current.text,
          attachments: mergeRecoveredAttachments(attachments, current.attachments),
          sendError: error,
          requests: { ...current.requests, send: { generation, busy: false } },
        });
        restored = true;
        return { composerBySession } as Partial<S>;
      });
      return restored;
    },
  };
}
