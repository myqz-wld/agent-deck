import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

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
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { CloseIcon, HandOffIcon, RefreshIcon } from '../icons';
import {
  ExpandableAuthoringField,
  ExpandableTextViewer,
} from '../hand-off/ExpandableTextSurface';
import { qualityLabel, warningLabel } from '../hand-off/labels';

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
  const remote = useRemoteSessionCreation({ active: true, source, workingDirectory: '.' });
  const [instruction, setInstruction] = useState(CONTINUATION_INSTRUCTION);
  const [prepared, setPrepared] = useState<PreparedHandOff | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const identity = `${source.identity}:${sessionId}`;

  useEffect(() => {
    requestSequence.current += 1;
    setInstruction(CONTINUATION_INSTRUCTION);
    setPrepared(null);
    setPreparing(false);
    setCommitting(false);
    setError(null);
    return () => { requestSequence.current += 1; };
  }, [identity]);

  const controls = useMemo(() => remoteControls(
    remote.descriptor,
    remote.options,
    remote.setOption,
  ), [remote.descriptor, remote.options, remote.setOption]);
  const invalidate = (change: () => void): void => {
    requestSequence.current += 1;
    setPrepared(null);
    setError(null);
    change();
  };
  const input = (): Omit<SessionHandOffPreviewParams, 'sessionId'> => {
    if (!remote.descriptor) throw new Error('远程运行时配置尚未就绪。');
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
  const warnings = prepared?.result.warnings.flatMap((warning) => {
    const label = warningLabel(warning.code);
    return label ? [{ key: `${warning.code}:${warning.message}`, label }] : [];
  }) ?? [];

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="no-drag flex max-h-[92%] w-[620px] flex-col overflow-hidden rounded-xl border border-deck-border bg-deck-bg-strong shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-deck-border px-4 py-3">
          <h2 className="flex items-center gap-1.5 text-[13px] font-medium">
            <HandOffIcon className="h-4 w-4 text-status-working" />
            <span>接力到新会话{preparing ? '（正在整理上下文…）' : committing ? '（正在提交…）' : ''}</span>
          </h2>
          <button type="button" onClick={close} disabled={committing} aria-label="关闭接力窗口" className="flex h-5 w-5 items-center justify-center rounded text-deck-muted hover:bg-white/10 disabled:opacity-50">
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4 scrollbar-deck">
          <p className="text-[10px] leading-relaxed text-deck-muted">
            运行时选项与模型列表全部来自当前 Remote Worker；工作目录继承源会话，不会读取本机 Provider 配置或本机工作区。
          </p>
          {remote.adapters.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">运行时</span>
              <DeckSelect
                value={remote.adapterId}
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
          {remote.descriptor && (
            <>
              <SessionModelDisclosure
                adapterId={remote.adapterId}
                provider={remote.options.provider ?? ''}
                model={remote.options.model ?? ''}
                thinking={(remote.options.thinking ?? '') as SessionThinkingChoice}
                disabled={busy}
                providerClosed
                providerOptions={remote.descriptor.create.options.provider.allowedValues?.map(
                  (id) => ({ id }),
                ) ?? []}
                thinkingOptions={remote.descriptor.create.options.thinking.allowedValues?.map(
                  (value) => ({ value: value as SessionThinkingChoice, label: value.toUpperCase() }),
                ) ?? []}
                onProviderChange={(value) => invalidate(() => remote.setOption('provider', value))}
                onModelChange={(value) => invalidate(() => remote.setOption('model', value))}
                onThinkingChange={(value) => invalidate(() => remote.setOption('thinking', value))}
              />
              {controls.map((control) => (
                <label key={control.label} className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">{control.label}</span>
                  <DeckSelect
                    value={control.value}
                    options={control.options}
                    onChange={(value) => invalidate(() => control.onChange(value))}
                    disabled={busy}
                    buttonClassName={SELECT_CLASS}
                  />
                </label>
              ))}
            </>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">下一步指令 / 补充与修正</span>
            <ExpandableAuthoringField
              identity={{ sessionId, kind: 'payload', payloadId: 'remote-handoff-instruction' }}
              title="编辑 Remote 接力指令"
              ariaLabel="Remote 接力下一步指令"
              triggerLabel="展开编辑 Remote 接力指令"
              value={instruction}
              disabled={busy}
              maxLength={65_536}
              rows={4}
              onChange={(value) => invalidate(() => setInstruction(value))}
            />
          </label>
          <button type="button" onClick={() => void prepare()} disabled={busy || !remote.descriptor || !instruction.trim()} className="self-start rounded bg-status-working/30 px-3 py-1.5 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50">
            {!preparing && prepared && <RefreshIcon className="mr-1 inline h-3 w-3" />}
            {preparing ? '正在整理会话上下文…' : prepared ? '重新生成续接上下文' : '生成续接上下文'}
          </button>
          {(error ?? remote.error) && (
            <div role="alert" className="rounded bg-status-waiting/10 px-3 py-2 text-[10px] text-status-waiting">{error ?? remote.error}</div>
          )}
          {prepared && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-deck-muted">
                <h3 className="font-medium text-deck-text">会话续接上下文摘录（只读）</h3>
                <span>{qualityLabel(prepared.result.quality)} · 约 {prepared.result.metrics.estimatedPromptTokens.toLocaleString()} tokens · 保留 {prepared.result.metrics.includedUserMessages} 条用户输入</span>
              </div>
              <ExpandableTextViewer ariaLabel="Remote 续接上下文摘录" value={prepared.result.preview} rows={16} monospace excerptNotice="这里仅展示有长度上限的节选；提交时 Worker 会重新生成并校验同一绑定。" />
              {(prepared.result.previewTruncated || warnings.length > 0) && (
                <div className="rounded bg-status-waiting/10 px-3 py-2 text-[10px] text-status-waiting">
                  {prepared.result.previewTruncated && <div>节选已截短，提交内容可能更完整。</div>}
                  {warnings.map((warning) => <div key={warning.key}>{warning.label}</div>)}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} disabled={committing} className="rounded px-3 py-1 text-[11px] text-deck-muted hover:bg-white/5 disabled:opacity-50">取消</button>
                <button type="button" onClick={() => void commit()} disabled={busy} className="rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50">
                  <HandOffIcon className="mr-1 inline h-3 w-3" />{committing ? '正在创建…' : '确认接力'}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
