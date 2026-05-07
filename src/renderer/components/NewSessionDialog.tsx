import { useEffect, useRef, useState, type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';

interface AdapterInfo {
  id: string;
  displayName: string;
  capabilities: {
    canCreateSession?: boolean;
    canSetPermissionMode?: boolean;
    canJoinTeam?: boolean;
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

const PERMISSION_OPTIONS: { value: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'; label: string }[] = [
  { value: 'default', label: '默认（每次工具调用询问）' },
  { value: 'acceptEdits', label: '自动接受文件编辑' },
  { value: 'plan', label: 'Plan 模式（只规划不动手）' },
  { value: 'bypassPermissions', label: '完全免询问 ⚠️' },
];

// Codex 三档 sandbox 直接映射（CHANGELOG_<X>）。codex SDK 的 ApprovalMode 在我们应用里
// 起不了作用（无 canUseTool 等价回调），sandboxMode 才是真正能起作用的隔离旋钮。
// 「跟随设置」= 不传该字段，sdk-bridge 用 settings.codexSandbox 全局值。
type CodexSandboxChoice = '' | 'workspace-write' | 'read-only' | 'danger-full-access';
const CODEX_SANDBOX_OPTIONS: { value: CodexSandboxChoice; label: string }[] = [
  { value: '', label: '跟随设置（默认）' },
  { value: 'workspace-write', label: 'workspace-write（cwd 可写、网络 deny）' },
  { value: 'read-only', label: 'read-only（全只读）' },
  { value: 'danger-full-access', label: 'danger-full-access（完全免审 ⚠️）' },
];

export function NewSessionDialog({ open, onClose, onCreated }: Props): JSX.Element | null {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [agentId, setAgentId] = useState('claude-code');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [permissionMode, setPermissionMode] =
    useState<'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'>('default');
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxChoice>('');
  /**
   * Agent Teams 实验特性总开关。**仅控制是否注入 env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1**。
   * CHANGELOG_46 起 NewSessionDialog 不再让用户预填 team 名 —— team 名完全由 lead 在会话内
   * 自由决定，应用通过 PreToolUse hook + fs watcher + hook 三层反向同步到 sessions.team_name。
   * null = settings 还没拉到（loading）。
   */
  const [agentTeamsEnabled, setAgentTeamsEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgs = useImageAttachments();

  useEffect(() => {
    if (!open) return;
    setError(null);
    void window.api.listAdapters().then((rows) => {
      const usable = rows.filter((a) => a.capabilities.canCreateSession);
      setAdapters(usable);
      if (usable.length > 0 && !usable.find((a) => a.id === agentId)) {
        setAgentId(usable[0].id);
      }
    });
    void window.api.getSettings().then((s) => {
      const settings = s as Partial<AppSettings> | undefined;
      setAgentTeamsEnabled(settings?.agentTeamsEnabled ?? false);
    });
  }, [open]);

  if (!open) return null;

  // 当前选中 adapter 的 capabilities，用来按需隐藏对该 agent 无意义的字段
  const selectedAdapter = adapters.find((a) => a.id === agentId);
  // permission 模式是 Claude SDK 的 SDK-only feature；codex 没有运行时切权限模式
  const showPermissionMode = selectedAdapter?.capabilities.canSetPermissionMode ?? false;
  // Codex 三档 sandbox：仅在 codex-cli adapter 时显示。两个权限相关字段天然互斥
  // （codex canSetPermissionMode=false → showPermissionMode 为 false，codex 自己用 sandbox）
  const showCodexSandbox = agentId === 'codex-cli';
  // Agent Teams 启用提示（仅展示用，不可编辑 team 名）：双条件满足才显示
  const showTeamHint =
    agentTeamsEnabled === true && (selectedAdapter?.capabilities.canJoinTeam ?? false);

  const browse = async (): Promise<void> => {
    const r = await window.api.chooseDirectory(cwd || undefined);
    if (r) setCwd(r);
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (!prompt.trim()) {
      // SDK streaming 协议：CLI 子进程必须收到 stdin 首条 user message 才会启动，
      // 空 prompt 会卡死直到 30s fallback。所以这里强制必填。
      // 注意：即使带 attachments 也必须有文字，因为 codex SDK / claude SDK 的首条 prompt
      // 都需要文本驱动 turn（图片只是辅助 context）
      setError('请填写首条消息（SDK 必须有首条消息才能启动 CLI 子进程）');
      return;
    }
    setBusy(true);
    let attachmentInputs: ReturnType<typeof imgs.toIpcInputs>;
    try {
      attachmentInputs = imgs.toIpcInputs();
    } catch (err) {
      setBusy(false);
      setError(`附件读取失败：${(err as Error).message}`);
      return;
    }
    try {
      // CHANGELOG_46：不再传 teamName；team 由 lead 在会话内自由建，
      // 应用反向同步（PreToolUse hook + fs watcher + hook 三层）。
      const id = await window.api.createAdapterSession(agentId, {
        cwd: cwd.trim(),
        prompt: prompt.trim() || undefined,
        // 隐藏的字段不传，避免 codex 等无关 agent 收到无意义参数。
        // model 入参已彻底删（CHANGELOG_59）：Claude / Codex CLI 子进程自己读各自配置文件的 model
        permissionMode: showPermissionMode ? permissionMode : undefined,
        codexSandbox: showCodexSandbox && codexSandbox ? codexSandbox : undefined,
        ...(attachmentInputs.length > 0 ? { attachments: attachmentInputs } : {}),
      });
      onCreated(id);
      // 重置部分字段，留下 cwd / 设置便于连开多个会话
      setPrompt('');
      imgs.clear();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      // attachments 失败时不清，让用户能 retry（unlike ComposerSdk，这里失败更可能是
      // 临时网络错而非永久错；用户重点击「创建会话」即可重发同图）
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="no-drag w-[340px] max-h-[85%] overflow-y-auto scrollbar-deck rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">新建会话</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          >
            ✕
          </button>
        </header>

        {adapters.length === 0 ? (
          <div className="text-[11px] text-deck-muted">没有可用的适配器</div>
        ) : (
          <div className="flex flex-col gap-3">
            <Field label="Agent">
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
              >
                {adapters.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="工作目录 cwd">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="留空使用主目录 (~)"
                  className="flex-1 rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
                />
                <button
                  type="button"
                  onClick={() => void browse()}
                  className="shrink-0 rounded bg-white/10 px-2 text-[10px] hover:bg-white/15"
                >
                  选择…
                </button>
              </div>
            </Field>

            <Field label="首条消息 *">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={imgs.onPaste}
                onDrop={imgs.onDrop}
                onDragOver={imgs.onDragOver}
                placeholder="必填 —— SDK 需要首条消息才能启动 CLI 子进程（可粘贴 / 拖放图片）"
                rows={3}
                className="w-full resize-y rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
              />
            </Field>

            {imgs.error && (
              <div className="rounded bg-status-waiting/10 px-2 py-1 text-[11px] text-status-waiting">
                ⚠ {imgs.error}{' '}
                <button
                  type="button"
                  onClick={imgs.dismissError}
                  className="ml-1 underline hover:no-underline"
                >
                  关闭
                </button>
              </div>
            )}

            {/* 缩略图 strip + 上传按钮：单独一行，避免挤压首条消息区 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  void imgs.add(e.target.files);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded border border-dashed border-deck-border px-2 py-1 text-[10px] text-deck-muted hover:bg-white/5"
                title="上传图片（也可粘贴 / 拖放到首条消息）"
              >
                🖼 添加图片
              </button>
              {imgs.attachments.map((a) => (
                <div key={a.id} className="relative">
                  <img
                    src={a.thumbnailDataUrl}
                    alt={a.name ?? 'attachment'}
                    title={`${a.name ?? ''}\n${(a.bytes / 1024).toFixed(1)}KB · ${a.mime}`}
                    className="h-10 w-10 rounded border border-deck-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => imgs.remove(a.id)}
                    className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-deck-bg text-[10px] text-deck-muted shadow hover:text-status-waiting"
                    aria-label="remove attachment"
                    title="移除"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            {showPermissionMode && (
              <Field label="权限模式">
                <select
                  value={permissionMode}
                  onChange={(e) =>
                    setPermissionMode(e.target.value as typeof permissionMode)
                  }
                  className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
                >
                  {PERMISSION_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {showCodexSandbox && (
              <Field label="权限模式 (sandbox)">
                <select
                  value={codexSandbox}
                  onChange={(e) => setCodexSandbox(e.target.value as CodexSandboxChoice)}
                  className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
                >
                  {CODEX_SANDBOX_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {showTeamHint && (
              <div className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1.5 text-[10px] leading-snug text-deck-muted/80">
                <span className="text-deck-text">Agent Teams 实验特性已启用</span>。
                team 名由 lead 在会话内自由决定（在首条消息里告诉 lead「请创建 team
                <code className="mx-1 rounded bg-white/5 px-1">my-team</code>...」），
                应用通过 hook + fs watcher 反向同步到 TeamHub / SessionCard 自动展示。
                <br />
                <span className="text-deck-muted/60">
                  限制：不支持 /resume；需 Claude Code v2.1.32+。
                </span>
              </div>
            )}

            {error && (
              <div className="rounded bg-status-waiting/10 px-2 py-1 text-[11px] text-status-waiting">
                {error}
              </div>
            )}

            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded px-3 py-1 text-[11px] text-deck-muted hover:bg-white/5 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || !prompt.trim()}
                className="rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
              >
                {busy ? '创建中…' : '创建会话'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">{label}</span>
      {children}
    </label>
  );
}
