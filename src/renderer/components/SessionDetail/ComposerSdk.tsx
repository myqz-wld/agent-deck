import { useState, type JSX } from 'react';
import { useSessionStore } from '@renderer/stores/session-store';

/**
 * SDK 会话的输入区 + 权限模式下拉。
 *
 * 关键护栏（不要破坏）：
 * - SDK streaming mode 不支持 slash 命令，入口拦截给本地提示比让用户撞神秘 SDK 报错友好
 * - bypassPermissions 必须冷切（重启 SDK 子进程），切换前弹 confirm 二次确认；
 *   ipc.ts SetPermissionMode handler 检测到 bypass 时路由到 restartWithPermissionMode
 * - sendError / pmError 失败时把文本回填到输入框（乐观清空），用户能改文字继续发
 * - 通道断连恢复已沉到 sdk-bridge.sendMessage 内部（CHANGELOG_26 / B 方案），
 *   renderer 不再判断「断连 vs 真错」——直接显示 sdk-bridge 抛出的 message
 */
export function ComposerSdk({
  sessionId,
  agentId,
}: {
  sessionId: string;
  agentId: string;
}): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // SDK Query 自身持有运行时 permissionMode 但不暴露 getter，所以从 session 记录的
  // permission_mode 列读「用户上次主动选过的值」。这是持久化的（DB），切别的 detail
  // 再切回来 / 重启 dev / 恢复会话，下拉都能正确还原。CLI 通道这字段是 null → 默认。
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const permissionMode = (session?.permissionMode ?? 'default') as
    | 'default'
    | 'acceptEdits'
    | 'plan'
    | 'bypassPermissions';
  const [pmBusy, setPmBusy] = useState(false);
  const [pmError, setPmError] = useState<string | null>(null);

  // 多 agent 适配：
  // - 标签 / placeholder 文案用对应 agent 名（Claude / Codex / ...）
  // - 权限模式 select 仅 claude-code 显示（codex SDK 没有运行时切权限模式）
  const agentDisplayName = agentId === 'codex-cli' ? 'Codex' : 'Claude';
  const supportsPermissionMode = agentId !== 'codex-cli';

  const send = async (): Promise<void> => {
    const t = text.trim();
    if (!t || busy) return;
    // SDK streaming mode 不支持 slash 命令——CLI 那套 slash command 注册表
    // 在 SDK 模式下不存在，'/clear' / '/compact' / '/cost' 等都会让 SDK 抛
    // "Unknown slash command" 或 "only prompt commands are supported in streaming mode"。
    // 在入口拦截，给本地提示比让用户撞神秘 SDK 报错友好；不清空输入框，
    // 让用户能改成普通文本继续发。
    if (t.startsWith('/')) {
      setSendError(
        '应用内会话不支持斜杠命令（如 /clear /compact /cost）。' +
          '如需使用这些命令，请回终端运行 `claude`。',
      );
      return;
    }
    // 乐观清空：让用户立刻感觉「发出去了」
    setText('');
    setBusy(true);
    setSendError(null);
    try {
      // 通道断连恢复已沉到 sdk-bridge.sendMessage 内部（CHANGELOG_26 / B 方案）：
      // 主进程检测到 !sessions.has(sessionId) 自动单飞 createSession({resume,prompt,cwd,permissionMode})，
      // 走完整 H4/H1 护栏 + emit 占位 message。renderer 在这里**不再判断**「断连 vs 真错」。
      // 唯一例外：sessionRepo 完全没记录 → sdk-bridge 仍抛 'session X not found'，
      // 此时显示原 message 即可（这种情况理论上不会发生，session 一旦创建就在 DB 里）。
      await window.api.sendAdapterMessage(agentId, sessionId, t);
    } catch (err) {
      console.error('sendAdapterMessage failed', err);
      setText(t);
      setSendError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const interrupt = async (): Promise<void> => {
    try {
      await window.api.interruptAdapterSession(agentId, sessionId);
    } catch (err) {
      console.error('interrupt failed', err);
    }
  };

  const changeMode = async (next: typeof permissionMode): Promise<void> => {
    if (next === permissionMode || pmBusy) return;
    // bypassPermissions 必须冷切：SDK 的 allowDangerouslySkipPermissions flag 在 CLI
    // 子进程启动时锁死，运行时调 setPermissionMode('bypassPermissions') 会被 SDK 静默吞。
    // ipc.ts 的 SetPermissionMode handler 检测到 bypass 时会路由到 restartWithPermissionMode：
    // 销毁旧 SDK 子进程 + 用 flag=true 重建（5-10s busy）。失败会回滚到原 mode + emit error msg。
    if (next === 'bypassPermissions' && permissionMode !== 'bypassPermissions') {
      const ok = await window.api.confirmDialog({
        title: '切换到完全免询问模式',
        message: '将重启 SDK 子进程切到 bypassPermissions 模式',
        detail:
          '会销毁当前 SDK 子进程并以「allowDangerouslySkipPermissions=true」flag 重启（约 5-10s busy），\n' +
          '重启后 Claude **全过程不再询问任何工具调用**，按需要小心使用。\n\n' +
          '如果失败将自动回滚到原模式。继续？',
        okLabel: '重启并切到 bypass',
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

  return (
    <div className="shrink-0 border-t border-deck-border px-2.5 py-2">
      {supportsPermissionMode && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-deck-muted">
          <span>权限</span>
          <select
            value={permissionMode}
            onChange={(e) => void changeMode(e.target.value as typeof permissionMode)}
            disabled={pmBusy}
            className="no-drag flex-1 min-w-0 rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
          >
            <option value="default">默认（每次询问）</option>
            <option value="acceptEdits">自动接受编辑</option>
            <option value="plan">Plan 模式（只规划）</option>
            <option value="bypassPermissions">完全免询问 ⚠️</option>
          </select>
        </div>
      )}
      {pmError && (
        <div className="mb-1.5 flex items-start gap-1.5 rounded border border-status-waiting/40 bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
          <span className="flex-1">⚠ 权限模式切换失败：{pmError}</span>
          <button
            type="button"
            onClick={() => setPmError(null)}
            className="text-status-waiting/70 hover:text-status-waiting"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {sendError && (
        <div className="mb-1.5 flex items-start gap-1.5 rounded border border-status-waiting/40 bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
          <span className="flex-1">⚠ {sendError}</span>
          <button
            type="button"
            onClick={() => setSendError(null)}
            className="text-status-waiting/70 hover:text-status-waiting"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
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
              if (text.trim() && !busy) void send();
            }
          }}
          placeholder={`给 ${agentDisplayName} 发消息…  (Enter 发送 / Shift+Enter 换行)`}
          rows={2}
          className="flex-1 resize-none rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
        />
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void send()}
            disabled={!text.trim() || busy}
            className="rounded bg-status-working/30 px-2.5 py-1 text-[10px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
          >
            {busy ? '发送中…' : '发送'}
          </button>
          <button
            type="button"
            onClick={() => void interrupt()}
            className="rounded bg-white/5 px-2.5 py-1 text-[10px] text-deck-muted hover:bg-white/10"
            title="中断当前任务"
          >
            中断
          </button>
        </div>
      </div>
    </div>
  );
}
