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
      <Section title="Claude Code Hook">
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

      <Section title="提醒">
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

      <Section title="生命周期">
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

      <Section title="间歇总结">
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

      <Section title="窗口">
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

      <Section title="HookServer">
        <NumberInput
          label="端口（重启生效）"
          value={settings.hookServerPort}
          min={1024}
          max={65535}
          onChange={(v) => void update({ hookServerPort: v })}
        />
      </Section>

      <Section title="外部工具">
        <ExecutablePicker
          label="Codex 二进制路径"
          hint="留空 = 用应用内置 codex（推荐）。填路径 = 覆盖为外部 codex（如 `which codex` 给的路径）"
          path={settings.codexCliPath}
          onChange={(p) => void update({ codexCliPath: p })}
        />
      </Section>

      <Section title="应用约定（CLAUDE.md）">
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
    </>
  );
}
