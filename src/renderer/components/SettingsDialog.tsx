import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { DEFAULT_SETTINGS, type AppSettings, type HookInstallStatus } from '@shared/types';
import {
  Section,
  Toggle,
  NumberInput,
  SoundPicker,
  ExecutablePicker,
  NotificationTestRow,
} from './settings/controls';
import { ClaudeMdEditor } from './settings/ClaudeMdEditor';
import { SummarizerErrorsDiagnostic } from './settings/SummarizerErrorsDiagnostic';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: Props): JSX.Element | null {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [hookStatus, setHookStatus] = useState<HookInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 写设置 / 安装 hook 的异步错误（CHANGELOG_20 / N7：原本 try/finally 无 catch，IPC 失败用户看不到原因）。
   *  与 loadError 分两个 slot 避免互相覆盖；写错误一段时间后会被下一次成功操作清掉。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** ClaudeMdEditor 是否有未保存草稿（由子组件回报）。
   * 用 ref 持有避免 SettingsDialog 跟着重渲染；guardedClose 同步读最新值即可。 */
  const claudeMdDirtyRef = useRef(false);
  /** REVIEW_4 M9：每次重新打开都递增，旧 effect 的 then 回调用这个比对 abort，
   *  避免快速切换 open 时旧响应回写新打开的 state。 */
  const openSeqRef = useRef(0);
  /** REVIEW_4 M9：update 请求序号；连点多个 toggle 时慢响应回写旧值会被丢弃。 */
  const updateSeqRef = useRef(0);
  /** REVIEW_4 LOW：guardedClose 多次点 ✕ 并行 → 用 inFlight 标记吞掉重复点击。 */
  const closeInFlightRef = useRef(false);

  /** REVIEW_4 M11：parent 用 useCallback 稳定 identity，防 child useEffect cleanup→run
   *  在 parent rerender 时误触发伪 false，让 dirty 标记在 commit 内瞬间为 false。 */
  const onClaudeMdDirtyChange = useCallback((d: boolean) => {
    claudeMdDirtyRef.current = d;
  }, []);

  useEffect(() => {
    if (!open) return;
    const seq = ++openSeqRef.current;
    setLoadError(null);
    setActionError(null);
    void window.api
      .getSettings()
      .then((s) => {
        if (seq !== openSeqRef.current) return; // 老 open 的迟到响应：丢
        // 用 DEFAULT_SETTINGS 兜底：main 端老 schema 缺字段时（HMR 不能 reload main，
        // 改了 AppSettings 后没重启 dev 就会缺新加的字段），前端表单仍能显示默认值。
        setSettings({ ...DEFAULT_SETTINGS, ...((s as Partial<AppSettings>) ?? {}) });
      })
      .catch((err: unknown) => {
        if (seq !== openSeqRef.current) return;
        setLoadError(`getSettings 失败：${(err as Error).message ?? String(err)}`);
        // REVIEW_4 M8：getSettings 失败时降级用 DEFAULT_SETTINGS 兜底渲染表单，
        // 让用户至少能看到完整设置面板而非死锁在「读取设置中…」。
        // 写设置仍可用（main 持久化独立），只是初始值是 default。
        setSettings((prev) => prev ?? { ...DEFAULT_SETTINGS });
      });
    void window.api
      .hookStatus('user')
      .then((s) => {
        if (seq !== openSeqRef.current) return;
        setHookStatus(s as HookInstallStatus);
      })
      .catch((err: unknown) => {
        if (seq !== openSeqRef.current) return;
        setLoadError(
          (prev) =>
            (prev ? prev + '\n' : '') +
            `hookStatus 失败：${(err as Error).message ?? String(err)}`,
        );
      });
  }, [open]);

  if (!open) return null;

  /** 关闭弹窗时拦截 ClaudeMdEditor 未保存草稿，让用户二次确认。
   * 误关一次原本会丢整段 CLAUDE.md 编辑（dirty state 在子组件里，父级看不到）。 */
  const guardedClose = async (): Promise<void> => {
    if (closeInFlightRef.current) return; // 防多次点 ✕ 并行弹多个 confirm
    if (!claudeMdDirtyRef.current) {
      onClose();
      return;
    }
    closeInFlightRef.current = true;
    try {
      const ok = await window.api.confirmDialog({
        title: '关闭设置',
        message: 'CLAUDE.md 有未保存的草稿，确定要丢弃吗？',
        detail: '关闭后改动将丢失，无法恢复。',
        okLabel: '丢弃并关闭',
        cancelLabel: '继续编辑',
        destructive: true,
      });
      if (ok) onClose();
    } finally {
      closeInFlightRef.current = false;
    }
  };

  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    // REVIEW_4 M9：递增请求序号，慢响应被新 update 抢答时丢弃，避免回写旧值 toggle 闪回
    const seq = ++updateSeqRef.current;
    setBusy(true);
    setActionError(null);
    try {
      const next = (await window.api.setSettings(patch)) as Partial<AppSettings> | undefined;
      if (seq !== updateSeqRef.current) return; // 老请求迟到，丢
      // 同样用 DEFAULT_SETTINGS 兜底（防 main 返回 partial）
      setSettings({ ...DEFAULT_SETTINGS, ...((next ?? {}) as Partial<AppSettings>) });
    } catch (err) {
      if (seq !== updateSeqRef.current) return;
      setActionError(`保存设置失败：${(err as Error).message ?? String(err)}`);
    } finally {
      if (seq === updateSeqRef.current) setBusy(false);
    }
  };

  const installHook = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const r = (await window.api.installHook('user')) as HookInstallStatus;
      setHookStatus(r);
    } catch (err) {
      setActionError(`安装 hook 失败：${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const uninstallHook = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const r = (await window.api.uninstallHook('user')) as HookInstallStatus;
      setHookStatus(r);
    } catch (err) {
      setActionError(`卸载 hook 失败：${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="no-drag w-[340px] max-h-[85%] overflow-y-auto scrollbar-deck rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">设置</h2>
          <button
            type="button"
            onClick={() => void guardedClose()}
            aria-label="关闭设置"
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          >
            ✕
          </button>
        </header>

        {loadError && (
          <div className="mb-3 rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting whitespace-pre-wrap">
            {loadError}
          </div>
        )}

        {actionError && (
          <div className="mb-3 rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting whitespace-pre-wrap">
            {actionError}
          </div>
        )}

        {!settings ? (
          <div className="py-6 text-center text-[11px] text-deck-muted">读取设置中…</div>
        ) : (
          <SettingsBody
            settings={settings}
            hookStatus={hookStatus}
            busy={busy}
            update={update}
            installHook={installHook}
            uninstallHook={uninstallHook}
            onClaudeMdDirtyChange={onClaudeMdDirtyChange}
          />
        )}
      </div>
    </div>
  );
}

interface BodyProps {
  settings: AppSettings;
  hookStatus: HookInstallStatus | null;
  busy: boolean;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  installHook: () => Promise<void>;
  uninstallHook: () => Promise<void>;
  onClaudeMdDirtyChange: (dirty: boolean) => void;
}

function SettingsBody({
  settings,
  hookStatus,
  busy,
  update,
  installHook,
  uninstallHook,
  onClaudeMdDirtyChange,
}: BodyProps): JSX.Element {
  return (
    <>
      <Section title="Claude Code Hook" storageKey="hook" defaultOpen={true}>
        {hookStatus ? (
          <div className="text-[11px] leading-relaxed">
            <div className="text-deck-muted">
              状态：{hookStatus.installed ? '已安装' : '未安装'}
            </div>
            <div className="break-all text-[10px] text-deck-muted/70">
              位置：{hookStatus.settingsPath}
            </div>
            <div className="mt-2 flex gap-2">
              {hookStatus.installed ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void uninstallHook()}
                  className="rounded bg-status-waiting/20 px-2 py-1 text-[11px] text-status-waiting hover:bg-status-waiting/30 disabled:opacity-50"
                >
                  卸载
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void installHook()}
                  className="rounded bg-status-working/20 px-2 py-1 text-[11px] text-status-working hover:bg-status-working/30 disabled:opacity-50"
                >
                  安装到 ~/.claude/settings.json
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-deck-muted">读取中…</div>
        )}
      </Section>

      <Section title="提醒" storageKey="notify" defaultOpen={false}>
        <Toggle
          label="启用声音"
          value={settings.enableSound}
          onChange={(v) => void update({ enableSound: v })}
        />
        <Toggle
          label="窗口聚焦时静音"
          value={settings.silentWhenFocused}
          onChange={(v) => void update({ silentWhenFocused: v })}
        />
        <Toggle
          label="启用系统通知"
          value={settings.enableSystemNotification}
          onChange={(v) => void update({ enableSystemNotification: v })}
        />
        <NotificationTestRow />
        <SoundPicker
          label="等待用户提示音"
          kind="waiting"
          path={settings.waitingSoundPath}
          onChange={(p) => void update({ waitingSoundPath: p })}
        />
        <SoundPicker
          label="完成提示音"
          kind="done"
          path={settings.finishedSoundPath}
          onChange={(p) => void update({ finishedSoundPath: p })}
        />
      </Section>

      <Section title="生命周期" storageKey="lifecycle" defaultOpen={false}>
        <NumberInput
          label="active → dormant 阈值（分钟）"
          value={Math.round(settings.activeWindowMs / 60000)}
          min={1}
          onChange={(v) => void update({ activeWindowMs: v * 60_000 })}
        />
        <NumberInput
          label="dormant → closed 阈值（小时）"
          value={Math.round(settings.closeAfterMs / 3600000)}
          min={1}
          onChange={(v) => void update({ closeAfterMs: v * 3_600_000 })}
        />
        <NumberInput
          label="权限请求超时（秒，0 = 不超时）"
          value={Math.round(settings.permissionTimeoutMs / 1000)}
          min={0}
          onChange={(v) => void update({ permissionTimeoutMs: v * 1000 })}
        />
        <NumberInput
          label="历史会话保留（天，0 = 永久保留）"
          value={settings.historyRetentionDays}
          min={0}
          onChange={(v) => void update({ historyRetentionDays: v })}
        />
      </Section>

      <Section title="间歇总结" storageKey="summary" defaultOpen={false}>
        <NumberInput
          label="时间触发（分钟）"
          value={Math.round(settings.summaryIntervalMs / 60000)}
          min={1}
          onChange={(v) => void update({ summaryIntervalMs: v * 60_000 })}
        />
        <NumberInput
          label="事件数触发"
          value={settings.summaryEventCount}
          min={1}
          onChange={(v) => void update({ summaryEventCount: v })}
        />
        <NumberInput
          label="同时跑总结上限"
          value={settings.summaryMaxConcurrent}
          min={1}
          max={10}
          onChange={(v) => void update({ summaryMaxConcurrent: v })}
        />
        <SummarizerErrorsDiagnostic />
      </Section>

      <Section title="窗口" storageKey="window" defaultOpen={false}>
        {/* 始终置顶由 header 的 📌 按钮 / 全局快捷键 Cmd+Alt+P 控制，
            这里不再放重复 toggle，避免两处状态打架。 */}
        <Toggle
          label="置顶时透明（看到下层桌面）"
          value={settings.transparentWhenPinned}
          onChange={(v) => void update({ transparentWhenPinned: v })}
        />
        <div className="text-[10px] leading-snug text-deck-muted/70">
          关掉后置顶时仍是实玻璃（macOS under-window vibrancy），看不到下层桌面 / 其他 app。
          切换后立即生效，无需重启。仅 macOS 有视觉差异。
        </div>
        <Toggle
          label="开机自启"
          value={settings.startOnLogin}
          onChange={(v) => void update({ startOnLogin: v })}
        />
      </Section>

      <Section title="HookServer" storageKey="hookserver" defaultOpen={false}>
        <NumberInput
          label="端口（重启生效）"
          value={settings.hookServerPort}
          min={1024}
          max={65535}
          onChange={(v) => void update({ hookServerPort: v })}
        />
      </Section>

      <Section title="外部工具" storageKey="external" defaultOpen={false}>
        <ExecutablePicker
          label="Codex 二进制路径"
          hint="留空 = 用应用内置 codex（推荐）。填路径 = 覆盖为外部 codex（如 `which codex` 给的路径）"
          path={settings.codexCliPath}
          onChange={(p) => void update({ codexCliPath: p })}
        />
      </Section>

      <Section title="应用约定（CLAUDE.md）" storageKey="claudemd" defaultOpen={false}>
        <Toggle
          label="启用 agent-deck CLAUDE.md 注入"
          value={settings.injectAgentDeckClaudeMd}
          onChange={(v) => void update({ injectAgentDeckClaudeMd: v })}
        />
        <div className="text-[10px] leading-snug text-deck-muted/70">
          关闭后下次新建会话不再注入；已运行的会话已固化进 LLM 上下文，关掉不会回收。
        </div>
        <ClaudeMdEditor onDirtyChange={onClaudeMdDirtyChange} />
      </Section>

      <Section title="应用 skill 与 agents（agent-deck plugin）" storageKey="plugin" defaultOpen={false}>
        <Toggle
          label="启用 agent-deck plugin 注入（skill + agents 绑定生效）"
          value={settings.injectAgentDeckPlugin}
          onChange={(v) => void update({ injectAgentDeckPlugin: v })}
        />
        <div className="text-[10px] leading-snug text-deck-muted/70">
          plugin 包含两类内容，**整体注入或整体不注入**：
          <br />
          · <strong>skills</strong>（如 <code className="rounded bg-white/5 px-1">agent-deck:deep-code-review</code>）—— 多轮异构 review × fix 收口工作流
          <br />
          · <strong>agents</strong>（如 <code className="rounded bg-white/5 px-1">agent-deck:reviewer-claude</code> / <code className="rounded bg-white/5 px-1">agent-deck:reviewer-codex</code>）—— 异构对抗 reviewer subagent，用于 deep-code-review 与「决策对抗」节
          <br />
          关闭后下次新建会话拿不到 agent-deck 自带的 skill 与 agents；已运行的会话已经在启动时拿到 plugin 列表，关掉不会撤销。
        </div>
      </Section>

      <Section title="实验功能" storageKey="experimental" defaultOpen={false}>
        <Toggle
          label="启用 Agent Teams（实验特性）"
          value={settings.agentTeamsEnabled}
          onChange={(v) => void update({ agentTeamsEnabled: v })}
        />
        <div className="text-[10px] leading-snug text-deck-muted/70">
          开启后新建会话对话框会出现 Team 名输入框；填了 team 名的 SDK 会话在 spawn 时
          注入 <code className="rounded bg-white/5 px-1">CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1</code>。
          需 Claude Code CLI ≥ v2.1.32 / 推荐 Opus 4.6+。
          <br />
          <strong className="text-deck-text/85">已知限制</strong>：不支持 /resume 与 /rewind；
          一个会话只能管一个 team；lead 终身固定。
          <br />
          <strong className="text-amber-300/90">⚠ 仅下次新建会话生效</strong>——已在跑的 team 会话不受影响（env 是 spawn 时一次性传入）。
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span>Teammate 权限自动放行</span>
          <select
            value={settings.autoApproveTeammateMode}
            onChange={(e) =>
              void update({
                autoApproveTeammateMode: e.target
                  .value as AppSettings['autoApproveTeammateMode'],
              })
            }
            className="no-drag rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
          >
            <option value="off">关闭（每次都弹）</option>
            <option value="read-only">只读工具自动允许（默认）</option>
            <option value="follow-lead">跟随 lead 权限模式</option>
          </select>
        </div>
        <div className="text-[10px] leading-snug text-deck-muted/70">
          Teammate 调工具时，按此规则在弹给你审批前先尝试自动允许。teammate 走 inbox
          协议而非 SDK canUseTool，所以 lead 的 permissionMode / settings.json 白名单
          对 teammate 失效——本档位补这道口子。
          <br />
          · <strong>read-only</strong>（默认）：与 lead 自身白名单一致——
          <code className="rounded bg-white/5 px-1">Read / Grep / Glob / LS / WebFetch / WebSearch / TodoWrite / NotebookRead / __ImageRead / mcp__tasks__*</code>
          自动允许；其他（Bash / Edit / Write…）仍弹给你
          <br />
          · <strong>follow-lead</strong>：以上 + 跟随 lead 当前 permissionMode（acceptEdits → 加放行
          <code className="rounded bg-white/5 px-1">Edit / Write / MultiEdit / NotebookEdit</code>；
          bypassPermissions → 全放行；default / plan → 降回 read-only）
          <br />
          · <strong>关闭</strong>：teammate 每次工具调用都弹给你（旧行为）
          <br />
          <strong className="text-deck-text/85">运行时即时生效</strong>——切档位下条 teammate
          请求就走新规则，不像 sandbox 那样要等下次新建会话。
        </div>
        <div className="mt-3 border-t border-deck-border/50 pt-3">
          <Toggle
            label="启用 SDK Task Manager（in-process MCP）"
            value={settings.enableTaskManager}
            onChange={(v) => void update({ enableTaskManager: v })}
          />
          <div className="mt-1 text-[10px] leading-snug text-deck-muted/70">
            开启后 SDK 会话注入 5 个结构化任务工具（<code className="rounded bg-white/5 px-1">mcp__tasks__task_create</code> / <code className="rounded bg-white/5 px-1">_list</code> / <code className="rounded bg-white/5 px-1">_get</code> / <code className="rounded bg-white/5 px-1">_update</code> / <code className="rounded bg-white/5 px-1">_delete</code>），让多个 SDK Agent 跨会话协作管理结构化任务。
            <br />
            <strong className="text-deck-text/85">与 Agent Teams 联动</strong>：会话所属 team 会自动闭包注入到任务工具，写操作（create/update/delete）锁在自己 team；只读（list/get）允许跨 team 协调。无 team 的会话只能操作全局任务。
            <br />
            与 <code className="rounded bg-white/5 px-1">~/.claude/tasks/&lt;team&gt;/&lt;list&gt;.md</code> 自然语言任务并行存在、互不覆盖（前者 Claude 内部协作用、后者结构化可被工具调用）。
            <br />
            <strong className="text-amber-300/90">⚠ 仅下次新建会话生效</strong>——已在跑的会话已固化 mcpServers 列表。
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span>Claude Code 沙盒（OS 级隔离）</span>
          <select
            value={settings.claudeCodeSandbox}
            onChange={(e) =>
              void update({
                claudeCodeSandbox: e.target.value as AppSettings['claudeCodeSandbox'],
              })
            }
            className="no-drag rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
          >
            <option value="off">关闭（默认）</option>
            <option value="workspace-write">Workspace Write</option>
            <option value="strict">Strict</option>
          </select>
        </div>
        <div className="text-[10px] leading-snug text-deck-muted/70">
          开启后 Claude SDK 子进程走 OS 级沙盒（macOS Seatbelt）。Codex 子进程已默认
          <code className="rounded bg-white/5 px-1">workspace-write</code>，本设置补齐 Claude
          这一侧。
          <br />
          · <strong>关闭</strong>：仅应用层 canUseTool 弹框决策（与现状一致）
          <br />
          · <strong>Workspace Write</strong>：cwd 可写；
          <code className="rounded bg-white/5 px-1">~/.ssh</code> /
          <code className="rounded bg-white/5 px-1">~/.aws</code> /
          <code className="rounded bg-white/5 px-1">~/.config</code> /
          <code className="rounded bg-white/5 px-1">~/.kube</code> /
          <code className="rounded bg-white/5 px-1">~/.gnupg</code> 等敏感目录禁读；
          网络默认禁，model 可用 <code className="rounded bg-white/5 px-1">dangerouslyDisableSandbox</code>
          重试（会弹框给你审批）
          <br />
          · <strong>Strict</strong>：cwd 也只读 + 完全封死逃逸路径；
          沙盒不可用（旧 macOS / Linux 无 bubblewrap）直接报错退出
          <br />
          常用工具（<code className="rounded bg-white/5 px-1">git / pnpm / npm / yarn / bun / pip / cargo / go</code>）
          默认豁免不进沙盒。需 Claude Code SDK ≥ v0.2.118。
          <br />
          <strong className="text-amber-300/90">⚠ 切档仅下次新建会话生效</strong>——已在跑的会话已按当前档位 spawn，不会被撤销。
        </div>
        <div className="mt-3 flex items-center justify-between text-[11px]">
          <span>Codex 沙盒（OS 级隔离）</span>
          <select
            value={settings.codexSandbox}
            onChange={(e) =>
              void update({
                codexSandbox: e.target.value as AppSettings['codexSandbox'],
              })
            }
            className="no-drag rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
          >
            <option value="workspace-write">Workspace Write（默认）</option>
            <option value="read-only">Read Only</option>
            <option value="danger-full-access">⚠ Danger Full Access</option>
          </select>
        </div>
        <div className="text-[10px] leading-snug text-deck-muted/70">
          Codex CLI 子进程的沙盒档位（codex SDK 原生三档，由 codex 自身 OS 隔离实现）。
          默认 <code className="rounded bg-white/5 px-1">workspace-write</code> 与 Claude 默认对齐；
          切档仅下次新建会话生效。
        </div>
      </Section>
    </>
  );
}
