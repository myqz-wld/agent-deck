import { useRef, useState, type JSX } from 'react';
import {
  isSelectablePermissionMode,
  type AdapterSessionMode,
  type PermissionMode as ClaudePermissionMode,
  type SelectablePermissionMode,
  type SessionRecord,
} from '@shared/types';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import { PendingImageAttachments } from '@renderer/components/PendingImageAttachments';
import log from '@renderer/utils/logger';
import { HandOffIcon, ImageIcon, SendIcon, StopIcon } from '../icons';
import { ComposerInput } from './composer-sdk/ComposerInput';
import { ErrorBanner } from './composer-sdk/ErrorBanner';
import { PendingOutgoingQueue } from './composer-sdk/PendingOutgoingQueue';
import { SessionRuntimeControls } from './composer-sdk/SessionRuntimeControls';
import { useAdapterRuntimeInfo } from './composer-sdk/useAdapterRuntimeInfo';
import { SessionSandboxControls } from './composer-sdk/SessionSandboxControls';
import { adapterSessionModeOptions } from '@renderer/lib/adapter-session-modes';
import {
  SelectRow,
  PERMISSION_MODE_OPTIONS,
} from './composer-sdk/SandboxSelects';

const logger = log.scope('renderer-composer-sdk');

/**
 * SDK 会话的输入区 + 权限模式下拉。
 *
 * 关键护栏（不要破坏）：
 * - bypassPermissions 必须冷切（重启 SDK 子进程），切换前弹 confirm 二次确认；
 *   ipc.ts SetPermissionMode handler 检测到 bypass 时路由到 restartWithPermissionMode
 * - sendError / pmError 失败时把文本回填到输入框（乐观清空），用户能改文字继续发
 * - 通道断连恢复已沉到 sdk-bridge.sendMessage 内部（CHANGELOG_26 / B 方案），
 *   renderer 不再判断「断连 vs 真错」——直接显示 sdk-bridge 抛出的 message
 * - 图片附件：粘贴 / 拖放 / 上传按钮三件套；缩略图 strip 在 textarea 上方。
 *   失败回填只回填文字（base64 已 clear），用户需重新粘 / 拖 — 这是 trade-off：
 *   保留 base64 ref 让「乐观清空」语义混乱，多数失败是真错而非 race
 *
 * **CHANGELOG_105 拆分**：原 512 LOC 单文件按档位 1 抽 3 个 sub-component:
 * - `../icons/`                         shared source-owned SVG chrome
 * - `composer-sdk/ErrorBanner.tsx`      通用错误条（5 处复用）
 * - `composer-sdk/SandboxSelects.tsx`   通用 SelectRow + permission/codex/claude 三组 options
 */
export function ComposerSdk({
  session,
  onHandOff,
  turnBusy = false,
  canSteerTurn = false,
  canSteerTurnAttachments = false,
}: {
  /** deep-review H3 MED：直接接收 parent 的 session record（= App detailSession，store.sessions
   *  优先 + closed 会话 historySession 兜底），不再自己 `sessions.get(sessionId)`。旧实现自读 store
   *  对 closed 会话（不在 active+dormant Map）返 undefined → permission/sandbox 三下拉落 fallback
   *  显示比实际更宽松（如真实 strict 显示成 off）。CLAUDE.md「detail 视图权威 = store.sessions」
   *  对 closed 不成立，故以 parent prop 为准。 */
  session: SessionRecord;
  /** CHANGELOG_94: 「📤 接力到新会话」按钮触发 callback，由 SessionDetail 渲染
   *  HandOffPreviewDialog。仅当 prop 传入时显示按钮（CLI 会话不传，逻辑由
   *  SessionDetail 决定）。 */
  onHandOff?: () => void;
  /** 当前 SDK turn 是否仍在运行中；不同于本组件本地 send IPC busy。 */
  turnBusy?: boolean;
  /** Adapter capability: 当前会话是否支持 mid-turn steering。 */
  canSteerTurn?: boolean;
  /** Adapter capability: mid-turn steering 是否接受图片附件。 */
  canSteerTurnAttachments?: boolean;
}): JSX.Element {
  const sessionId = session.id;
  const agentId = session.agentId;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // REVIEW_35 MED-D-claude-4：busyRef 同步锁，防超快连点（< 16ms）双 send race
  const busyRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [queueRefreshVersion, setQueueRefreshVersion] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgs = useImageAttachments();
  const adapterRuntime = useAdapterRuntimeInfo(agentId);
  const canAcceptAttachments = adapterRuntime.canAcceptAttachments;
  // SDK Query 自身持有运行时 permissionMode 但不暴露 getter，所以从 session 记录的
  // permission_mode 列读用户选择或 provider 上报的当前权威状态。这是持久化的（DB），
  // 切别的 detail 再切回来 / 重启 dev / 恢复会话，下拉都能正确还原。
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
            label: '提供方状态：不询问（只读）',
            title:
              'Claude 恢复了 dontAsk 状态；Agent Deck 不提供该模式作为新选择，但会准确保留当前状态',
            disabled: true,
          },
          ...PERMISSION_MODE_OPTIONS,
        ]
      : [...PERMISSION_MODE_OPTIONS];
  const [pmBusy, setPmBusy] = useState(false);
  const [pmError, setPmError] = useState<string | null>(null);
  const sessionMode = session.sessionMode ?? 'default';
  const [sessionModeBusy, setSessionModeBusy] = useState(false);
  const [sessionModeError, setSessionModeError] = useState<string | null>(null);

  // 多 agent 适配：
  // - 标签 / placeholder 文案用对应 agent 名（Claude / Codex / ...）
  // - 权限模式 select 仅 Claude Code 桥接层显示（codex SDK 没有运行时切权限模式；REVIEW_35 MED-D-codex-3
  //   修法：用 capabilities.canSetPermissionMode 而非 `agentId !== 'codex-cli'` —— 后者把
  //   不支持 setPermissionMode 的 adapter 错归入支持类，切换抛 IPC 错）
  // - codex sandbox select 仅 codex-cli 显示（claude 没有 codex 那套档位）
  // - claude OS sandbox select 仅 Claude Code 桥接层显示（CHANGELOG_74，与 codex 字面镜像）
  // - 图片附件入口（粘贴 / 拖放 / 上传）按 capabilities.canAcceptAttachments gate；
  //   Codex busy steer 模式暂时禁用附件入口；支持图片 interjection 的 adapter 可显式放开
  //   （REVIEW_35 HIGH-D2：当前三种 SDK adapter 都 true；白名单 gate 防止未来新
  //   adapter 默认就拿到 attachments 路径，必须显式 opt-in）
  const agentDisplayName =
    agentId === 'codex-cli'
      ? 'Codex'
      : agentId === 'grok-build'
        ? 'Grok'
        : 'Claude';
  const supportsPermissionMode = adapterRuntime.canSetPermissionMode;
  const supportsSessionMode =
    adapterRuntime.canSetSessionMode && adapterRuntime.sessionModes.length > 0;
  const isSteerMode = canSteerTurn && turnBusy;
  const steerActionLabel = agentId === 'codex-cli' ? '修正' : '插入';
  const canUseAttachments =
    canAcceptAttachments && (!isSteerMode || canSteerTurnAttachments);

  const send = async (): Promise<boolean> => {
    const t = text.trim();
    const hasAttachments = imgs.attachments.length > 0;
    // 允许「只发图不带文字」：text 空 + 至少一张图 → 走发送
    if (!t && !hasAttachments) return false;
    // REVIEW_35 MED-D-claude-4：busyRef 同步锁，busy state async 不立即生效，超快连点（< 16ms）
    // 第 2 次闭包仍看 busy=false 重复发同款消息（attachments 已 clear，发空附件 / 空文本）
    if (busyRef.current) return false;
    if (busy) return false;
    // REVIEW_35 HIGH-D2：不在白名单的 adapter
    // gate 拒发并保留 attachments（不调 imgs.clear()）让用户能切 adapter 或删图后重发；
    // 静默丢图 + 失去 retry 能力的旧版本回归不可接受
    if (!canAcceptAttachments && hasAttachments) {
      setSendError(
        '当前会话的 adapter 未协商图片输入能力，请移除图片后发送，或切换到支持图片的会话。',
      );
      return false;
    }
    if (isSteerMode && hasAttachments && !canSteerTurnAttachments) {
      setSendError(`${agentDisplayName} 当前 turn 的${steerActionLabel}只支持文字，请移除图片后再发送。`);
      return false;
    }
    busyRef.current = true;
    // 乐观清空：让用户立刻感觉「发出去了」
    setText('');
    setBusy(true);
    setSendError(null);
    // 拍快照：清 hook 前先取出 IPC inputs（基于当前 attachments 的 fullBase64）
    let attachmentInputs: ReturnType<typeof imgs.toIpcInputs>;
    try {
      attachmentInputs = imgs.toIpcInputs();
    } catch (err) {
      busyRef.current = false;
      setBusy(false);
      setText(t);
      setSendError(`附件读取失败：${(err as Error).message}`);
      return false;
    }
    imgs.clear();
    try {
      // 通道断连恢复已沉到 sdk-bridge.sendMessage 内部（CHANGELOG_26 / B 方案）：
      // 主进程检测到 !sessions.has(sessionId) 自动单飞 createSession({resume,prompt,cwd,permissionMode}),
      // 走完整 H4/H1 护栏 + emit 占位 message。renderer 在这里**不再判断**「断连 vs 真错」。
      // 唯一例外：sessionRepo 完全没记录 → sdk-bridge 仍抛 'session X not found'，
      // 此时显示原 message 即可（这种情况理论上不会发生，session 一旦创建就在 DB 里）。
      await window.api.sendAdapterMessage(agentId, sessionId, {
        text: t,
        ...(attachmentInputs.length > 0 ? { attachments: attachmentInputs } : {}),
      });
      setQueueRefreshVersion((version) => version + 1);
      return true;
    } catch (err) {
      logger.error('sendAdapterMessage failed', err);
      setText(t);
      setSendError((err as Error).message);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const interrupt = async (): Promise<void> => {
    try {
      await window.api.interruptAdapterSession(agentId, sessionId);
    } catch (err) {
      logger.error('interrupt failed', err);
    }
  };

  const changeMode = async (next: ClaudePermissionMode): Promise<void> => {
    if (next === permissionMode || pmBusy) return;
    // Provider may restore `dontAsk`, but it is intentionally read-only in Agent Deck. Every
    // public mutation surface remains restricted to the five product-supported choices.
    if (!isSelectablePermissionMode(next)) return;
    const selectableNext: SelectablePermissionMode = next;
    // bypassPermissions 必须冷切：SDK 的 allowDangerouslySkipPermissions flag 在 CLI
    // 子进程启动时锁死，运行时调 setPermissionMode('bypassPermissions') 会被 SDK 静默吞。
    // ipc.ts 的 SetPermissionMode handler 检测到 bypass 时会路由到 restartWithPermissionMode：
    // 销毁旧 SDK 子进程 + 用 flag=true 重建（5-10s busy）。失败会回滚到原 mode + emit error msg。
    // 注：外层已 `next !== permissionMode` early-return，故只判 `next === 'bypassPermissions'`。
    if (selectableNext === 'bypassPermissions') {
      const ok = await window.api.confirmDialog({
        title: '切换到完全免询问',
        message: '需要重启当前会话',
        detail:
          '重启后，Claude 执行工具时不再向你确认 —— 包括文件修改、Bash 命令等所有操作。重启约需 5-10 秒。\n\n' +
          '失败时会自动回到当前模式。继续？',
        okLabel: '重启并启用',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
    }
    setPmBusy(true);
    setPmError(null);
    try {
      // IPC 主进程会同时调 SDK + 写 sessions.permission_mode + 推 session-upserted，
      // store 的 sessions Map 会自动更新，下拉值跟着 session 记录变。
      await window.api.setAdapterPermissionMode(agentId, sessionId, selectableNext);
    } catch (err) {
      setPmError((err as Error).message);
    } finally {
      setPmBusy(false);
    }
  };

  const changeSessionMode = async (next: AdapterSessionMode): Promise<void> => {
    if (next === sessionMode || sessionModeBusy) return;
    setSessionModeBusy(true);
    setSessionModeError(null);
    try {
      await window.api.setAdapterSessionMode(agentId, sessionId, next);
    } catch (error) {
      setSessionModeError((error as Error).message);
    } finally {
      setSessionModeBusy(false);
    }
  };

  const canSend = (text.trim().length > 0 || imgs.attachments.length > 0) && !busy;
  const canSubmit =
    isSteerMode && !canSteerTurnAttachments ? text.trim().length > 0 && !busy : canSend;
  const inputPlaceholder = isSteerMode
    ? `${steerActionLabel}当前 ${agentDisplayName} turn…  (Enter 发送 / Shift+Enter 换行)`
    : `给 ${agentDisplayName} 发消息…  (Enter 发送 / Shift+Enter 换行 / 可粘贴或拖放图片)`;
  const submitLabel = isSteerMode
    ? busy
      ? '发送中…'
      : steerActionLabel
    : busy
      ? '发送中…'
      : '发送';
  const getAttachmentPreviewDataUrl = (id: string): string | null => {
    const index = imgs.attachments.findIndex((attachment) => attachment.id === id);
    if (index < 0) return null;
    try {
      const input = imgs.toIpcInputs()[index];
      return input ? `data:${input.mime};base64,${input.base64}` : null;
    } catch {
      return null;
    }
  };

  return (
    <div className="shrink-0 border-t border-deck-border px-2.5 py-2">
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
          label="工作模式"
          value={sessionMode}
          options={adapterSessionModeOptions(adapterRuntime.sessionModes)}
          disabled={sessionModeBusy}
          onChange={(next) => void changeSessionMode(next)}
        />
      )}
      <SessionSandboxControls session={session} turnBusy={turnBusy} />
      <ErrorBanner message={pmError} prefix="权限模式切换失败" onDismiss={() => setPmError(null)} />
      <ErrorBanner
        message={sessionModeError}
        prefix="工作模式切换失败"
        onDismiss={() => setSessionModeError(null)}
      />
      <ErrorBanner message={sendError} onDismiss={() => setSendError(null)} />
      <ErrorBanner message={imgs.error} onDismiss={imgs.dismissError} />
      <PendingOutgoingQueue
        agentId={agentId}
        sessionId={sessionId}
        refreshVersion={queueRefreshVersion}
      />
      <ComposerInput
        text={text}
        onTextChange={setText}
        submitLabel={isSteerMode ? steerActionLabel : '发送'}
        busy={busy}
        canSubmit={canSubmit}
        attachments={imgs.attachments}
        getAttachmentPreviewDataUrl={getAttachmentPreviewDataUrl}
        onRemoveAttachment={imgs.remove}
        onSubmit={send}
        // REVIEW_35 HIGH-D2：仅允许附件入口时才绑 paste/drop/dragover；
        // 不在白名单 / 不支持附件的 steer 模式不绑，防止拖入后静默丢图。
        onPaste={canUseAttachments ? imgs.onPaste : undefined}
        onDrop={canUseAttachments ? imgs.onDrop : undefined}
        onDragOver={canUseAttachments ? imgs.onDragOver : undefined}
        placeholder={inputPlaceholder}
      />
      {/* 下方工具栏：左 = 上传图片 + 缩略图，右 = 中断 / 发送。
          替代了原「右侧三按钮纵向堆叠」+「单独 attachments strip」，让附件操作分组、
          发送/中断作为主操作右对齐。所有图标复用 renderer SVG chrome。 */}
      <div className="mt-1.5 flex items-center gap-1.5">
        {/* REVIEW_35 HIGH-D2：仅允许附件入口时才显示图片按钮 */}
        {canUseAttachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                void imgs.add(e.target.files);
                // 重置 input.value 让用户可重选同名文件
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text"
              title="上传图片（也可粘贴 / 拖放）"
              aria-label="上传图片"
            >
              <ImageIcon className="h-4 w-4" />
            </button>
          </>
        )}
        {imgs.attachments.length > 0 && (
          <PendingImageAttachments
            attachments={imgs.attachments}
            getPreviewDataUrl={getAttachmentPreviewDataUrl}
            onRemove={imgs.remove}
          />
        )}
        <div className="flex-1" />
        {onHandOff && (
          <button
            type="button"
            onClick={onHandOff}
            disabled={turnBusy || session.activity === 'waiting'}
            className="h-7 shrink-0 rounded px-2.5 text-[10px] text-deck-muted hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              turnBusy || session.activity === 'waiting'
                ? '当前任务完成或中断后可接力'
                : '接力到新会话：生成会话续接上下文，然后按所选目标运行时打开新会话继续'
            }
          >
            <HandOffIcon className="mr-1 inline h-3 w-3" />接力
          </button>
        )}
        <button
          type="button"
          onClick={() => void interrupt()}
          className="h-7 shrink-0 rounded px-2.5 text-[10px] text-deck-muted hover:bg-white/10"
          title="中断当前任务"
        >
          <StopIcon className="mr-1 inline h-3 w-3" />中断
        </button>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSubmit}
          className="h-7 shrink-0 rounded bg-status-working/30 px-3 text-[10px] font-medium text-status-working hover:bg-status-working/40 disabled:opacity-40"
        >
          {!busy && <SendIcon className="mr-1 inline h-3 w-3" />}{submitLabel}
        </button>
      </div>
    </div>
  );
}
