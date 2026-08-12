import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import {
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_BYTES,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_COUNT,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MIME_TYPES,
  parseSessionConsoleAttachments,
  type SessionConsoleAttachmentPolicyDescriptor,
} from '@contracts/index';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import { PendingImageAttachments } from '../PendingImageAttachments';
import { HandOffIcon, ImageIcon, SendIcon, StopIcon } from '../icons';
import { ComposerInput } from './composer-sdk/ComposerInput';
import { ErrorBanner } from './composer-sdk/ErrorBanner';
import { RemoteSessionRuntimeControls } from './RemoteSessionRuntimeControls';
import { RemotePendingOutgoingQueue } from './RemotePendingOutgoingQueue';

export function RemoteSessionComposer({
  source,
  adapterId,
  sessionId,
  onHandOff = () => undefined,
}: {
  source: RemoteSessionSourceView;
  adapterId: string;
  sessionId: string;
  onHandOff?: () => void;
}): JSX.Element {
  const identity = `${source.identity}:${sessionId}`;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [interrupting, setInterrupting] = useState(false);
  const [attachmentPolicy, setAttachmentPolicy] = useState<
    SessionConsoleAttachmentPolicyDescriptor | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const turnBusy = source.selectedSession?.status.endsWith('-working') === true;
  const turnWaiting = source.selectedSession?.status.endsWith('-waiting') === true;
  const activeInput = source.inputCapabilities?.adapterId === adapterId
    ? source.inputCapabilities.activeTurn
    : null;
  const legacySteer = !source.capabilities.has('sessions.input.read') &&
    (adapterId === 'codex-cli' || adapterId === 'grok-build');
  const canSteerTurn = activeInput?.mode === 'steer' || activeInput?.mode === 'interject' ||
    legacySteer;
  const steerMode = turnBusy && canSteerTurn;
  const queueMode = turnBusy && activeInput?.mode === 'queue';
  const effectiveAttachmentPolicy = turnBusy
    ? activeInput?.attachments ?? null
    : attachmentPolicy;
  const attachmentLimits = useMemo(() => ({
    maxBytesEach: effectiveAttachmentPolicy?.maxBytesEach ??
      SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_BYTES,
    maxBytesTotal: effectiveAttachmentPolicy?.maxBytesTotal ??
      SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES,
    maxCount: effectiveAttachmentPolicy?.maxCount ?? SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_COUNT,
    mimeTypes: effectiveAttachmentPolicy?.mimeTypes ??
      SESSION_CONSOLE_REMOTE_ATTACHMENT_MIME_TYPES,
  }), [effectiveAttachmentPolicy]);
  const imgs = useImageAttachments(`remote:${identity}`, attachmentLimits);
  const canWrite = source.usable && source.capabilities.has('sessions.write');
  const canWriteRuntime = source.usable && source.capabilities.has('sessions.runtime.write');
  const steerLabel = adapterId === 'codex-cli' ? '修正' : '插入';

  useEffect(() => {
    setText('');
    setError(null);
    setInterrupting(false);
    imgs.clear();
  }, [identity]);
  useEffect(() => {
    if (!turnBusy) setInterrupting(false);
  }, [turnBusy]);
  useEffect(() => {
    let cancelled = false;
    setAttachmentPolicy(null);
    if (!source.usable || !source.capabilities.has('session-console.read')) return;
    void source.getSessionCapabilities({
      adapterId,
      provider: runtimeString(source.runtime?.values ?? null, 'provider'),
      workingDirectory: '.',
    }).then((result) => {
      if (!cancelled) setAttachmentPolicy(result.create.attachments);
    }).catch(() => {
      if (!cancelled) setAttachmentPolicy(null);
    });
    return () => { cancelled = true; };
  }, [adapterId, identity, source.runtime?.revision, source.usable]);

  const send = async (): Promise<boolean> => {
    const message = text.trim();
    if (source.busy || (!message && imgs.attachments.length === 0)) return false;
    try {
      const snapshot = imgs.snapshotForSend();
      const attachments = parseSessionConsoleAttachments(snapshot.inputs, 'attachments');
      if (steerMode) {
        await source.steer(message, attachments);
      } else {
        await source.send(message, attachments);
      }
      imgs.clear();
      setText('');
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };
  const interrupt = async (): Promise<void> => {
    if (!turnBusy || interrupting) return;
    setInterrupting(true);
    try { await source.interrupt(); }
    catch (cause) {
      setInterrupting(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const canUseAttachments = effectiveAttachmentPolicy?.enabled === true;
  const canSubmit = canWrite && !source.busy &&
    (text.trim().length > 0 || (canUseAttachments && imgs.attachments.length > 0));
  const agentName = adapterId === 'codex-cli'
    ? 'Codex CLI'
    : adapterId === 'grok-build'
      ? 'Grok Build'
      : 'Claude Code';

  return (
    <div data-remote-session-composer className="shrink-0 border-t border-deck-border px-2.5 py-2">
      <RemoteSessionRuntimeControls
        adapterId={adapterId}
        busy={source.busy || turnBusy || turnWaiting}
        canWrite={canWriteRuntime}
        identity={identity}
        values={source.runtime?.values ?? null}
        onApply={source.updateRuntime}
      />
      <RemoteReadNotice label="远端运行时状态" message={source.runtimeLoadError} />
      <RemoteReadNotice label="活动回合输入能力" message={source.inputLoadError} />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <ErrorBanner message={imgs.error} onDismiss={imgs.dismissError} />
      <RemotePendingOutgoingQueue
        source={source}
        adapterId={adapterId}
        sessionId={sessionId}
      />
      <ComposerInput
        text={text}
        onTextChange={setText}
        submitLabel={steerMode ? steerLabel : '发送'}
        busy={source.busy}
        canSubmit={canSubmit}
        attachments={imgs.attachments}
        getAttachmentPreviewDataUrl={imgs.getPreviewDataUrl}
        onRemoveAttachment={imgs.remove}
        onSubmit={send}
        onPaste={canUseAttachments ? imgs.onPaste : undefined}
        onDrop={canUseAttachments ? imgs.onDrop : undefined}
        onDragOver={canUseAttachments ? imgs.onDragOver : undefined}
        placeholder={canWrite
          ? steerMode
            ? `${steerLabel}当前 Remote ${agentName} 轮次…  (Enter 发送 / Shift+Enter 换行)`
            : queueMode
              ? `排队发送给当前 Remote ${agentName} 轮次…  (Enter 发送 / Shift+Enter 换行${canUseAttachments ? ' / 可粘贴或拖放图片' : ''})`
            : `给 Remote ${agentName} 发消息…  (Enter 发送 / Shift+Enter 换行${canUseAttachments ? ' / 可粘贴或拖放图片' : ''})`
          : '此 Remote 数据源未提供 session 写入能力'}
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        {canUseAttachments && (
          <>
            <input ref={fileInputRef} type="file" accept={attachmentLimits.mimeTypes.join(',')} multiple className="hidden" onChange={(event) => {
              void imgs.add(event.target.files);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }} />
            <button type="button" onClick={() => fileInputRef.current?.click()} className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text" title="上传图片到 Remote Worker（也可粘贴 / 拖放）" aria-label="上传图片">
              <ImageIcon className="h-4 w-4" />
            </button>
          </>
        )}
        {imgs.attachments.length > 0 && (
          <PendingImageAttachments attachments={imgs.attachments} getPreviewDataUrl={imgs.getPreviewDataUrl} onRemove={imgs.remove} />
        )}
        <div className="flex-1" />
        <button type="button" onClick={onHandOff} disabled={!source.usable || !source.capabilities.has('sessions.handoff') || source.busy || turnBusy || turnWaiting} className="h-7 shrink-0 rounded px-2.5 text-[10px] text-deck-muted hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40" title={!source.capabilities.has('sessions.handoff') ? '此 Remote Core 未提供接力能力' : turnBusy || turnWaiting ? '当前任务完成或中断后可接力' : '在当前 Remote Worker 上创建原子续接会话'}>
          <HandOffIcon className="mr-1 inline h-3 w-3" />接力
        </button>
        <button type="button" onClick={() => void interrupt()} disabled={!canWrite || !turnBusy || interrupting} className="h-7 shrink-0 rounded px-2.5 text-[10px] text-deck-muted hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40" title={!turnBusy ? '当前没有运行中的 Remote 任务' : '中断当前 Remote 任务'}>
          <StopIcon className="mr-1 inline h-3 w-3" />{interrupting ? '中断中…' : '中断'}
        </button>
        <button type="button" onClick={() => void send()} disabled={!canSubmit} className="h-7 shrink-0 rounded bg-status-working/30 px-3 text-[10px] font-medium text-status-working hover:bg-status-working/40 disabled:opacity-40">
          {!source.busy && <SendIcon className="mr-1 inline h-3 w-3" />}{source.busy ? '发送中…' : steerMode ? steerLabel : '发送'}
        </button>
      </div>
    </div>
  );
}

function runtimeString(values: Record<string, unknown> | null, key: string): string {
  const value = values?.[key];
  return typeof value === 'string' ? value : '';
}

function RemoteReadNotice({
  label,
  message,
}: {
  label: string;
  message: string | null | undefined;
}): JSX.Element | null {
  if (!message) return null;
  return (
    <div role="status" className="mb-1.5 rounded border border-status-waiting/40 bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
      ⚠️ {label}：{message}
    </div>
  );
}
