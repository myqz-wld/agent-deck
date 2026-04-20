import { useEffect, useState, type JSX } from 'react';

interface AdapterInfo {
  id: string;
  displayName: string;
  capabilities: { canCreateSession?: boolean };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

const MODEL_OPTIONS = [
  { value: '', label: '按本地 settings.json' },
  { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

const PERMISSION_OPTIONS: { value: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'; label: string }[] = [
  { value: 'default', label: '默认（每次工具调用询问）' },
  { value: 'acceptEdits', label: '自动接受文件编辑' },
  { value: 'plan', label: 'Plan 模式（只规划不动手）' },
  { value: 'bypassPermissions', label: '完全免询问 ⚠️' },
];

export function NewSessionDialog({ open, onClose, onCreated }: Props): JSX.Element | null {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [agentId, setAgentId] = useState('claude-code');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] =
    useState<'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'>('default');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [open]);

  if (!open) return null;

  const browse = async (): Promise<void> => {
    const r = await window.api.chooseDirectory(cwd || undefined);
    if (r) setCwd(r);
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (!cwd.trim()) {
      setError('请填写工作目录 cwd');
      return;
    }
    if (!prompt.trim()) {
      // SDK streaming 协议：CLI 子进程必须收到 stdin 首条 user message 才会启动，
      // 空 prompt 会卡死直到 30s fallback。所以这里强制必填。
      setError('请填写首条消息（SDK 必须有首条消息才能启动 CLI 子进程）');
      return;
    }
    setBusy(true);
    try {
      const id = await window.api.createAdapterSession(agentId, {
        cwd: cwd.trim(),
        prompt: prompt.trim() || undefined,
        model: model || undefined,
        permissionMode,
        systemPrompt: systemPrompt.trim() || undefined,
      });
      onCreated(id);
      // 重置部分字段，留下 cwd / 设置便于连开多个会话
      setPrompt('');
      onClose();
    } catch (e) {
      setError((e as Error).message);
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

            <Field label="工作目录 cwd *">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="/Users/you/projects/xxx"
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
                placeholder="必填 —— SDK 需要首条消息才能启动 CLI 子进程"
                rows={3}
                className="w-full resize-y rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
              />
            </Field>

            <Field label="模型">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>

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

            <Field label="System Prompt（可选）">
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="覆盖默认 system prompt"
                rows={2}
                className="w-full resize-y rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
              />
            </Field>

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
                disabled={busy || !cwd.trim() || !prompt.trim()}
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
