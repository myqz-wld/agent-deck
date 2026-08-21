import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type {
  AdapterSessionMode,
  SessionAdapterId,
  SessionHandOffExecutionFailure,
  SessionHandOffPreparation,
  SessionRecord,
} from '@shared/types';
import { useInitialAsyncPresentation } from '@renderer/hooks/useDelayedAsyncFallback';
import { RefreshIcon } from './icons';
import { StableButtonContent } from './StableButtonContent';
import {
  thinkingOptionsForAdapter,
  type SessionThinkingChoice,
} from './SessionModelFields';
import {
  executionFailureLabel,
  qualityLabel,
  warningLabel,
} from './hand-off/labels';
import {
  ExpandableAuthoringField,
  ExpandableTextViewer,
} from './hand-off/ExpandableTextSurface';
import {
  TargetRuntimeFields,
  type HandOffAdapterOption,
} from './hand-off/TargetRuntimeFields';
import { useModalFocus } from './use-modal-focus';
import { HandOffDialogFrame } from './hand-off/HandOffDialogFrame';

interface Props {
  open: boolean;
  session: SessionRecord;
  onClose: () => void;
}

export const DEFAULT_UI_CONTINUATION_INSTRUCTION = '请基于以上会话续接上下文继续完成当前工作。';
// Failed successor cleanup must remain acknowledged across close/reopen and source navigation.
const pendingOrphanAcknowledgements = new Map<string, SessionHandOffExecutionFailure>();

interface HandOffAdapterProjection {
  identity: string;
  adapters: HandOffAdapterOption[];
}

function sourceThinking(session: SessionRecord): SessionThinkingChoice {
  const value = session.thinking ?? '';
  return thinkingOptionsForAdapter(session.agentId).some((option) => option.value === value)
    ? (value as SessionThinkingChoice)
    : '';
}

export function HandOffPreviewDialog({ open, session, onClose }: Props): JSX.Element | null {
  const sessionId = session.id;
  const previousOpenRef = useRef(open);
  const openCycleRef = useRef(0);
  if (previousOpenRef.current !== open) {
    previousOpenRef.current = open;
    openCycleRef.current += 1;
  }
  const configurationIdentity = `local-handoff:${sessionId}:${openCycleRef.current}`;
  const [adapterProjection, setAdapterProjection] = useState<HandOffAdapterProjection>({
    identity: '',
    adapters: [],
  });
  const adapters = adapterProjection.identity === configurationIdentity
    ? adapterProjection.adapters
    : [];
  const [targetAdapter, setTargetAdapter] = useState<SessionAdapterId>(session.agentId as SessionAdapterId);
  const [targetProvider, setTargetProvider] = useState(session.runtimeProvider ?? '');
  const [targetModel, setTargetModel] = useState(session.model ?? '');
  const [targetThinking, setTargetThinking] = useState<SessionThinkingChoice>(() =>
    sourceThinking(session),
  );
  const [targetSessionMode, setTargetSessionMode] = useState<AdapterSessionMode>(
    session.sessionMode ?? 'default',
  );
  const [targetGrokSandbox, setTargetGrokSandbox] = useState(
    session.agentId === 'grok-build' ? session.grokSandbox ?? '' : '',
  );
  const [instruction, setInstruction] = useState(DEFAULT_UI_CONTINUATION_INSTRUCTION);
  const [preparation, setPreparation] = useState<SessionHandOffPreparation | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [executionFailure, setExecutionFailure] =
    useState<SessionHandOffExecutionFailure | null>(null);
  const requestSequence = useRef(0);
  const preparationId = useRef<string | null>(null);
  const prepareInFlight = useRef(false);
  const commitInFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const cancelPreparation = (): void => {
    requestSequence.current += 1;
    const id = preparationId.current;
    preparationId.current = null;
    setPreparation(null);
    if (id) void window.api.handOffCancel(id).catch(() => undefined);
  };

  useEffect(() => {
    if (!open) return;
    cancelPreparation();
    setTargetAdapter(session.agentId as SessionAdapterId);
    setTargetProvider(session.runtimeProvider ?? '');
    setTargetModel(session.model ?? '');
    setTargetThinking(sourceThinking(session));
    setTargetSessionMode(session.sessionMode ?? 'default');
    setTargetGrokSandbox(
      session.agentId === 'grok-build' ? session.grokSandbox ?? '' : '',
    );
    setInstruction(DEFAULT_UI_CONTINUATION_INSTRUCTION);
    setPreparing(false);
    setCommitting(false);
    setError(null);
    setExecutionFailure(pendingOrphanAcknowledgements.get(sessionId) ?? null);
    prepareInFlight.current = false;
    commitInFlight.current = false;
    return () => {
      requestSequence.current += 1;
      const id = preparationId.current;
      preparationId.current = null;
      if (id && !commitInFlight.current) {
        void window.api.handOffCancel(id).catch(() => undefined);
      }
    };
    // sessionId is the reset boundary; other session fields are frozen again by main during prepare.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.api
      .listAdapters()
      .then((rows) => {
        if (cancelled) return;
        setAdapterProjection({
          identity: configurationIdentity,
          adapters: rows
            .filter(
              (row): row is typeof row & { id: SessionAdapterId } =>
                row.capabilities.canCreateSession === true &&
                (row.id === 'claude-code' ||
                  row.id === 'codex-cli' ||
                  row.id === 'grok-build'),
            )
            .map((row) => ({
              value: row.id,
              label: row.displayName,
              sessionModes: row.sessionModes ?? [],
            })),
        });
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setAdapterProjection({ identity: configurationIdentity, adapters: [] });
          setError(`加载助手配置失败：${caught instanceof Error ? caught.message : String(caught)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [configurationIdentity, open]);

  const close = (): void => {
    if (commitInFlight.current) return;
    cancelPreparation();
    prepareInFlight.current = false;
    commitInFlight.current = false;
    setPreparing(false);
    setCommitting(false);
    onClose();
  };
  const configurationPending = open && adapterProjection.identity !== configurationIdentity;
  const presentation = useInitialAsyncPresentation(
    configurationPending,
    configurationIdentity,
  );
  useModalFocus({
    blocked: committing,
    dialogRef,
    onClose: close,
    open: open && presentation !== 'deferred',
  });

  if (!open) return null;
  if (presentation === 'deferred') {
    return <div data-session-handoff-frame className="absolute inset-0 z-40 bg-black/40 backdrop-blur-sm" />;
  }

  const invalidateAndChange = (change: () => void): void => {
    if (preparationId.current) cancelPreparation();
    setError(null);
    change();
  };

  const prepare = async (): Promise<void> => {
    if (
      prepareInFlight.current ||
      !instruction.trim() ||
      (executionFailure && executionFailure.successorCleanup !== 'ok')
    ) {
      return;
    }
    prepareInFlight.current = true;
    cancelPreparation();
    setPreparing(true);
    setError(null);
    setExecutionFailure(null);
    const sequence = requestSequence.current;
    try {
      const result = await window.api.handOffPrepare({
        sourceSessionId: sessionId,
        continuationInstruction: instruction,
        target: {
          adapter: targetAdapter,
          ...(targetAdapter !== 'grok-build'
            ? { provider: targetProvider.trim() || null }
            : {}),
          model: targetModel.trim() || null,
          thinking: targetThinking || null,
          ...(adapters.find((adapter) => adapter.value === targetAdapter)
            ?.sessionModes.length
            ? { sessionMode: targetSessionMode }
            : {}),
          ...(targetAdapter === 'grok-build' && targetGrokSandbox.trim()
            ? { grokSandbox: targetGrokSandbox.trim() }
            : {}),
        },
      });
      if (sequence !== requestSequence.current) {
        void window.api.handOffCancel(result.preparationId).catch(() => undefined);
        return;
      }
      preparationId.current = result.preparationId;
      setPreparation(result);
    } catch (caught) {
      if (sequence === requestSequence.current) {
        setError(`生成续接上下文失败：${caught instanceof Error ? caught.message : String(caught)}`);
      }
    } finally {
      if (sequence === requestSequence.current) {
        prepareInFlight.current = false;
        setPreparing(false);
      }
    }
  };

  const commit = async (): Promise<void> => {
    const id = preparationId.current;
    if (!id || commitInFlight.current) return;
    commitInFlight.current = true;
    const sequence = requestSequence.current;
    setCommitting(true);
    setError(null);
    try {
      const response = await window.api.handOffCommit(id);
      if (sequence !== requestSequence.current) {
        if (
          response.status === 'execution-error'
          && response.successorCleanup !== 'ok'
        ) {
          pendingOrphanAcknowledgements.set(sessionId, response);
        }
        return;
      }
      preparationId.current = null;
      setPreparation(null);
      if (response.status === 'execution-error') {
        if (response.successorCleanup !== 'ok') {
          pendingOrphanAcknowledgements.set(sessionId, response);
        }
        setExecutionFailure(response);
        return;
      }
      const result = response;
      if (result.sourceFinalizationWarning) {
        setError(
          '新会话已创建，但源会话收尾失败。' +
            '新会话不会回滚；请检查源会话状态并按界面提示处理后，再切换继续。',
        );
        return;
      }
      onClose();
    } catch (caught) {
      if (sequence !== requestSequence.current) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      if (/已过期|not found|not authorized|already been consumed/i.test(message)) {
        preparationId.current = null;
        setPreparation(null);
      }
      setError(`创建续接会话失败：${message}`);
    } finally {
      if (sequence === requestSequence.current) {
        commitInFlight.current = false;
        setCommitting(false);
      }
    }
  };

  const busy = preparing || committing;
  const visibleWarnings = preparation?.warnings.flatMap((warning) => {
    const label = warningLabel(warning.code);
    return label ? [{ key: `${warning.code}:${warning.message}`, label }] : [];
  }) ?? [];
  return (
    <HandOffDialogFrame
      dialogRef={dialogRef}
      titleId={titleId}
      statusText={preparing ? '正在整理会话上下文…' : committing ? '正在创建…' : undefined}
      busy={committing}
      onClose={close}
      primaryLabel="打开新会话接力"
      primaryBusyLabel="正在创建续接会话…"
      primaryDisabled={busy || !preparation}
      onPrimary={() => { void commit(); }}
      ariaBusy={presentation === 'fallback'}
    >
        {presentation === 'fallback' ? (
          <div
            role="status"
            className="flex min-h-40 items-center justify-center p-4 text-[11px] text-deck-muted"
          >
            正在读取会话配置…
          </div>
        ) : <>
          <p className="text-[10px] leading-relaxed text-deck-muted">
            上下文整理方式由“会话续接上下文”设置控制；下方选项只决定新会话使用的助手、模型和思考程度。
          </p>

          <TargetRuntimeFields
            adapters={adapters}
            busy={busy}
            targetAdapter={targetAdapter}
            targetProvider={targetProvider}
            targetModel={targetModel}
            targetThinking={targetThinking}
            targetSessionMode={targetSessionMode}
            targetGrokSandbox={targetGrokSandbox}
            onAdapterChange={(next) =>
              invalidateAndChange(() => {
                setTargetAdapter(next);
                if (next === session.agentId) {
                  setTargetProvider(session.runtimeProvider ?? '');
                  setTargetModel(session.model ?? '');
                  setTargetThinking(sourceThinking(session));
                  setTargetSessionMode(session.sessionMode ?? 'default');
                  setTargetGrokSandbox(
                    session.agentId === 'grok-build' ? session.grokSandbox ?? '' : '',
                  );
                } else {
                  setTargetProvider('');
                  setTargetModel('');
                  setTargetThinking('');
                  setTargetSessionMode(
                    adapters.find((adapter) => adapter.value === next)?.sessionModes[0]
                      ?? 'default',
                  );
                  setTargetGrokSandbox('');
                }
              })
            }
            onProviderChange={(next) =>
              invalidateAndChange(() => {
                setTargetProvider(next);
                setTargetModel('');
              })
            }
            onModelChange={(next) => invalidateAndChange(() => setTargetModel(next))}
            onThinkingChange={(next) =>
              invalidateAndChange(() => setTargetThinking(next))
            }
            onSessionModeChange={(next) =>
              invalidateAndChange(() => setTargetSessionMode(next))
            }
            onGrokSandboxChange={(next) =>
              invalidateAndChange(() => setTargetGrokSandbox(next))
            }
          />

          <div className="flex flex-col gap-1 text-[10px] text-deck-muted">
            <span className="uppercase tracking-wider text-deck-muted/70">
              下一步指令 / 补充与修正
            </span>
            <ExpandableAuthoringField
              identity={{
                sessionId,
                kind: 'payload',
                payloadId: 'handoff-continuation-instruction',
              }}
              title="编辑下一步指令"
              ariaLabel="下一步指令 / 补充与修正"
              triggerLabel="展开编辑下一步指令"
              value={instruction}
              disabled={busy}
              maxLength={102_400}
              rows={4}
              onChange={(value) =>
                invalidateAndChange(() => setInstruction(value))
              }
            />
          </div>

          <button
            type="button"
            onClick={() => void prepare()}
            disabled={
              busy ||
              !instruction.trim() ||
              (executionFailure !== null && executionFailure.successorCleanup !== 'ok')
            }
            className="self-start rounded bg-status-working/30 px-3 py-1.5 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
          >
            <StableButtonContent
              activeKey={preparing ? 'busy' : preparation ? 'refresh' : 'idle'}
              variants={[
                { key: 'idle', content: '生成续接上下文' },
                {
                  key: 'refresh',
                  content: <><RefreshIcon className="mr-1 h-3 w-3" />重新生成续接上下文</>,
                },
                { key: 'busy', content: '正在整理会话上下文…' },
              ]}
            />
          </button>

          {preparation && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-deck-muted">
                <h3 className="font-medium text-deck-text">会话续接上下文摘录（只读）</h3>
                <span>
                  {qualityLabel(preparation.quality)} · 约{' '}
                  {preparation.metrics.estimatedPromptTokens.toLocaleString()} tokens · 保留{' '}
                  {preparation.metrics.includedUserMessages} 条用户输入
                </span>
              </div>
              <ExpandableTextViewer
                ariaLabel="续接上下文摘录"
                value={preparation.preview}
                rows={16}
                monospace
                excerptNotice="这里仅展示有长度上限的节选；实际发送给模型的内容可能更完整。"
              />
              {(preparation.previewTruncated || visibleWarnings.length > 0) && (
                <div className="rounded bg-status-waiting/10 px-3 py-2 text-[10px] text-status-waiting">
                  {preparation.previewTruncated && (
                    <div>
                      节选已截短，未展示全部内容；实际发送给模型的内容可能更完整。
                    </div>
                  )}
                  {visibleWarnings.map((warning) => (
                    <div key={warning.key}>{warning.label}</div>
                  ))}
                </div>
              )}
            </section>
          )}

          {executionFailure && (
            <div
              role="alert"
              className="space-y-2 rounded bg-status-error/10 px-3 py-2 text-[11px] text-status-error"
            >
              <div>⚠️ {executionFailureLabel(executionFailure)}</div>
              {executionFailure.usedLowerBudgetRetry && (
                <div>本次已尝试使用较小范围的续接上下文。</div>
              )}
              {executionFailure.successorCleanup !== 'ok' && (
                <button
                  type="button"
                  onClick={() => {
                    pendingOrphanAcknowledgements.delete(sessionId);
                    setExecutionFailure(null);
                  }}
                  className="rounded border border-status-error/40 px-2 py-1 text-[10px] hover:bg-status-error/10"
                >
                  我已检查会话列表，允许重新生成
                </button>
              )}
            </div>
          )}

          {error && (
            <div className="rounded bg-status-waiting/10 px-3 py-2 text-[11px] text-status-waiting">
              ⚠️ {error}
            </div>
          )}
        </>}
    </HandOffDialogFrame>
  );
}
