import { useRef, useState, type JSX } from 'react';
import { useSessionStore } from '@renderer/stores/session-store';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import log from '@renderer/utils/logger';
import { ImageIcon } from './composer-sdk/ImageIcon';
import { ErrorBanner } from './composer-sdk/ErrorBanner';
import {
  SelectRow,
  PERMISSION_MODE_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  CLAUDE_CODE_SANDBOX_OPTIONS,
  type PermissionMode,
  type CodexSandbox,
  type ClaudeCodeSandbox,
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
 * - `composer-sdk/ImageIcon.tsx`        inline SVG icon
 * - `composer-sdk/ErrorBanner.tsx`      通用错误条（5 处复用）
 * - `composer-sdk/SandboxSelects.tsx`   通用 SelectRow + permission/codex/claude 三组 options
 */
export function ComposerSdk({
  sessionId,
  agentId,
  onHandOff,
}: {
  sessionId: string;
  agentId: string;
  /** CHANGELOG_94: 「📤 接力到新会话」按钮触发 callback，由 SessionDetail 渲染
   *  HandOffPreviewDialog。仅当 prop 传入时显示按钮（CLI 会话不传，逻辑由
   *  SessionDetail 决定）。 */
  onHandOff?: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // REVIEW_35 MED-D-claude-4：busyRef 同步锁，防超快连点（< 16ms）双 send race
  const busyRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgs = useImageAttachments();
  // SDK Query 自身持有运行时 permissionMode 但不暴露 getter，所以从 session 记录的
  // permission_mode 列读「用户上次主动选过的值」。这是持久化的（DB），切别的 detail
  // 再切回来 / 重启 dev / 恢复会话，下拉都能正确还原。CLI 通道这字段是 null → 默认。
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const permissionMode = (session?.permissionMode ?? 'default') as PermissionMode;
  const [pmBusy, setPmBusy] = useState(false);
  const [pmError, setPmError] = useState<string | null>(null);

  // CHANGELOG_<X> A2c：codex 会话独立的 sandbox 切档（与 permissionMode 正交）。
  // codex SDK 的 sandboxMode 是 startThread/resumeThread spawn-time 锁定，
  // 切档必须冷切（销毁旧 thread + 用新 sandbox resume 重建），与 claude
  // bypassPermissions 路径同模式。
  const codexSandbox = (session?.codexSandbox ?? 'workspace-write') as CodexSandbox;
  const [csBusy, setCsBusy] = useState(false);
  const [csError, setCsError] = useState<string | null>(null);

  // CHANGELOG_74：claude OS 沙盒切档（与 codex 字面镜像）。SDK 的 sandbox options 是
  // query() spawn-time 锁定，切档必须冷切重启 SDK 子进程。session.claudeCodeSandbox
  // null/undefined → 'off' 兜底（与全局默认对齐）。
  const claudeCodeSandbox = (session?.claudeCodeSandbox ?? 'off') as ClaudeCodeSandbox;
  const [csClaudeBusy, setCsClaudeBusy] = useState(false);
  const [csClaudeError, setCsClaudeError] = useState<string | null>(null);

  // 多 agent 适配：
  // - 标签 / placeholder 文案用对应 agent 名（Claude / Codex / ...）
  // - 权限模式 select 仅 claude-code 显示（codex SDK 没有运行时切权限模式；REVIEW_35 MED-D-codex-3
  //   修法：用 capabilities.canSetPermissionMode 而非 `agentId !== 'codex-cli'` —— 后者把
  //   不支持 setPermissionMode 的 adapter 错归入支持类，切换抛 IPC 错）
  // - codex sandbox select 仅 codex-cli 显示（claude 没有 codex 那套档位）
  // - claude OS sandbox select 仅 claude-code 显示（CHANGELOG_74，与 codex 字面镜像）
  // - 图片附件入口（粘贴 / 拖放 / 上传）按 capabilities.canAcceptAttachments gate
  //   （REVIEW_35 HIGH-D2：当前 claude-code 与 codex-cli 都 true；白名单 gate 防止未来新
  //   adapter 默认就拿到 attachments 路径，必须显式 opt-in）
  const agentDisplayName = agentId === 'codex-cli' ? 'Codex' : 'Claude';
  const supportsPermissionMode = agentId === 'claude-code';
  const supportsCodexSandbox = agentId === 'codex-cli';
  const supportsClaudeCodeSandbox = agentId === 'claude-code';
  const canAcceptAttachments = agentId === 'claude-code' || agentId === 'codex-cli';

  const send = async (): Promise<void> => {
    const t = text.trim();
    const hasAttachments = imgs.attachments.length > 0;
    // 允许「只发图不带文字」：text 空 + 至少一张图 → 走发送
    if (!t && !hasAttachments) return;
    // REVIEW_35 MED-D-claude-4：busyRef 同步锁，busy state async 不立即生效，超快连点（< 16ms）
    // 第 2 次闭包仍看 busy=false 重复发同款消息（attachments 已 clear，发空附件 / 空文本）
    if (busyRef.current) return;
    if (busy) return;
    // REVIEW_35 HIGH-D2：不在白名单的 adapter（当前白名单仅 claude-code / codex-cli）
    // gate 拒发并保留 attachments（不调 imgs.clear()）让用户能切 adapter 或删图后重发；
    // 静默丢图 + 失去 retry 能力的旧版本回归不可接受
    if (!canAcceptAttachments && hasAttachments) {
      setSendError(
        '当前会话类型不支持图片附件，请移除图片后再发送，或切换到支持图片的 Claude / Codex 会话',
      );
      return;
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
      return;
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
    } catch (err) {
      logger.error('sendAdapterMessage failed', err);
      setText(t);
      setSendError((err as Error).message);
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

  const changeMode = async (next: PermissionMode): Promise<void> => {
    if (next === permissionMode || pmBusy) return;
    // bypassPermissions 必须冷切：SDK 的 allowDangerouslySkipPermissions flag 在 CLI
    // 子进程启动时锁死，运行时调 setPermissionMode('bypassPermissions') 会被 SDK 静默吞。
    // ipc.ts 的 SetPermissionMode handler 检测到 bypass 时会路由到 restartWithPermissionMode：
    // 销毁旧 SDK 子进程 + 用 flag=true 重建（5-10s busy）。失败会回滚到原 mode + emit error msg。
    if (next === 'bypassPermissions' && permissionMode !== 'bypassPermissions') {
      const ok = await window.api.confirmDialog({
        title: '切换到完全免询问',
        message: '需要重启当前会话',
        detail:
          '重启后,Claude 执行工具时不再向你确认 —— 包括文件修改、Bash 命令等所有操作。重启约需 5-10 秒。\n\n' +
          '失败时会自动回到当前模式。继续?',
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
      await window.api.setAdapterPermissionMode(agentId, sessionId, next);
    } catch (err) {
      setPmError((err as Error).message);
    } finally {
      setPmBusy(false);
    }
  };

  /**
   * CHANGELOG_<X> A2c：codex sandbox 冷切。与 claude bypassPermissions 路径同模式
   * （销毁旧 thread → resume + 新 sandbox + handoffPrompt）。
   *
   * 切到 'danger-full-access' 必须 confirm（让 codex 完全免审批触达系统资源）；
   * 'read-only' 是降级到只读，无破坏性，免 confirm。
   */
  const changeSandbox = async (next: CodexSandbox): Promise<void> => {
    if (next === codexSandbox || csBusy) return;
    if (next === 'danger-full-access' && codexSandbox !== 'danger-full-access') {
      const ok = await window.api.confirmDialog({
        title: '关闭沙盒(完全开放)',
        message: '需要重启当前会话',
        detail:
          '重启后,Codex 可以读写任意文件、执行任意命令。重启约需 5-10 秒。\n\n' +
          '失败时会自动回到当前沙盒设置。继续?',
        okLabel: '重启并关闭沙盒',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
    }
    setCsBusy(true);
    setCsError(null);
    try {
      // IPC 主进程 restartWithCodexSandbox：closeSession → setCodexSandbox →
      // createSession({resume, codexSandbox, prompt}) → 失败回滚 DB + emit error。
      // session-upserted event 推回 renderer store 让下拉值跟着 sessions Map 变。
      // handoffPrompt 不能空，给一段无伤大雅的占位。
      await window.api.restartWithCodexSandbox(agentId, sessionId, next, '继续之前的会话');
    } catch (err) {
      setCsError((err as Error).message);
    } finally {
      setCsBusy(false);
    }
  };

  /**
   * CHANGELOG_74：Claude OS 沙盒冷切（与 changeSandbox 字面镜像）。
   * SDK 的 sandbox options 是 query() spawn-time 锁定，必须冷切重启 SDK 子进程。
   *
   * confirm 策略反向：切到 `'off'` 才弹 confirm（关闭 OS 沙盒 = 放宽 = 让 SDK 完全
   * 不受 OS 隔离约束，与 codex `danger-full-access` 同性质）；切到 `'workspace-write'` /
   * `'strict'` 是同档/更严格，无破坏性，免 confirm。
   */
  const changeClaudeCodeSandbox = async (next: ClaudeCodeSandbox): Promise<void> => {
    if (next === claudeCodeSandbox || csClaudeBusy) return;
    if (next === 'off' && claudeCodeSandbox !== 'off') {
      const ok = await window.api.confirmDialog({
        title: '关闭系统沙盒',
        message: '需要重启当前会话',
        detail:
          '重启后,Claude 不再受系统沙盒约束(仅靠应用内授权弹窗管控)。重启约需 5-10 秒。\n\n' +
          '失败时会自动回到当前沙盒设置。继续?',
        okLabel: '重启并关闭沙盒',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
    }
    setCsClaudeBusy(true);
    setCsClaudeError(null);
    try {
      // IPC 主进程 restartWithClaudeCodeSandbox：closeSession → setClaudeCodeSandbox →
      // createSession({resume, claudeCodeSandbox, prompt}) → 失败回滚 DB + emit error。
      await window.api.restartWithClaudeCodeSandbox(agentId, sessionId, next, '继续之前的会话');
    } catch (err) {
      setCsClaudeError((err as Error).message);
    } finally {
      setCsClaudeBusy(false);
    }
  };

  const canSend = (text.trim().length > 0 || imgs.attachments.length > 0) && !busy;

  return (
    <div className="shrink-0 border-t border-deck-border px-2.5 py-2">
      {supportsPermissionMode && (
        <SelectRow
          label="权限"
          value={permissionMode}
          options={PERMISSION_MODE_OPTIONS}
          disabled={pmBusy}
          onChange={(next) => void changeMode(next)}
        />
      )}
      {supportsCodexSandbox && (
        <SelectRow
          label="沙盒"
          value={codexSandbox}
          options={CODEX_SANDBOX_OPTIONS}
          disabled={csBusy}
          onChange={(next) => void changeSandbox(next)}
        />
      )}
      {supportsClaudeCodeSandbox && (
        <SelectRow
          label="沙盒"
          value={claudeCodeSandbox}
          options={CLAUDE_CODE_SANDBOX_OPTIONS}
          disabled={csClaudeBusy}
          onChange={(next) => void changeClaudeCodeSandbox(next)}
        />
      )}
      <ErrorBanner message={pmError} prefix="权限模式切换失败" onDismiss={() => setPmError(null)} />
      <ErrorBanner message={csError} prefix="Codex 沙盒切换失败" onDismiss={() => setCsError(null)} />
      <ErrorBanner
        message={csClaudeError}
        prefix="Claude 沙盒切换失败"
        onDismiss={() => setCsClaudeError(null)}
      />
      <ErrorBanner message={sendError} onDismiss={() => setSendError(null)} />
      <ErrorBanner message={imgs.error} onDismiss={imgs.dismissError} />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        // REVIEW_35 HIGH-D2：仅 canAcceptAttachments adapter 才绑 paste/drop/dragover；
        // 不在白名单的 adapter 不绑，防止用户拖入触发空发送 + 静默丢图。
        onPaste={canAcceptAttachments ? imgs.onPaste : undefined}
        onDrop={canAcceptAttachments ? imgs.onDrop : undefined}
        onDragOver={canAcceptAttachments ? imgs.onDragOver : undefined}
        onKeyDown={(e) => {
          // Enter 发送；Shift+Enter 换行（IME 拼写期间不拦，避免吞掉中文上屏的 Enter）
          if (
            e.key === 'Enter' &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            // 兼容旧浏览器：keyCode === 229 表示 IME 仍在拼写
            e.nativeEvent.keyCode !== 229
          ) {
            e.preventDefault();
            if (canSend) void send();
          }
        }}
        placeholder={`给 ${agentDisplayName} 发消息…  (Enter 发送 / Shift+Enter 换行 / 可粘贴或拖放图片)`}
        rows={2}
        className="block w-full resize-none rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
      />
      {/* 下方工具栏：左 = 上传图片 + 缩略图，右 = 中断 / 发送。
          替代了原「右侧三按钮纵向堆叠」+「单独 attachments strip」，让附件操作分组、
          发送/中断作为主操作右对齐。emoji 图标换成 inline SVG 避免基线对不齐。 */}
      <div className="mt-1.5 flex items-center gap-1.5">
        {/* REVIEW_35 HIGH-D2：仅 canAcceptAttachments adapter 才显示图片入口 */}
        {canAcceptAttachments && (
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
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {imgs.attachments.map((a) => (
              <div key={a.id} className="relative shrink-0">
                <img
                  src={a.thumbnailDataUrl}
                  alt={a.name ?? '附件图片'}
                  title={`${a.name ?? ''}\n${(a.bytes / 1024).toFixed(1)}KB · ${a.mime}`}
                  className="h-9 w-9 rounded border border-deck-border object-cover"
                />
                <button
                  type="button"
                  onClick={() => imgs.remove(a.id)}
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-deck-bg text-[10px] text-deck-muted shadow hover:text-status-waiting"
                  aria-label="移除附件"
                  title="移除"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex-1" />
        {onHandOff && (
          <button
            type="button"
            onClick={onHandOff}
            className="h-7 shrink-0 rounded px-2.5 text-[10px] text-deck-muted hover:bg-white/10"
            title="接力到新会话:让 AI 总结当前会话历史,然后打开新会话继续(沿用工作目录和权限设置,自动归档当前会话)"
          >
            📤 接力
          </button>
        )}
        <button
          type="button"
          onClick={() => void interrupt()}
          className="h-7 shrink-0 rounded px-2.5 text-[10px] text-deck-muted hover:bg-white/10"
          title="中断当前任务"
        >
          中断
        </button>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          className="h-7 shrink-0 rounded bg-status-working/30 px-3 text-[10px] font-medium text-status-working hover:bg-status-working/40 disabled:opacity-40"
        >
          {busy ? '发送中…' : '发送'}
        </button>
      </div>
    </div>
  );
}
