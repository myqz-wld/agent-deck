import { useEffect, useRef, useState, type JSX } from 'react';
import type { AppSettings } from '@shared/types';

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

/** team 名称同 main 端 parseTeamName 校验：字母数字 . _ - / 长度 ≤ 64。 */
const TEAM_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 给定 trim 后的 team 名，生成首条 prompt 的引导模板。
 * Claude Code agent teams 是用自然语言驱动建队（SDK 没有 teamName options 字段），
 * 用户必须在首条消息里明确告诉 Claude 用这个名字。模板里含占位符 `<role A>` 等，
 * 用户在 textarea 里直接改即可——不替用户做太多假设（团队规模、分工都让用户自己写）。
 */
function makeTeamPromptTemplate(teamName: string): string {
  return (
    `Create an agent team named "${teamName}" with 3 teammates exploring different angles:\n` +
    `- <teammate-1>: <role / focus 1>\n` +
    `- <teammate-2>: <role / focus 2>\n` +
    `- <teammate-3>: <role / focus 3>\n` +
    `\n` +
    `Have them coordinate through the shared task list, then synthesize findings back to me.`
  );
}

export function NewSessionDialog({ open, onClose, onCreated }: Props): JSX.Element | null {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [agentId, setAgentId] = useState('claude-code');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] =
    useState<'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'>('default');
  const [teamName, setTeamName] = useState('');
  /** 实验特性总开关。null = settings 还没拉到（loading），双条件判定按 false 处理。 */
  const [agentTeamsEnabled, setAgentTeamsEnabled] = useState<boolean | null>(null);
  /**
   * 上次由「team 名变化」自动回填到 prompt 输入框的模板字符串。
   * 用 ref 而不是 state：仅用于「下次回填前判断 prompt 是不是仍是上次模板」，不参与渲染。
   * 设计：仅当 prompt 当前为空 OR 等于上次模板时才回填——用户一旦自己改过 prompt 就尊重，
   * 之后改 team 名也不再覆盖；team 名清空 / 切到不支持的 adapter 也不回退（用户可能已基于
   * 模板写了一半内容）。
   */
  const lastInjectedTemplateRef = useRef<string>('');
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
    void window.api.getSettings().then((s) => {
      const settings = s as Partial<AppSettings> | undefined;
      setAgentTeamsEnabled(settings?.agentTeamsEnabled ?? false);
    });
  }, [open]);

  // M1+ C 方案：team 名变化 → 自动回填首条 prompt 输入框成可编辑模板。
  // Claude Code agent teams 必须用户在首条消息里告诉 Claude 用什么名字 + 角色分工
  // （SDK 没有 teamName options 字段），UI 只填 team 名启动会话不够 —— 必须给用户
  // 一个现成模板让他改。设计：仅当 prompt 为空 OR 等于上次自动回填的模板时才覆盖
  // （用户改过就尊重不再覆盖；team 名清空 / 切到不支持 adapter 不回退原 prompt，
  // 因为用户可能已基于模板编辑了内容）。
  useEffect(() => {
    if (!open) return;
    const adapter = adapters.find((a) => a.id === agentId);
    const showsTeam =
      agentTeamsEnabled === true && (adapter?.capabilities.canJoinTeam ?? false);
    const trimmedTeam = teamName.trim();
    if (!showsTeam || trimmedTeam.length === 0) return;
    // 当前 prompt 必须是「空」或「上次自动回填的内容」才回填；用户改过就不动
    const lastTemplate = lastInjectedTemplateRef.current;
    if (prompt !== '' && prompt !== lastTemplate) return;
    const newTemplate = makeTeamPromptTemplate(trimmedTeam);
    if (newTemplate === prompt) return; // 没变化（typing 时只是 trim 出同名，避免无意义 setState）
    setPrompt(newTemplate);
    lastInjectedTemplateRef.current = newTemplate;
  }, [open, agentTeamsEnabled, agentId, adapters, teamName, prompt]);

  if (!open) return null;

  // 当前选中 adapter 的 capabilities，用来按需隐藏对该 agent 无意义的字段
  const selectedAdapter = adapters.find((a) => a.id === agentId);
  // 模型选项写的是 claude 模型名，对 codex 等其它 agent 不适用 → 仅对 claude-code 显示
  const showModel = agentId === 'claude-code';
  // permission 模式是 Claude SDK 的 SDK-only feature；codex 没有运行时切权限模式
  const showPermissionMode = selectedAdapter?.capabilities.canSetPermissionMode ?? false;
  // Agent Teams 双条件：实验特性总开关打开 + adapter 自身支持（canJoinTeam）。
  // codex/aider/generic-pty 都是 false → UI 隐藏。toggle 关 → UI 隐藏（即便 adapter 支持）。
  const showTeamName =
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
      setError('请填写首条消息（SDK 必须有首条消息才能启动 CLI 子进程）');
      return;
    }
    // team 名前端预校验：错的话主进程也会 throw IpcInputError，但提前给反馈更友好
    const trimmedTeam = teamName.trim();
    if (showTeamName && trimmedTeam.length > 0) {
      if (trimmedTeam.length > 64 || !TEAM_NAME_PATTERN.test(trimmedTeam)) {
        setError('Team 名只允许字母数字 . _ -，长度 ≤ 64');
        return;
      }
    }
    setBusy(true);
    try {
      // cwd 留空 → 主进程兜底为用户主目录（os.homedir()）
      const id = await window.api.createAdapterSession(agentId, {
        cwd: cwd.trim(),
        prompt: prompt.trim() || undefined,
        // 隐藏的字段不传，避免 codex 等无关 agent 收到无意义参数
        model: showModel && model ? model : undefined,
        permissionMode: showPermissionMode ? permissionMode : undefined,
        // teamName 仅在双条件满足且非空时透传；undefined 让 main 走默认 NULL 路径
        teamName: showTeamName && trimmedTeam ? trimmedTeam : undefined,
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
                placeholder="必填 —— SDK 需要首条消息才能启动 CLI 子进程"
                rows={3}
                className="w-full resize-y rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
              />
            </Field>

            {showModel && (
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
            )}

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

            {showTeamName && (
              <Field label="Team 名（实验：Agent Teams）">
                <input
                  type="text"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="留空 = 不加入 team；填了会注入 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
                  className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
                />
                <span className="mt-1 block text-[10px] leading-snug text-deck-muted/70">
                  填了 team 名后，「首条消息」输入框会自动回填可编辑模板（含 3 个 teammate 占位符）。
                  按需改 roles / focus / 团队规模后提交即可。如果你已经手动改过 prompt，
                  改 team 名不会覆盖你的内容。
                  <br />
                  限制：不支持 /resume；需 Claude Code v2.1.32+。
                </span>
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
