import { useEffect, useMemo, useState, type JSX } from 'react';

import {
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_BYTES,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_COUNT,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MIME_TYPES,
  parseSessionConsoleAttachments,
  type SessionConsoleAttachmentPolicyDescriptor,
  type SessionConsoleCapabilitiesResult,
} from '@contracts/index';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import { ErrorBanner } from './composer-sdk/ErrorBanner';
import { RemoteSessionRuntimeControls } from './RemoteSessionRuntimeControls';
import { RemotePendingOutgoingQueue } from './RemotePendingOutgoingQueue';
import { SessionComposerView } from './SessionComposerView';

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
  const [sessionCapabilities, setSessionCapabilities] = useState<
    SessionConsoleCapabilitiesResult | null
  >(null);
  const turnBusy = source.selectedSession?.status.endsWith('-working') === true;
  const turnWaiting = source.selectedSession?.status.endsWith('-waiting') === true;
  const activeInput = source.inputCapabilities?.adapterId === adapterId
    ? source.inputCapabilities.activeTurn
    : null;
  const canSteerTurn = activeInput?.mode === 'steer' || activeInput?.mode === 'interject';
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
    setSessionCapabilities(null);
    if (!source.usable || !source.capabilities.has('session-console.read')) return;
    void source.getSessionCapabilities({
      adapterId,
      provider: runtimeString(source.runtime?.values ?? null, 'provider'),
      workingDirectory: '.',
    }).then((result) => {
      if (!cancelled) {
        setAttachmentPolicy(result.create.attachments);
        setSessionCapabilities(result);
      }
    }).catch(() => {
      if (!cancelled) {
        setAttachmentPolicy(null);
        setSessionCapabilities(null);
      }
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

  const placeholder = canWrite
    ? steerMode
      ? `${steerLabel}当前 ${agentName} 轮次…  (Enter 发送 / Shift+Enter 换行)`
      : queueMode
        ? `排队发送给当前 ${agentName} 轮次…  (Enter 发送 / Shift+Enter 换行${canUseAttachments ? ' / 可粘贴或拖放图片' : ''})`
        : `给 ${agentName} 发消息…  (Enter 发送 / Shift+Enter 换行${canUseAttachments ? ' / 可粘贴或拖放图片' : ''})`
    : '当前会话暂时不能发送消息';
  return (
    <SessionComposerView
      controls={<RemoteSessionRuntimeControls
        adapterId={adapterId}
        busy={source.busy}
        canWrite={canWriteRuntime}
        identity={identity}
        turnActive={turnBusy || turnWaiting}
        values={source.runtime?.values ?? null}
        optionSchema={sessionCapabilities?.create.options ?? null}
        onApply={source.updateRuntime}
      />}
      feedback={<>
        <RemoteReadNotice label="运行设置" message={source.runtimeLoadError} />
        <RemoteReadNotice label="输入状态" message={source.inputLoadError} />
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <ErrorBanner message={imgs.error} onDismiss={imgs.dismissError} />
      </>}
      queue={<RemotePendingOutgoingQueue
        source={source}
        adapterId={adapterId}
        sessionId={sessionId}
      />}
      input={{
        text,
        onTextChange: setText,
        submitLabel: steerMode ? steerLabel : '发送',
        busy: source.busy,
        canSubmit,
        attachments: imgs.attachments,
        getAttachmentPreviewDataUrl: imgs.getPreviewDataUrl,
        onRemoveAttachment: imgs.remove,
        onSubmit: send,
        onPaste: canUseAttachments ? imgs.onPaste : undefined,
        onDrop: canUseAttachments ? imgs.onDrop : undefined,
        onDragOver: canUseAttachments ? imgs.onDragOver : undefined,
        placeholder,
      }}
      attachment={{
        enabled: canUseAttachments,
        accept: attachmentLimits.mimeTypes.join(','),
        attachments: imgs.attachments,
        getPreviewDataUrl: imgs.getPreviewDataUrl,
        onRemove: imgs.remove,
        onAdd: (files) => { void imgs.add(files); },
      }}
      handOff={{
        disabled: !source.usable || !source.capabilities.has('sessions.handoff') || source.busy || turnBusy || turnWaiting,
        label: '接力',
        title: !source.capabilities.has('sessions.handoff')
          ? '当前版本暂不支持接力'
          : turnBusy || turnWaiting ? '当前任务完成或中断后可接力' : '接力到新会话继续',
        onClick: onHandOff,
      }}
      interrupt={{
        disabled: !canWrite || !turnBusy || interrupting,
        label: interrupting ? '中断中…' : '中断',
        title: !turnBusy ? '当前没有运行中的任务' : '中断当前任务',
        onClick: () => { void interrupt(); },
      }}
      submit={{
        disabled: !canSubmit,
        label: source.busy ? '发送中…' : steerMode ? steerLabel : '发送',
        title: steerMode ? steerLabel : '发送',
        busy: source.busy,
        onClick: () => { void send(); },
      }}
    />
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
