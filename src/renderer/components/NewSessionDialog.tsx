import { useEffect, useRef, useState, type JSX } from 'react';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import {
  getLastAdapter,
  getLastDefaults,
  setLastAdapter,
  setLastDefaults,
} from '@renderer/hooks/useLastSessionDefaults';
import {
  PERMISSION_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  CLAUDE_SANDBOX_OPTIONS,
  type CodexSandboxChoice,
  type ClaudeSandboxChoice,
  type PermissionModeChoice,
} from '@renderer/lib/sandbox-options';

interface AdapterInfo {
  id: string;
  displayName: string;
  capabilities: {
    canCreateSession?: boolean;
    canSetPermissionMode?: boolean;
    canCollaborate?: boolean;
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

export function NewSessionDialog({ open, onClose, onCreated }: Props): JSX.Element | null {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [agentId, setAgentId] = useState<string>(() => getLastAdapter());
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionModeChoice>('bypassPermissions');
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxChoice>('');
  // CHANGELOG_74：claude-code OS 沙盒 per-session 覆盖（与 codexSandbox 字面镜像）
  const [claudeCodeSandbox, setClaudeCodeSandbox] = useState<ClaudeSandboxChoice>('');
  // R3.E7：删 agentTeamsEnabled / canJoinTeam 路径（老 inbox 协议下线）。
  // 新 universal team backend 不需要在新建会话对话框里预选 team —— 用户在 TeamHub
  // 单独建 team / 加 member。
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
      if (usable.length > 0) {
        setAgentId((current) => {
          const next =
            usable.find((a) => a.id === current)?.id
            ?? usable.find((a) => a.id === getLastAdapter())?.id
            ?? usable[0].id;
          setLastAdapter(next);
          return next;
        });
      }
    });
  }, [open]);

  // plan pending-tab-resume-and-new-session-default-20260602 §D2 BUG 2：两个弹窗共享 last-used。
  // open 变 true 时（dialog 重新打开）从模块顶层 store 读回上次的选项；mount 期不变（避免
  // dialog 关掉再开之间被外部 mutation 误改）。adapter 切换时也重读（跨 adapter 不串味，
  // useLastSessionDefaults.setLastDefaults 内已经按 adapter 维度分桶）。
  useEffect(() => {
    if (!open) return;
    const d = getLastDefaults(agentId);
    if (d.permissionMode !== undefined) setPermissionMode(d.permissionMode);
    if (d.claudeCodeSandbox !== undefined) setClaudeCodeSandbox(d.claudeCodeSandbox);
    if (d.codexSandbox !== undefined) setCodexSandbox(d.codexSandbox);
  }, [open, agentId]);

  if (!open) return null;

  // 当前选中 adapter 的 capabilities，用来按需隐藏对该 agent 无意义的字段
  const selectedAdapter = adapters.find((a) => a.id === agentId);
  // permission 模式是 Claude SDK 的 SDK-only feature；codex 没有运行时切权限模式
  const showPermissionMode = selectedAdapter?.capabilities.canSetPermissionMode ?? false;
  // Codex 三档 sandbox：仅在 codex-cli adapter 时显示
  const showCodexSandbox = agentId === 'codex-cli';
  // CHANGELOG_74：Claude OS 沙盒：Claude Code 及 Deepseek(Claude Code) 都走同一 SDK 桥接层
  const showClaudeCodeSandbox = agentId === 'claude-code' || agentId === 'deepseek-claude-code';

  const browse = async (): Promise<void> => {
    const r = await window.api.chooseDirectory(cwd || undefined);
    if (r) setCwd(r);
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (!prompt.trim()) {
      setError('请输入第一条消息（留空无法启动会话）');
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
      const id = await window.api.createAdapterSession(agentId, {
        cwd: cwd.trim(),
        prompt: prompt.trim() || undefined,
        permissionMode: showPermissionMode ? permissionMode : undefined,
        codexSandbox: showCodexSandbox && codexSandbox ? codexSandbox : undefined,
        claudeCodeSandbox:
          showClaudeCodeSandbox && claudeCodeSandbox ? claudeCodeSandbox : undefined,
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
            <Field label="执行器">
              <DeckSelect
                value={agentId}
                onChange={(next) => {
                  setAgentId(next);
                  setLastAdapter(next);
                }}
                options={adapters.map((a) => ({ value: a.id, label: a.displayName }))}
                buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20"
              />
            </Field>

            <Field label="工作目录">
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

            <Field label="第一条消息 *">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={imgs.onPaste}
                onDrop={imgs.onDrop}
                onDragOver={imgs.onDragOver}
                placeholder="必填，启动会话需要第一条消息（可粘贴或拖放图片）"
                rows={3}
                className="w-full resize-y rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
              />
            </Field>

            {imgs.error && (
              <div className="rounded bg-status-waiting/10 px-2 py-1 text-[11px] text-status-waiting">
                ⚠️ {imgs.error}{' '}
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
                    alt={a.name ?? '附件图片'}
                    title={`${a.name ?? ''}\n${(a.bytes / 1024).toFixed(1)}KB · ${a.mime}`}
                    className="h-10 w-10 rounded border border-deck-border object-cover"
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

            {showPermissionMode && (
              <Field label="权限模式">
                <DeckSelect
                  value={permissionMode}
                  onChange={(v) => {
                    setPermissionMode(v);
                    setLastDefaults(agentId, { permissionMode: v });
                  }}
                  options={PERMISSION_OPTIONS}
                  buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20"
                />
              </Field>
            )}

            {showCodexSandbox && (
              <Field label="沙盒">
                <DeckSelect
                  value={codexSandbox}
                  onChange={(v) => {
                    setCodexSandbox(v);
                    setLastDefaults(agentId, { codexSandbox: v });
                  }}
                  options={CODEX_SANDBOX_OPTIONS}
                  buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20"
                />
              </Field>
            )}

            {showClaudeCodeSandbox && (
              <Field label="系统沙盒">
                <DeckSelect
                  value={claudeCodeSandbox}
                  onChange={(v) => {
                    setClaudeCodeSandbox(v);
                    setLastDefaults(agentId, { claudeCodeSandbox: v });
                  }}
                  options={CLAUDE_SANDBOX_OPTIONS}
                  buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20"
                />
              </Field>
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
