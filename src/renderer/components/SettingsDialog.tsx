import { useEffect, useRef, useState, type JSX } from 'react';
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
  /** 「在资产库中查看」按钮点击 → 关本 dialog 打开 AssetsLibraryDialog（CHANGELOG_57 / 58）。 */
  onOpenAssetsLibrary: () => void;
}

/**
 * 设置弹窗外壳：负责 settings/hookStatus 加载、update IPC 调用、9 个 section 编排。
 *
 * 9 个 section 拆到 settings/sections/ 子目录（CHANGELOG_57 D）；本文件只剩状态管理 +
 * 编排，避免 720→500→200 三轮拆分循环（CHANGELOG_50/51/52 拆分实例同模式）。
 *
 * CHANGELOG_58：CLAUDE.md 编辑器迁到 AssetsLibraryDialog「应用约定」tab，本面板不再嵌
 * 编辑器；ClaudeMdSection 只剩注入 toggle + 跳资产库的链接。dirty 拦截契约整套迁过去，
 * 本文件不再持有 claudeMdDirtyRef / guardedClose / guardedOpenAssetsLibrary 等模板。
 */
export function SettingsDialog({ open, onClose, onOpenAssetsLibrary }: Props): JSX.Element | null {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [hookStatus, setHookStatus] = useState<HookInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 写设置 / 安装 hook 的异步错误（CHANGELOG_20 / N7：原本 try/finally 无 catch，IPC 失败用户看不到原因）。
   *  与 loadError 分两个 slot 避免互相覆盖；写错误一段时间后会被下一次成功操作清掉。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** REVIEW_4 M9：每次重新打开都递增，旧 effect 的 then 回调用这个比对 abort，
   *  避免快速切换 open 时旧响应回写新打开的 state。 */
  const openSeqRef = useRef(0);
  /** REVIEW_4 M9：update 请求序号；连点多个 toggle 时慢响应回写旧值会被丢弃。 */
  const updateSeqRef = useRef(0);

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
            onClick={onClose}
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
              onOpenAssetsLibrary={onOpenAssetsLibrary}
            />
            <PluginAssetsSection
              settings={settings}
              update={update}
              onOpenAssetsLibrary={onOpenAssetsLibrary}
            />
            <ExperimentalSection settings={settings} update={update} />
          </>
        )}
      </div>
    </div>
  );
}
