import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useStore } from 'zustand';

import type {
  SessionHandOffCommitResult,
  SessionHandOffPreviewParams,
} from '@contracts/index';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { SessionModelDisclosure } from '@renderer/components/SessionModelDisclosure';
import { StableButtonContent } from '@renderer/components/StableButtonContent';
import { InertInteractionBoundary } from '@renderer/components/InertInteractionBoundary';
import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import { useRemoteSessionCreation } from '@renderer/components/new-session/useRemoteSessionCreation';
import { remoteControls } from '@renderer/components/NewSessionDialog';
import { useModalFocus } from '@renderer/components/use-modal-focus';
import {
  useDelayedAsyncFallback,
  useInitialAsyncPresentation,
} from '@renderer/hooks/useDelayedAsyncFallback';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RefreshIcon } from '../icons';
import {
  ExpandableAuthoringField,
  ExpandableTextViewer,
} from '../hand-off/ExpandableTextSurface';
import { qualityLabel, warningLabel } from '../hand-off/labels';
import { HandOffDialogFrame } from '../hand-off/HandOffDialogFrame';
import { getRemoteHandOffDraft, remoteHandOffDrafts, remoteHandOffIdentity } from '../hand-off/remote-draft';

const SELECT_CLASS =
  'w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20';

interface Props {
  source: RemoteSessionSourceView;
  sessionId: string;
  onClose(): void;
  onCommitted(result: SessionHandOffCommitResult): void;
}

export function RemoteHandOffDialog(props: Props): JSX.Element {
  const identity = remoteHandOffIdentity(props.source.identity, props.sessionId);
  return <RemoteHandOffDialogContent key={identity} {...props} identity={identity} />;
}

function RemoteHandOffDialogContent({
  source, sessionId, onClose, onCommitted, identity,
}: Props & { identity: string }): JSX.Element {
  const [draft] = useState(() => getRemoteHandOffDraft(identity));
  const { instruction, prepared, preparing, committing, error, completed } = useStore(draft.store);
  const remote = useRemoteSessionCreation({
    active: true,
    scopeKey: `remote-handoff:${sessionId}`,
    source,
    workingDirectory: '.',
    initialDraft: draft.store.getState().selection,
  });
  const modalRootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const displayDescriptor = remote.presentationDescriptor;
  const displayOptions = remote.presentationOptions;
  const completionHandled = useRef(false);
  useEffect(() => {
    if (!completed || completionHandled.current) return;
    completionHandled.current = true;
    remoteHandOffDrafts.delete(identity);
    onCommitted(completed);
  }, [completed, identity, onCommitted]);
  useLayoutEffect(() => {
    draft.store.setState({ selection: remote.draft });
  }, [draft, remote.draft]);
  const available = source.usable && source.capabilities.has('session-console.read') &&
    source.capabilities.has('sessions.handoff');
  useLayoutEffect(() => {
    if (!available) draft.invalidate();
  }, [available, draft]);
  // Reopening revalidates capabilities; retain the preview only for the same effective target.
  useLayoutEffect(() => {
    if (!remote.descriptor || !prepared) return;
    if (prepared.input.target.adapterId !== remote.adapterId ||
      Object.entries(prepared.input.target.options).some(([key, value]) =>
        remote.options[key as keyof typeof remote.options] !== value)) draft.invalidate();
  }, [draft, prepared, remote.adapterId, remote.descriptor, remote.options]);

  const controls = useMemo(() => remoteControls(
    displayDescriptor,
    displayOptions,
    remote.setOption,
  ), [displayDescriptor, displayOptions, remote.setOption]);
  const invalidate = (change: () => void): void => {
    if (draft.store.getState().preparing || draft.store.getState().committing) return;
    draft.invalidate();
    change();
  };
  const input = (): Omit<SessionHandOffPreviewParams, 'sessionId'> => {
    if (!remote.descriptor) throw new Error('远端会话设置尚未就绪。');
    return {
      continuationInstruction: instruction,
      target: {
        adapterId: remote.adapterId as 'claude-code' | 'codex-cli' | 'grok-build',
        workingDirectory: null,
        capabilityRevision: null,
        options: remote.options,
      },
    };
  };
  const prepare = (): void => {
    if (remote.descriptor && available) void draft.prepare(source, input());
  };
  const close = (): void => {
    if (!draft.store.getState().committing) onClose();
  };
  const busy = preparing || committing || source.busy;
  const configurationInteractionBlocked = remote.loading;
  const presentation = useInitialAsyncPresentation(
    remote.initializing,
    `remote-handoff:${identity}:${remote.readinessIdentity}`,
  );
  const showConfigurationProgress = useDelayedAsyncFallback(
    presentation === 'ready' && remote.loading,
    `remote-handoff:${identity}:${remote.readinessIdentity}:configuration`,
  );
  const primaryDisabled = busy || !available || configurationInteractionBlocked || !prepared;
  const prepareDisabled = busy || !available || configurationInteractionBlocked ||
    !remote.descriptor || !instruction.trim();
  const settledPrimaryDisabledRef = useRef(primaryDisabled);
  const settledPrepareDisabledRef = useRef(prepareDisabled);
  useLayoutEffect(() => {
    if (configurationInteractionBlocked) return;
    settledPrimaryDisabledRef.current = primaryDisabled;
    settledPrepareDisabledRef.current = prepareDisabled;
  }, [configurationInteractionBlocked, prepareDisabled, primaryDisabled]);
  const primaryVisuallyDisabled = configurationInteractionBlocked && !showConfigurationProgress
    ? settledPrimaryDisabledRef.current
    : primaryDisabled;
  const prepareVisuallyDisabled = configurationInteractionBlocked && !showConfigurationProgress
    ? settledPrepareDisabledRef.current
    : prepareDisabled;
  useModalFocus({
    blocked: committing,
    dialogRef: modalRootRef,
    onClose: close,
    open: presentation !== 'deferred',
  });
  const warnings = prepared?.result.warnings.flatMap((warning) => {
    const label = warningLabel(warning.code);
    return label ? [{ key: `${warning.code}:${warning.message}`, label }] : [];
  }) ?? [];

  if (presentation === 'deferred') {
    return <div data-session-handoff-frame className="absolute inset-0 z-40 bg-black/40 backdrop-blur-sm" />;
  }
  return (
    <HandOffDialogFrame
      dialogRef={modalRootRef}
      titleId={titleId}
      statusText={preparing ? '正在整理会话上下文…' : committing ? '正在创建…' : undefined}
      busy={committing}
      onClose={close}
      onDiscard={prepared ? () => { draft.invalidate(); onClose(); } : undefined}
      primaryLabel="打开新会话接力"
      primaryBusyLabel="正在创建续接会话…"
      primaryDisabled={primaryDisabled}
      primaryVisuallyDisabled={primaryVisuallyDisabled}
      footerStatus={showConfigurationProgress ? (
        <div
          role="status"
          className="truncate rounded bg-white/[0.035] px-2 py-1 text-[10px] text-deck-muted"
        >
          正在更新会话配置…
        </div>
      ) : undefined}
      onPrimary={() => { if (available && remote.descriptor) void draft.commit(source); }}
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
            下方选项决定新会话使用的运行方式、模型和思考程度；工作目录继承当前会话。
          </p>
          {remote.adapters.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">助手</span>
              <DeckSelect
                value={remote.presentationAdapterId}
                options={remote.adapters.map((adapter) => ({
                  value: adapter.adapterId,
                  label: adapter.displayName,
                  disabled: !adapter.enabled,
                  description: adapter.disabledReason,
                }))}
                onChange={(value) => invalidate(() => remote.setAdapterId(value))}
                disabled={busy}
                buttonClassName={SELECT_CLASS}
              />
            </label>
          )}
          {displayDescriptor && (
            <>
              <InertInteractionBoundary blocked={configurationInteractionBlocked}>
                <SessionModelDisclosure
                  adapterId={remote.presentationAdapterId}
                  provider={displayOptions.provider ?? ''}
                  model={displayOptions.model ?? ''}
                  thinking={(displayOptions.thinking ?? '') as SessionThinkingChoice}
                  disabled={busy}
                  providerOptions={displayDescriptor.create.options.provider.allowedValues?.map(
                    (id) => ({ id }),
                  ) ?? []}
                  thinkingOptions={displayDescriptor.create.options.thinking.allowedValues?.map(
                    (value) => ({
                      value: value as SessionThinkingChoice,
                      label: value.toUpperCase(),
                    }),
                  ) ?? []}
                  disabledReasons={{
                    provider: displayDescriptor.create.options.provider.enabled
                      ? null : displayDescriptor.create.options.provider.disabledReason,
                    model: displayDescriptor.create.options.model.enabled
                      ? null : displayDescriptor.create.options.model.disabledReason,
                    thinking: displayDescriptor.create.options.thinking.enabled
                      ? null : displayDescriptor.create.options.thinking.disabledReason,
                  }}
                  onProviderChange={(value) => invalidate(() => remote.setOption('provider', value))}
                  onModelChange={(value) => invalidate(() => remote.setOption('model', value))}
                  onThinkingChange={(value) => invalidate(() => remote.setOption('thinking', value))}
                />
              </InertInteractionBoundary>
              {controls.map((control) => (
                <InertInteractionBoundary
                  key={control.label}
                  blocked={configurationInteractionBlocked}
                >
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">
                      {control.label}
                    </span>
                    {control.disabledReason ? (
                      <div className="break-words rounded border border-white/[0.07] bg-white/[0.03] px-2 py-1.5 text-[10px] leading-relaxed text-deck-muted [overflow-wrap:anywhere]">
                        不可用：{control.disabledReason}
                      </div>
                    ) : (
                      <DeckSelect
                        value={control.value}
                        options={control.options}
                        onChange={(value) => invalidate(() => control.onChange(value))}
                        disabled={busy}
                        buttonClassName={SELECT_CLASS}
                      />
                    )}
                  </label>
                </InertInteractionBoundary>
              ))}
            </>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">下一步指令 / 补充与修正</span>
            <ExpandableAuthoringField
              identity={{ sessionId, kind: 'payload', payloadId: 'remote-handoff-instruction' }}
              title="编辑下一步指令"
              ariaLabel="下一步指令 / 补充与修正"
              triggerLabel="展开编辑下一步指令"
              value={instruction}
              disabled={busy}
              maxLength={102_400}
              rows={4}
              onChange={(value) => invalidate(() => draft.store.setState({ instruction: value }))}
            />
          </label>
          <button
            type="button"
            onClick={() => void prepare()}
            disabled={prepareDisabled}
            className={`self-start rounded bg-status-working/30 px-3 py-1.5 text-[11px] text-status-working hover:bg-status-working/40 ${
              prepareVisuallyDisabled ? 'opacity-50' : ''
            }`}
          >
            <StableButtonContent
              activeKey={preparing ? 'busy' : prepared ? 'refresh' : 'idle'}
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
          {(error ?? remote.error) && (
            <div role="alert" className="flex items-center justify-between gap-2 rounded bg-status-waiting/10 px-3 py-2 text-[10px] text-status-waiting">
              <span>{error ?? remote.error}</span>
              {!error && remote.error && (
                <button
                  type="button"
                  onClick={remote.retry}
                  className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15"
                >
                  重试读取配置
                </button>
              )}
            </div>
          )}
          {prepared && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-deck-muted">
                <h3 className="font-medium text-deck-text">会话续接上下文摘录（只读）</h3>
                <span>{qualityLabel(prepared.result.quality)} · 约 {prepared.result.metrics.estimatedPromptTokens.toLocaleString()} tokens · 保留 {prepared.result.metrics.includedUserMessages} 条用户输入</span>
              </div>
              <ExpandableTextViewer ariaLabel="续接上下文摘录" value={prepared.result.preview} rows={16} monospace excerptNotice="这里仅展示有长度上限的节选；实际发送给模型的内容可能更完整。" />
              {(prepared.result.previewTruncated || warnings.length > 0) && (
                <div className="rounded bg-status-waiting/10 px-3 py-2 text-[10px] text-status-waiting">
                  {prepared.result.previewTruncated && <div>节选已截短，提交内容可能更完整。</div>}
                  {warnings.map((warning) => <div key={warning.key}>{warning.label}</div>)}
                </div>
              )}
            </section>
          )}
        </>}
    </HandOffDialogFrame>
  );
}
