import { storedSessionPermissionMode } from '@shared/permission-modes';
import { useStore } from 'zustand';
import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type {
  SessionAdapterId,
  SessionRecord,
} from '@shared/types';
import { useInitialAsyncPresentation } from '@renderer/hooks/useDelayedAsyncFallback';
import { AlertTriangleIcon, RefreshIcon } from './icons';
import { StableButtonContent } from './StableButtonContent';
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
import { getLocalHandOffDraft, localHandOffDrafts, sourceThinking } from './hand-off/local-draft';
export { DEFAULT_UI_CONTINUATION_INSTRUCTION } from './hand-off/local-draft';

interface Props {
  open: boolean;
  session: SessionRecord;
  onClose: () => void;
}

interface HandOffAdapterProjection {
  identity: string;
  adapters: HandOffAdapterOption[];
  error?: string;
}

export function HandOffPreviewDialog({ open, session, onClose }: Props): JSX.Element | null {
  return open ? <LocalHandOffDialog key={session.id} session={session} onClose={onClose} /> : null;
}

function LocalHandOffDialog({ session, onClose }: Omit<Props, 'open'>): JSX.Element {
  const sessionId = session.id;
  const [draft] = useState(() => getLocalHandOffDraft(session));
  const {
    targetAdapter, targetProvider, targetModel, targetThinking, targetPermissionMode,
    targetGrokSandbox, instruction, preparation, preparing, committing, completed,
    error, executionFailure,
  } = useStore(draft.store);
  const configurationIdentity = `local-handoff:${sessionId}`;
  const [adapterProjection, setAdapterProjection] = useState<HandOffAdapterProjection>({
    identity: '', adapters: [],
  });
  const adapters = adapterProjection.adapters;
  const visibleError = error ?? adapterProjection.error;
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const completionHandled = useRef(false);
  useEffect(() => {
    if (!completed || completionHandled.current) return;
    completionHandled.current = true;
    localHandOffDrafts.delete(sessionId);
    onClose();
  }, [completed, onClose, sessionId]);

  useEffect(() => {
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
          setAdapterProjection({
            identity: configurationIdentity,
            adapters: [],
            error: `加载助手配置失败：${caught instanceof Error ? caught.message : String(caught)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [configurationIdentity, draft]);

  const close = (): void => {
    if (!draft.store.getState().committing) onClose();
  };
  const configurationPending = adapterProjection.identity !== configurationIdentity;
  const presentation = useInitialAsyncPresentation(
    configurationPending,
    configurationIdentity,
  );
  useModalFocus({
    blocked: committing,
    dialogRef,
    onClose: close,
    open: presentation !== 'deferred',
  });

  if (presentation === 'deferred') {
    return <div data-session-handoff-frame className="absolute inset-0 z-40 bg-black/40 backdrop-blur-sm" />;
  }

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
      onDiscard={preparation ? () => { draft.change({}); onClose(); } : undefined}
      primaryLabel="打开新会话接力"
      primaryBusyLabel="正在创建续接会话…"
      primaryDisabled={busy || !preparation}
      onPrimary={() => { void draft.commit(); }}
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
            targetPermissionMode={targetPermissionMode}
            targetGrokSandbox={targetGrokSandbox}
            onAdapterChange={(next) => draft.change({
              targetAdapter: next,
              ...(next === session.agentId ? {
                targetProvider: session.runtimeProvider ?? '',
                targetModel: session.model ?? '',
                targetThinking: sourceThinking(session),
                targetPermissionMode: storedSessionPermissionMode(session) ?? 'auto',
                targetGrokSandbox: session.agentId === 'grok-build' ? session.grokSandbox ?? '' : '',
              } : {
                targetProvider: '', targetModel: '', targetThinking: '' as const,
                targetPermissionMode: 'auto' as const, targetGrokSandbox: '',
              }),
            })}
            onProviderChange={(next) => draft.change({ targetProvider: next, targetModel: '' })}
            onModelChange={(next) => draft.change({ targetModel: next })}
            onThinkingChange={(next) => draft.change({ targetThinking: next })}
            onPermissionModeChange={(next) => draft.change({ targetPermissionMode: next })}
            onGrokSandboxChange={(next) => draft.change({ targetGrokSandbox: next })}
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
              onChange={(value) => draft.change({ instruction: value })}
            />
          </div>

          <button
            type="button"
            onClick={() => void draft.prepare()}
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
              <div><AlertTriangleIcon className="mr-1 inline h-3 w-3 align-text-bottom" />{executionFailureLabel(executionFailure)}</div>
              {executionFailure.usedLowerBudgetRetry && (
                <div>本次已尝试使用较小范围的续接上下文。</div>
              )}
              {executionFailure.successorCleanup !== 'ok' && (
                <button
                  type="button"
                  onClick={() => {
                    draft.store.setState({ executionFailure: null });
                  }}
                  className="rounded border border-status-error/40 px-2 py-1 text-[10px] hover:bg-status-error/10"
                >
                  我已检查会话列表，允许重新生成
                </button>
              )}
            </div>
          )}

          {visibleError && (
            <div className="rounded bg-status-waiting/10 px-3 py-2 text-[11px] text-status-waiting">
              <AlertTriangleIcon className="mr-1 inline h-3 w-3 align-text-bottom" />{visibleError}
            </div>
          )}
        </>}
    </HandOffDialogFrame>
  );
}
