import { createStore } from 'zustand/vanilla';
import { storedSessionPermissionMode, type SessionPermissionMode } from '@shared/permission-modes';
import type {
  SessionAdapterId,
  SessionHandOffExecutionFailure,
  SessionHandOffPreparation,
  SessionRecord,
} from '@shared/types';
import { thinkingOptionsForAdapter, type SessionThinkingChoice } from '../SessionModelFields';

export const DEFAULT_UI_CONTINUATION_INSTRUCTION = '请基于以上会话续接上下文继续完成当前工作。';

export function sourceThinking(session: SessionRecord): SessionThinkingChoice {
  const value = session.thinking ?? '';
  return thinkingOptionsForAdapter(session.agentId).some((option) => option.value === value)
    ? value as SessionThinkingChoice : '';
}

interface Selection {
  targetAdapter: SessionAdapterId;
  targetProvider: string;
  targetModel: string;
  targetThinking: SessionThinkingChoice;
  targetPermissionMode: SessionPermissionMode;
  targetGrokSandbox: string;
  instruction: string;
}

interface State extends Selection {
  preparation: SessionHandOffPreparation | null;
  preparing: boolean;
  committing: boolean;
  completed: boolean;
  error: string | null;
  executionFailure: SessionHandOffExecutionFailure | null;
}

function createDraft(session: SessionRecord) {
  const store = createStore<State>(() => ({
    targetAdapter: session.agentId as SessionAdapterId,
    targetProvider: session.runtimeProvider ?? '',
    targetModel: session.model ?? '',
    targetThinking: sourceThinking(session),
    targetPermissionMode: storedSessionPermissionMode(session) ?? 'auto',
    targetGrokSandbox: session.agentId === 'grok-build' ? session.grokSandbox ?? '' : '',
    instruction: DEFAULT_UI_CONTINUATION_INSTRUCTION,
    preparation: null,
    preparing: false,
    committing: false,
    completed: false,
    error: null,
    executionFailure: null,
  }));
  let sequence = 0;
  let cancellation = Promise.resolve();
  const cancelPreparation = async (): Promise<void> => {
    sequence += 1;
    const id = store.getState().preparation?.preparationId;
    store.setState({ preparation: null });
    if (id) cancellation = cancellation.then(async () => {
      await window.api.handOffCancel(id);
    }).catch(() => undefined);
    await cancellation;
  };
  return {
    store,
    change(patch: Partial<Selection>): void {
      const state = store.getState();
      if (state.preparing || state.committing) return;
      void cancelPreparation();
      store.setState({ ...patch, error: null });
    },
    async prepare(): Promise<void> {
      const state = store.getState();
      if (state.preparing || state.committing || !state.instruction.trim() ||
        (state.executionFailure && state.executionFailure.successorCleanup !== 'ok')) return;
      store.setState({ preparing: true, error: null, executionFailure: null });
      await cancelPreparation();
      const request = sequence;
      try {
        const result = await window.api.handOffPrepare({
          sourceSessionId: session.id,
          continuationInstruction: state.instruction,
          target: {
            adapter: state.targetAdapter,
            ...(state.targetAdapter !== 'grok-build'
              ? { provider: state.targetProvider.trim() || null } : {}),
            model: state.targetModel.trim() || null,
            thinking: state.targetThinking || null,
            permissionMode: state.targetPermissionMode,
            ...(state.targetAdapter === 'grok-build' && state.targetGrokSandbox.trim()
              ? { grokSandbox: state.targetGrokSandbox.trim() } : {}),
          },
        });
        if (request !== sequence) {
          void window.api.handOffCancel(result.preparationId).catch(() => undefined);
          return;
        }
        store.setState({ preparation: result });
      } catch (cause) {
        if (request === sequence) store.setState({
          error: `生成续接上下文失败：${cause instanceof Error ? cause.message : String(cause)}`,
        });
      } finally {
        if (request === sequence) store.setState({ preparing: false });
      }
    },
    async commit(): Promise<void> {
      const state = store.getState();
      if (!state.preparation || state.committing || state.preparing) return;
      store.setState({ committing: true, error: null });
      try {
        const response = await window.api.handOffCommit(state.preparation.preparationId);
        store.setState({ preparation: null });
        if (response.status === 'execution-error') {
          store.setState({ executionFailure: response });
        } else if (response.sourceFinalizationWarning) {
          store.setState({ error: '新会话已创建，但源会话收尾失败。' +
            '新会话不会回滚；请检查源会话状态并按界面提示处理后，再切换继续。' });
        } else {
          store.setState({ completed: true });
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/已过期|not found|not authorized|already been consumed/i.test(message)) {
          store.setState({ preparation: null });
        }
        store.setState({ error: `创建续接会话失败：${message}` });
      } finally {
        store.setState({ committing: false });
      }
    },
  };
}

// Renderer-session state: closing a view must not own a handoff's asynchronous work.
export const localHandOffDrafts = new Map<string, ReturnType<typeof createDraft>>();

export function getLocalHandOffDraft(session: SessionRecord): ReturnType<typeof createDraft> {
  let draft = localHandOffDrafts.get(session.id);
  if (!draft) {
    draft = createDraft(session);
    localHandOffDrafts.set(session.id, draft);
  }
  return draft;
}
