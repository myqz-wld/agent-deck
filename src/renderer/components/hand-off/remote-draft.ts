import { createStore } from 'zustand/vanilla';
import type {
  SessionHandOffCommitResult,
  SessionHandOffPreviewParams,
  SessionHandOffPreviewResult,
} from '@contracts/index';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import type { RemoteSessionCreationDraft } from '../new-session/useRemoteSessionCreation';
import { DEFAULT_UI_CONTINUATION_INSTRUCTION } from './local-draft';

type PreviewInput = Omit<SessionHandOffPreviewParams, 'sessionId'>;

interface State {
  instruction: string;
  selection: RemoteSessionCreationDraft | null;
  prepared: { input: PreviewInput; result: SessionHandOffPreviewResult } | null;
  preparing: boolean;
  committing: boolean;
  error: string | null;
  completed: SessionHandOffCommitResult | null;
}

function createDraft() {
  const store = createStore<State>(() => ({
    instruction: DEFAULT_UI_CONTINUATION_INSTRUCTION,
    selection: null,
    prepared: null,
    preparing: false,
    committing: false,
    error: null,
    completed: null,
  }));
  let sequence = 0;
  return {
    store,
    invalidate(): void {
      sequence += 1;
      store.setState({ prepared: null, preparing: false, error: null });
    },
    async prepare(source: RemoteSessionSourceView, input: PreviewInput): Promise<void> {
      const state = store.getState();
      if (state.preparing || state.committing || !input.continuationInstruction.trim()) return;
      const request = ++sequence;
      store.setState({ preparing: true, prepared: null, error: null });
      try {
        const result = await source.previewHandOff(input);
        if (request === sequence) store.setState({ prepared: { input, result } });
      } catch (cause) {
        if (request === sequence) store.setState({
          error: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        if (request === sequence) store.setState({ preparing: false });
      }
    },
    async commit(source: RemoteSessionSourceView): Promise<void> {
      const state = store.getState();
      if (!state.prepared || state.committing || state.preparing) return;
      store.setState({ committing: true, error: null });
      try {
        const result = await source.commitHandOff({
          ...state.prepared.input,
          expectedBindingDigest: state.prepared.result.bindingDigest,
        });
        store.setState({ prepared: null, completed: result });
      } catch (cause) {
        store.setState({ error: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        store.setState({ committing: false });
      }
    },
  };
}

export const remoteHandOffDrafts = new Map<string, ReturnType<typeof createDraft>>();

export function remoteHandOffIdentity(sourceIdentity: string, sessionId: string): string {
  return JSON.stringify([sourceIdentity, sessionId]);
}

export function getRemoteHandOffDraft(identity: string): ReturnType<typeof createDraft> {
  let draft = remoteHandOffDrafts.get(identity);
  if (!draft) {
    draft = createDraft();
    remoteHandOffDrafts.set(identity, draft);
  }
  return draft;
}
