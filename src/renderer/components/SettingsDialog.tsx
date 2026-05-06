import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { DEFAULT_SETTINGS, type AppSettings, type HookInstallStatus } from '@shared/types';
import { HookSection } from './settings/sections/HookSection';
import { NotifySection } from './settings/sections/NotifySection';
import { LifecycleSection } from './settings/sections/LifecycleSection';
import { SummarySection } from './settings/sections/SummarySection';
import { WindowSection } from './settings/sections/WindowSection';
import { HookServerSection } from './settings/sections/HookServerSection';
import { ExternalToolsSection } from './settings/sections/ExternalToolsSection';
import { ClaudeMdSection } from './settings/sections/ClaudeMdSection';
import { PluginAssetsSection } from './settings/sections/PluginAssetsSection';
import { ExperimentalSection } from './settings/sections/ExperimentalSection';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 「在资产库中查看」按钮点击 → 打开 header 的 AssetsLibraryDialog（CHANGELOG_57）。 */
  onOpenAssetsLibrary: () => void;
}

/**
 * 设置弹窗外壳：负责 settings/hookStatus 加载、update IPC 调用、ClaudeMd dirty 拦截关闭。
 *
 * 9 个 section 拆到 settings/sections/ 子目录（CHANGELOG_57 D）；本文件只剩状态管理 +
 * 编排，避免 720→500→200 三轮拆分循环（CHANGELOG_50/51/52 拆分实例同模式）。
 *
 * dirty 契约（拆分后必须保住）：onClaudeMdDirtyChange 用 useCallback 稳定 identity →
 * 透传到 ClaudeMdSection → ClaudeMdEditor。中间任何一层加 useState / 再 useCallback
 * 都会破坏 ref 同步性（REVIEW_4 M11 教训）。
 */
export function SettingsDialog({ open, onClose, onOpenAssetsLibrary }: Props): JSX.Element | null {
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

  /**
   * 跳「📚 资产库」前同样拦截 dirty（CHANGELOG_57 R1·F1：reviewer 双对抗共识 HIGH 必修）。
   * X 按钮走 guardedClose 已拦，但 ClaudeMdSection / PluginAssetsSection 的「在资产库中查看 ↗」
   * 按钮直接调 props.onOpenAssetsLibrary → App.tsx 父级 setSettingsOpen(false) → SettingsDialog
   * 整体 return null → ClaudeMdEditor unmount → useEffect cleanup 跑 onDirtyChange?.(false) 把 ref
   * 重置 → 用户辛苦编辑的 CLAUDE.md 草稿无确认静默丢失。
   *
   * 复用 closeInFlightRef 锁同一组并发（设置面板内同一时刻只允许一个「跳出去」操作）；
   * 用户选「丢弃」才真正调上层 onOpenAssetsLibrary 触发 dialog 切换。
   */
  const guardedOpenAssetsLibrary = async (): Promise<void> => {
    if (closeInFlightRef.current) return;
    if (!claudeMdDirtyRef.current) {
      onOpenAssetsLibrary();
      return;
    }
    closeInFlightRef.current = true;
    try {
      const ok = await window.api.confirmDialog({
        title: '跳到资产库',
        message: 'CLAUDE.md 有未保存的草稿，跳转后会丢失，确定要继续吗？',
        detail: '建议先点「保存」再跳转。',
        okLabel: '丢弃并跳转',
        cancelLabel: '继续编辑',
        destructive: true,
      });
      if (ok) onOpenAssetsLibrary();
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
          <>
            <HookSection
              hookStatus={hookStatus}
              busy={busy}
              installHook={installHook}
              uninstallHook={uninstallHook}
            />
            <NotifySection settings={settings} update={update} />
            <LifecycleSection settings={settings} update={update} />
            <SummarySection settings={settings} update={update} />
            <WindowSection settings={settings} update={update} />
            <HookServerSection settings={settings} update={update} />
            <ExternalToolsSection settings={settings} update={update} />
            <ClaudeMdSection
              settings={settings}
              update={update}
              onClaudeMdDirtyChange={onClaudeMdDirtyChange}
              onOpenAssetsLibrary={() => void guardedOpenAssetsLibrary()}
            />
            <PluginAssetsSection
              settings={settings}
              update={update}
              onOpenAssetsLibrary={() => void guardedOpenAssetsLibrary()}
            />
            <ExperimentalSection settings={settings} update={update} />
          </>
        )}
      </div>
    </div>
  );
}
