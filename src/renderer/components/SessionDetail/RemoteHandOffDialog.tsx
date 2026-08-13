import { useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';

import type {
  SessionHandOffCommitResult,
  SessionHandOffPreviewParams,
  SessionHandOffPreviewResult,
} from '@contracts/index';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { SessionModelDisclosure } from '@renderer/components/SessionModelDisclosure';
import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import { useRemoteSessionCreation } from '@renderer/components/new-session/useRemoteSessionCreation';
import { remoteControls } from '@renderer/components/NewSessionDialog';
import { useModalFocus } from '@renderer/components/use-modal-focus';
import { useInitialAsyncPresentation } from '@renderer/hooks/useDelayedAsyncFallback';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RefreshIcon } from '../icons';
import {
  ExpandableAuthoringField,
  ExpandableTextViewer,
} from '../hand-off/ExpandableTextSurface';
import { qualityLabel, warningLabel } from '../hand-off/labels';
import { HandOffDialogFrame } from '../hand-off/HandOffDialogFrame';

const CONTINUATION_INSTRUCTION = '请基于以上会话续接上下文继续完成当前工作。';
const SELECT_CLASS =
  'w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20';

interface PreparedHandOff {
  input: Omit<SessionHandOffPreviewParams, 'sessionId'>;
  result: SessionHandOffPreviewResult;
}

export function RemoteHandOffDialog({
  source,
  sessionId,
  onClose,
  onCommitted,
}: {
  source: RemoteSessionSourceView;
  sessionId: string;
  onClose(): void;
  onCommitted(result: SessionHandOffCommitResult): void;
}): JSX.Element {
  const identity = `${source.identity}:${sessionId}`;
  const remote = useRemoteSessionCreation({
    active: true,
    scopeKey: `remote-handoff:${sessionId}`,
    source,
    workingDirectory: '.',
  });
  const [instruction, setInstruction] = useState(CONTINUATION_INSTRUCTION);
  const [prepared, setPrepared] = useState<PreparedHandOff | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const modalRootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const displayDescriptor = remote.presentationDescriptor;
  const displayOptions = remote.presentationOptions;

  useLayoutEffect(() => {
    requestSequence.current += 1;
    setInstruction(CONTINUATION_INSTRUCTION);
    setPrepared(null);
    setPreparing(false);
    setCommitting(false);
    setError(null);
    return () => { requestSequence.current += 1; };
  }, [identity]);

  useLayoutEffect(() => {
    requestSequence.current += 1;
    setPrepared(null);
    setPreparing(false);
    setCommitting(false);
    setError(null);
  }, [remote.readinessIdentity]);

  const controls = useMemo(() => remoteControls(
    displayDescriptor,
    displayOptions,
    remote.setOption,
  ), [displayDescriptor, displayOptions, remote.setOption]);
  const invalidate = (change: () => void): void => {
    requestSequence.current += 1;
    setPrepared(null);
    setError(null);
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
  const prepare = async (): Promise<void> => {
    if (preparing || committing || !instruction.trim()) return;
    const sequence = ++requestSequence.current;
    setPreparing(true);
    setPrepared(null);
    setError(null);
    try {
      const request = input();
      const result = await source.previewHandOff(request);
      if (sequence !== requestSequence.current) return;
      setPrepared({ input: request, result });
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (sequence === requestSequence.current) setPreparing(false);
    }
  };
  const commit = async (): Promise<void> => {
    if (!prepared || committing || preparing) return;
    const sequence = ++requestSequence.current;
    setCommitting(true);
    setError(null);
    try {
      const result = await source.commitHandOff({
        ...prepared.input,
        expectedBindingDigest: prepared.result.bindingDigest,
      });
      if (sequence !== requestSequence.current) return;
      onCommitted(result);
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (sequence === requestSequence.current) setCommitting(false);
    }
  };
  const close = (): void => {
    requestSequence.current += 1;
    onClose();
  };
  const busy = preparing || committing || remote.loading || source.busy;
  const presentation = useInitialAsyncPresentation(
    remote.initializing,
    `remote-handoff:${identity}:${remote.readinessIdentity}`,
  );
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
      primaryLabel={committing ? '正在创建续接会话…' : '打开新会话接力'}
      primaryDisabled={busy || !prepared}
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
              <SessionModelDisclosure
                adapterId={remote.presentationAdapterId}
                provider={displayOptions.provider ?? ''}
                model={displayOptions.model ?? ''}
                thinking={(displayOptions.thinking ?? '') as SessionThinkingChoice}
                disabled={busy}
                providerClosed={!displayDescriptor.create.options.provider.allowCustom}
                providerOptions={displayDescriptor.create.options.provider.allowedValues?.map(
                  (id) => ({ id }),
                ) ?? []}
                thinkingOptions={displayDescriptor.create.options.thinking.allowedValues?.map(
                  (value) => ({ value: value as SessionThinkingChoice, label: value.toUpperCase() }),
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
              {controls.map((control) => (
                <label key={control.label} className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">{control.label}</span>
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
              onChange={(value) => invalidate(() => setInstruction(value))}
            />
          </label>
          <button type="button" onClick={() => void prepare()} disabled={busy || !remote.descriptor || !instruction.trim()} className="self-start rounded bg-status-working/30 px-3 py-1.5 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50">
            {!preparing && prepared && <RefreshIcon className="mr-1 inline h-3 w-3" />}
            {preparing ? '正在整理会话上下文…' : prepared ? '重新生成续接上下文' : '生成续接上下文'}
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
