import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  isSelectablePermissionMode,
  type AdapterSessionMode,
  type PermissionMode as ClaudePermissionMode,
  type SelectablePermissionMode,
  type SessionRecord,
} from '@shared/types';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import { ErrorBanner } from './composer-sdk/ErrorBanner';
import { PendingOutgoingQueue } from './composer-sdk/PendingOutgoingQueue';
import { SessionRuntimeControls } from './composer-sdk/SessionRuntimeControls';
import { useAdapterRuntimeInfo } from './composer-sdk/useAdapterRuntimeInfo';
import { SessionSandboxControls } from './composer-sdk/SessionSandboxControls';
import { adapterSessionModeOptions } from '@renderer/lib/adapter-session-modes';
import { useSessionStore } from '@renderer/stores/session-store';
import { composerSessionFor } from '@renderer/stores/session-store-composer';
import {
  SelectRow,
  PERMISSION_MODE_OPTIONS,
} from './composer-sdk/SandboxSelects';
import { SessionComposerView } from './SessionComposerView';
import {
  useRegisterIabComposerTarget,
  type IabComposerTarget,
} from './iab-composer-bridge';

/** SDK 会话输入区及其按逻辑会话隔离的异步操作。 */
export function ComposerSdk({
  session,
  onHandOff,
  turnBusy = false,
  canSteerTurn = false,
  canSteerTurnAttachments = false,
}: {
  session: SessionRecord;
  onHandOff?: () => void;
  /** 当前 SDK 轮次是否仍在运行；不同于本组件本地发送请求状态。 */
  turnBusy?: boolean;
  /** 当前运行时是否支持轮次中的修正消息。 */
  canSteerTurn?: boolean;
  /** 当前运行时是否允许修正消息携带图片。 */
  canSteerTurnAttachments?: boolean;
}): JSX.Element {
  const sessionId = session.id;
  const agentId = session.agentId;
  const composer = useSessionStore((state) =>
    composerSessionFor(state.composerBySession, state.composerAliases, sessionId));
  const ensureComposerSession = useSessionStore((state) => state.ensureComposerSession);
  const updateComposer = useSessionStore((state) => state.updateComposer);
  const beginComposerRequest = useSessionStore((state) => state.beginComposerRequest);
  const completeComposerRequest = useSessionStore((state) => state.completeComposerRequest);
  const restoreFailedComposerSend = useSessionStore(
    (state) => state.restoreFailedComposerSend,
  );
  const text = composer.text;
  const busy = composer.requests.send.busy;
  const sendError = composer.sendError;
  const [interrupting, setInterrupting] = useState(false);
  const imgs = useImageAttachments(sessionId);
  const adapterRuntime = useAdapterRuntimeInfo(agentId);
  const canAcceptAttachments = adapterRuntime.canAcceptAttachments;
  useEffect(() => ensureComposerSession(sessionId), [ensureComposerSession, sessionId]);
  useEffect(() => {
    if (!turnBusy) setInterrupting(false);
  }, [turnBusy]);
  // 会话记录持久化当前权限模式，详情切换和恢复后都以它为准。
  const permissionMode: ClaudePermissionMode = session.permissionMode ?? 'default';
  const permissionModeOptions: Array<{
    value: ClaudePermissionMode;
    label: string;
    title?: string;
    disabled?: boolean;
  }> =
    permissionMode === 'dontAsk'
      ? [
          {
            value: 'dontAsk',
            label: '当前状态：不询问（只读）',
            title:
              'Claude Code 恢复了 dontAsk 状态；Agent Deck 不提供该模式作为新选择，但会准确保留当前状态',
            disabled: true,
          },
          ...PERMISSION_MODE_OPTIONS,
        ]
      : [...PERMISSION_MODE_OPTIONS];
  const pmBusy = composer.requests['permission-mode'].busy;
  const pmError = composer.permissionModeError;
  const sessionMode = session.sessionMode ?? 'default';
  const sessionModeBusy = composer.requests['session-mode'].busy;
  const sessionModeError = composer.sessionModeError;

  // 运行时能力决定可用的控制项和附件入口。
  const agentDisplayName =
    agentId === 'codex-cli'
      ? 'Codex CLI'
      : agentId === 'grok-build'
        ? 'Grok Build'
        : 'Claude Code';
  const supportsPermissionMode = adapterRuntime.canSetPermissionMode;
  const supportsSessionMode =
    adapterRuntime.canSetSessionMode && adapterRuntime.sessionModes.length > 0;
  const isSteerMode = canSteerTurn && turnBusy;
  const steerActionLabel = agentId === 'codex-cli' ? '修正' : '插入';
  const canUseAttachments =
    canAcceptAttachments && (!isSteerMode || canSteerTurnAttachments);
  const iabTarget = useMemo<IabComposerTarget>(() => {
    if (adapterRuntime.loading) {
      return {
        key: `local:${sessionId}`,
        status: 'loading',
        reason: '正在读取当前会话的图片输入能力…',
      };
    }
    if (canUseAttachments) {
      return {
        key: `local:${sessionId}`,
        status: 'supported',
        reason: '',
        addPng: (file) => imgs.add([file]),
      };
    }
    const reason = !canAcceptAttachments
      ? `${agentDisplayName} 当前运行时没有声明图片输入能力，因此不能把 IAB 标注加入消息。`
      : `${agentDisplayName} 当前轮次的${steerActionLabel}只支持文字，任务结束或中断后才能添加 IAB 标注。`;
    return { key: `local:${sessionId}`, status: 'unsupported', reason };
  }, [
    adapterRuntime.loading,
    agentDisplayName,
    canAcceptAttachments,
    canUseAttachments,
    imgs.add,
    sessionId,
    steerActionLabel,
  ]);
  useRegisterIabComposerTarget(iabTarget);

  const send = async (): Promise<boolean> => {
    const originSessionId = sessionId;
    const originAgentId = agentId;
    const t = text.trim();
    const hasAttachments = imgs.attachments.length > 0;
    if (!t && !hasAttachments) return false;
    if (busy) return false;
    if (!canAcceptAttachments && hasAttachments) {
      updateComposer(originSessionId, (current) => ({
        ...current,
        sendError:
          '当前会话的运行时不支持图片输入，请移除图片后发送，或切换到支持图片的会话。',
      }));
      return false;
    }
    if (isSteerMode && hasAttachments && !canSteerTurnAttachments) {
      updateComposer(originSessionId, (current) => ({
        ...current,
        sendError:
          `${agentDisplayName} 当前轮次的${steerActionLabel}只支持文字，请移除图片后再发送。`,
      }));
      return false;
    }
    let snapshot: ReturnType<typeof imgs.snapshotForSend>;
    try {
      snapshot = imgs.snapshotForSend();
    } catch (err) {
      updateComposer(originSessionId, (current) => ({
        ...current,
        sendError: `附件读取失败：${(err as Error).message}`,
      }));
      return false;
    }
    const generation = beginComposerRequest(originSessionId, 'send', (current) => ({
      ...current,
      text: '',
      attachments: [],
      sendError: null,
    }));
    if (generation === null) return false;
    try {
      await window.api.sendAdapterMessage(originAgentId, originSessionId, {
        text: t,
        ...(snapshot.inputs.length > 0 ? { attachments: snapshot.inputs } : {}),
      });
      imgs.releasePayloads(snapshot.attachments.map((attachment) => attachment.id));
      completeComposerRequest(originSessionId, 'send', generation, (current) => ({
        ...current,
        sendError: null,
        queueRefreshVersion: current.queueRefreshVersion + 1,
      }));
      return true;
    } catch (err) {
      const restored = restoreFailedComposerSend(
        originSessionId,
        generation,
        t,
        snapshot.attachments,
        (err as Error).message,
      );
      if (!restored) {
        imgs.releasePayloads(snapshot.attachments.map((attachment) => attachment.id));
      }
      return false;
    }
  };

  const interrupt = async (): Promise<void> => {
    if (!turnBusy || interrupting) return;
    setInterrupting(true);
    try {
      await window.api.interruptAdapterSession(agentId, sessionId);
    } catch (err) {
      setInterrupting(false);
      updateComposer(sessionId, (current) => ({
        ...current,
        sendError: `中断失败：${(err as Error).message}`,
      }));
    }
  };

  const changeMode = async (next: ClaudePermissionMode): Promise<void> => {
    if (next === permissionMode || pmBusy) return;
    if (!isSelectablePermissionMode(next)) return;
    const selectableNext: SelectablePermissionMode = next;
    if (selectableNext === 'bypassPermissions') {
      const ok = await window.api.confirmDialog({
        title: '切换到完全免询问',
        message: '需要重启当前会话',
        detail:
          '重启后，Claude Code 执行工具时不再向你确认 —— 包括文件修改、Bash 命令等所有操作。重启约需 5-10 秒。\n\n' +
          '失败时会自动回到当前模式。继续？',
        okLabel: '重启并启用',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
    }
    const originSessionId = sessionId;
    const originAgentId = agentId;
    const generation = beginComposerRequest(
      originSessionId,
      'permission-mode',
      (current) => ({ ...current, permissionModeError: null }),
    );
    if (generation === null) return;
    let error: string | null = null;
    try {
      await window.api.setAdapterPermissionMode(
        originAgentId,
        originSessionId,
        selectableNext,
      );
    } catch (reason) {
      error = (reason as Error).message;
    } finally {
      completeComposerRequest(
        originSessionId,
        'permission-mode',
        generation,
        (current) => ({ ...current, permissionModeError: error }),
      );
    }
  };

  const changeSessionMode = async (next: AdapterSessionMode): Promise<void> => {
    if (next === sessionMode || sessionModeBusy) return;
    const originSessionId = sessionId;
    const originAgentId = agentId;
    const generation = beginComposerRequest(
      originSessionId,
      'session-mode',
      (current) => ({ ...current, sessionModeError: null }),
    );
    if (generation === null) return;
    let error: string | null = null;
    try {
      await window.api.setAdapterSessionMode(originAgentId, originSessionId, next);
    } catch (reason) {
      error = (reason as Error).message;
    } finally {
      completeComposerRequest(
        originSessionId,
        'session-mode',
        generation,
        (current) => ({ ...current, sessionModeError: error }),
      );
    }
  };

  const canSend = (text.trim().length > 0 || imgs.attachments.length > 0) && !busy;
  const canSubmit =
    isSteerMode && !canSteerTurnAttachments ? text.trim().length > 0 && !busy : canSend;
  const inputPlaceholder = isSteerMode
    ? `${steerActionLabel}当前 ${agentDisplayName} 轮次…  (Enter 发送 / Shift+Enter 换行)`
    : `给 ${agentDisplayName} 发消息…  (Enter 发送 / Shift+Enter 换行 / 可粘贴或拖放图片)`;
  const submitLabel = isSteerMode
    ? busy
      ? '发送中…'
      : steerActionLabel
    : busy
      ? '发送中…'
      : '发送';
  const setText = (next: string): void => {
    updateComposer(sessionId, (current) => ({ ...current, text: next }));
  };

  return (
    <SessionComposerView
      controls={<>
        <SessionRuntimeControls session={session} />
        {supportsPermissionMode && (
          <SelectRow
            label="权限"
            value={permissionMode}
            options={permissionModeOptions}
            disabled={pmBusy}
            onChange={(next) => void changeMode(next)}
          />
        )}
        {supportsSessionMode && (
          <SelectRow
            label="模式"
            value={sessionMode}
            options={adapterSessionModeOptions(adapterRuntime.sessionModes)}
            disabled={sessionModeBusy}
            onChange={(next) => void changeSessionMode(next)}
          />
        )}
        <SessionSandboxControls session={session} turnBusy={turnBusy} />
      </>}
      feedback={<>
        <ErrorBanner
          message={pmError}
          prefix="权限模式切换失败"
          onDismiss={() => updateComposer(sessionId, (current) => ({ ...current, permissionModeError: null }))}
        />
        <ErrorBanner
          message={sessionModeError}
          prefix="模式切换失败"
          onDismiss={() => updateComposer(sessionId, (current) => ({ ...current, sessionModeError: null }))}
        />
        <ErrorBanner
          message={sendError}
          onDismiss={() => updateComposer(sessionId, (current) => ({ ...current, sendError: null }))}
        />
        <ErrorBanner message={imgs.error} onDismiss={imgs.dismissError} />
      </>}
      queue={<PendingOutgoingQueue
        agentId={agentId}
        sessionId={sessionId}
        refreshVersion={composer.queueRefreshVersion}
      />}
      input={{
        text,
        onTextChange: setText,
        submitLabel: isSteerMode ? steerActionLabel : '发送',
        busy,
        canSubmit,
        attachments: imgs.attachments,
        getAttachmentPreviewDataUrl: imgs.getPreviewDataUrl,
        onRemoveAttachment: imgs.remove,
        onSubmit: send,
        onPaste: canUseAttachments ? imgs.onPaste : undefined,
        onDrop: canUseAttachments ? imgs.onDrop : undefined,
        onDragOver: canUseAttachments ? imgs.onDragOver : undefined,
        placeholder: inputPlaceholder,
      }}
      attachment={{
        enabled: canUseAttachments,
        accept: 'image/png,image/jpeg,image/gif,image/webp',
        attachments: imgs.attachments,
        getPreviewDataUrl: imgs.getPreviewDataUrl,
        onRemove: imgs.remove,
        onAdd: (files) => { void imgs.add(files); },
      }}
      handOff={onHandOff ? {
        disabled: turnBusy || session.activity === 'waiting',
        label: '接力',
        title: turnBusy || session.activity === 'waiting'
          ? '当前任务完成或中断后可接力'
          : '接力到新会话继续',
        onClick: onHandOff,
      } : undefined}
      interrupt={{
        disabled: !turnBusy || interrupting,
        label: interrupting ? '中断中…' : '中断',
        stableLabels: ['中断', '中断中…'],
        title: !turnBusy ? '当前没有运行中的任务' : interrupting ? '正在中断当前任务' : '中断当前任务',
        onClick: () => { void interrupt(); },
      }}
      submit={{
        disabled: !canSubmit,
        label: submitLabel,
        stableLabels: ['发送', '修正', '插入'],
        title: submitLabel,
        busy,
        onClick: () => { void send(); },
      }}
    />
  );
}
