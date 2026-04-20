import { useEffect, useState, type JSX } from 'react';
import { DEFAULT_SETTINGS, type AppSettings, type HookInstallStatus } from '@shared/types';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: Props): JSX.Element | null {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [hookStatus, setHookStatus] = useState<HookInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    void window.api
      .getSettings()
      .then((s) =>
        // 用 DEFAULT_SETTINGS 兜底：main 端老 schema 缺字段时（HMR 不能 reload main，
        // 改了 AppSettings 后没重启 dev 就会缺新加的字段），前端表单仍能显示默认值。
        setSettings({ ...DEFAULT_SETTINGS, ...((s as Partial<AppSettings>) ?? {}) }),
      )
      .catch((err: unknown) =>
        setLoadError(`getSettings 失败：${(err as Error).message ?? String(err)}`),
      );
    void window.api
      .hookStatus('user')
      .then((s) => setHookStatus(s as HookInstallStatus))
      .catch((err: unknown) =>
        setLoadError(
          (prev) =>
            (prev ? prev + '\n' : '') +
            `hookStatus 失败：${(err as Error).message ?? String(err)}`,
        ),
      );
  }, [open]);

  if (!open) return null;

  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    setBusy(true);
    try {
      const next = (await window.api.setSettings(patch)) as AppSettings;
      setSettings(next);
    } finally {
      setBusy(false);
    }
  };

  const installHook = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = (await window.api.installHook('user')) as HookInstallStatus;
      setHookStatus(r);
    } finally {
      setBusy(false);
    }
  };
  const uninstallHook = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = (await window.api.uninstallHook('user')) as HookInstallStatus;
      setHookStatus(r);
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
            onClick={onClose}
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
}

function SettingsBody({
  settings,
  hookStatus,
  busy,
  update,
  installHook,
  uninstallHook,
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
        </Section>

        <Section title="窗口">
          {/* 始终置顶由 header 的 📌 按钮 / 全局快捷键 Cmd+Alt+P 控制，
              这里不再放重复 toggle，避免两处状态打架。 */}
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
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="mb-4">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted/70">{title}</div>
      <div className="flex flex-col gap-1.5 rounded-lg border border-deck-border bg-white/[0.02] p-2">
        {children}
      </div>
    </section>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center justify-between text-[11px]">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer"
      />
    </label>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px]">
      <span className="flex-1">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="w-20 rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-right text-[11px] outline-none focus:border-white/20"
      />
    </label>
  );
}

/**
 * 选择本地音频文件作为提示音；提供「试听 / 选择 / 重置」三个动作。
 * path = null 时显示「默认」（系统提示音），否则显示文件名。
 */
function SoundPicker({
  label,
  kind,
  path,
  onChange,
}: {
  label: string;
  kind: 'waiting' | 'done';
  path: string | null;
  onChange: (path: string | null) => void;
}): JSX.Element {
  const fileName = path ? path.split('/').pop() : null;
  const choose = async (): Promise<void> => {
    const r = await window.api.chooseSoundFile(path ?? undefined);
    if (r) onChange(r);
  };
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="flex-1">{label}</span>
        <div className="flex items-center gap-1 no-drag">
          <button
            type="button"
            onClick={() => void window.api.playTestSound(kind)}
            title="试听当前提示音"
            className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          >
            ▶ 试听
          </button>
          <button
            type="button"
            onClick={() => void choose()}
            className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-deck-text hover:bg-white/20"
          >
            选择…
          </button>
          {path && (
            <button
              type="button"
              onClick={() => onChange(null)}
              title="恢复默认（系统提示音）"
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-status-waiting/80 hover:bg-status-waiting/20"
            >
              重置
            </button>
          )}
        </div>
      </div>
      <div
        className="truncate text-[10px] text-deck-muted/70"
        title={path ?? '使用系统提示音'}
      >
        {fileName ?? '默认（系统提示音）'}
      </div>
    </div>
  );
}

/**
 * 测试系统通知按钮。点击后调 main 进程的 Notification API。
 * macOS 系统设置里的应用名取自 `app.getName()` —— dev 模式是「Electron」、
 * 生产打包是「Agent Deck」。提示文字读 main 返回的 appName 拼接，避免
 * 装好的 .app 让用户去找「Electron」找不到。
 */
function NotificationTestRow(): JSX.Element {
  const [result, setResult] = useState<string | null>(null);
  const test = async (): Promise<void> => {
    setResult(null);
    try {
      const r = (await window.api.showTestNotification()) as {
        ok: boolean;
        reason?: string;
        appName?: string;
      };
      if (r.ok) {
        const name = r.appName || 'Agent Deck';
        setResult(`已发送，没看到横幅请到 系统设置 → 通知 → ${name} 检查权限`);
      } else {
        setResult(`失败：${r.reason ?? '未知'}`);
      }
    } catch (err) {
      setResult(`失败：${(err as Error).message}`);
    }
  };
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="flex-1">测试系统通知</span>
        <button
          type="button"
          onClick={() => void test()}
          className="no-drag rounded bg-white/10 px-2 py-0.5 text-[10px] text-deck-text hover:bg-white/20"
        >
          ▶ 弹一条
        </button>
      </div>
      {result && (
        <div className="text-[10px] leading-snug text-deck-muted/80">{result}</div>
      )}
    </div>
  );
}
