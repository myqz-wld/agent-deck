/**
 * preload/api/misc: 不属于 sessions / adapters / teams 三大域的杂项 IPC facade。
 *
 * 包含 app version / window 控制 / hooks / settings / dialogs / claude-md / assets /
 * permissions 扫描 / 图片加载 / summarizer 诊断。
 */

import { ipcRenderer } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import type {
  AppSettings,
  AssetContentResult,
  AssetKind,
  AssetSource,
  BundledAssetsSnapshot,
  ImageSource,
  LoadImageBlobResult,
  PermissionScanResult,
  UserAssetInput,
  UserAssetsSnapshot,
} from '@shared/types';

export const miscApi = {
  // 应用
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IpcInvoke.AppGetVersion),

  /**
   * 当前进程平台（CHANGELOG_57）。preload 进程能直接读 `process.platform` 全局
   * （与 contextIsolated 无关——process 是 Node 注入），常量值启动后永不变 →
   * 静态字段暴露，不必走 ipcRenderer.invoke。renderer 用 `src/renderer/lib/platform.ts`
   * 的 `IS_DARWIN/IS_WIN/IS_LINUX` 包装消费。
   */
  platform: process.platform as NodeJS.Platform,

  // 窗口
  setAlwaysOnTop: (value: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.WindowSetAlwaysOnTop, value),
  setIgnoreMouse: (value: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.WindowSetIgnoreMouse, value),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IpcInvoke.WindowMinimize),
  toggleCompact: (): Promise<boolean> => ipcRenderer.invoke(IpcInvoke.WindowToggleCompact),

  // Hook
  installHook: (scope: 'user' | 'project', cwd?: string): Promise<unknown> =>
    ipcRenderer.invoke(IpcInvoke.HookInstall, scope, cwd),
  uninstallHook: (scope: 'user' | 'project', cwd?: string): Promise<unknown> =>
    ipcRenderer.invoke(IpcInvoke.HookUninstall, scope, cwd),
  hookStatus: (scope: 'user' | 'project', cwd?: string): Promise<unknown> =>
    ipcRenderer.invoke(IpcInvoke.HookStatus, scope, cwd),

  // 设置
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IpcInvoke.SettingsGet),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IpcInvoke.SettingsSet, patch),

  // Dialog
  chooseDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcInvoke.DialogChooseDirectory, defaultPath),
  chooseSoundFile: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcInvoke.DialogChooseSoundFile, defaultPath),
  /** 选择可执行文件（用于设置面板「Codex 二进制路径」） */
  chooseExecutableFile: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcInvoke.DialogChooseExecutable, defaultPath),

  // App helpers
  playTestSound: (kind: 'waiting' | 'done'): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AppPlayTestSound, kind),
  showTestNotification: (): Promise<{ ok: boolean; reason?: string; appName?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AppShowTestNotification),
  confirmDialog: (opts: {
    title?: string;
    message?: string;
    detail?: string;
    okLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }): Promise<boolean> => ipcRenderer.invoke(IpcInvoke.DialogConfirm, opts),

  /** 扫描会话 cwd 对应的三层 Claude Code settings.json，返回原文 + 合并视图 */
  scanCwdSettings: (cwd: string): Promise<PermissionScanResult> =>
    ipcRenderer.invoke(IpcInvoke.PermissionScanCwd, cwd),
  /** 用系统默认应用打开 settings 文件；main 端会校验 path 必须是该 cwd 的候选路径之一 */
  openPermissionFile: (
    cwd: string,
    path: string,
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.PermissionOpenFile, cwd, path),

  /**
   * 按需读取一张 mcp 图片工具产生的图片为 dataURL（main 进程做白名单 + ext + size 校验）。
   * 仅支持 path 形态的 ImageSource；任何失败返回 { ok:false, reason }，由 UI 显示「图片不可读」灰底兜底。
   */
  loadImageBlob: (sessionId: string, source: ImageSource): Promise<LoadImageBlobResult> =>
    ipcRenderer.invoke(IpcInvoke.ImageLoadBlob, sessionId, source),

  /**
   * 加载用户在输入框上传的图片（与 loadImageBlob 走完全独立白名单）。
   * 路径必须在 <userData>/image-uploads/ 下；失败返回 { ok:false, reason } 由 UI 灰底兜底
   * （图片可能已被 reaper 清 / 用户磁盘删了）。
   */
  loadUploadedImage: (path: string): Promise<LoadImageBlobResult> =>
    ipcRenderer.invoke(IpcInvoke.UploadedImageLoad, path),

  // CLAUDE.md（注入到 SDK system prompt 末尾的 agent-deck 应用约定）
  /** 读取「当前生效」的 CLAUDE.md（用户副本优先 → 回落内置）。 */
  getClaudeMd: (): Promise<{ content: string; isCustom: boolean }> =>
    ipcRenderer.invoke(IpcInvoke.ClaudeMdGet),
  /** 保存用户副本到 userData/agent-deck-claude.md（清缓存，下次新建会话生效）。
   *  返回 main 写盘后**实际读回**的内容（REVIEW_4 M11：让 renderer 用真实内容更新 loaded
   *  避免 main 端规范化后 dirty 永真）。 */
  saveClaudeMd: (content: string): Promise<{ content: string; isCustom: true }> =>
    ipcRenderer.invoke(IpcInvoke.ClaudeMdSave, content),
  /** 删除用户副本回落内置；返回新的内置内容供 UI 同步刷新。 */
  resetClaudeMd: (): Promise<{ ok: boolean; content: string }> =>
    ipcRenderer.invoke(IpcInvoke.ClaudeMdReset),

  // ─────────── Assets Library (CHANGELOG_57) ───────────
  /** 列内置 plugin agents+skills（main 启动时一次性扫 frontmatter，缓存读）。 */
  listBundledAssets: (): Promise<BundledAssetsSnapshot> =>
    ipcRenderer.invoke(IpcInvoke.AssetsListBundled),
  /** 列用户自定义 ~/.claude/{agents,skills}/ 下全部资产；每次现扫现读。 */
  listUserAssets: (): Promise<UserAssetsSnapshot> =>
    ipcRenderer.invoke(IpcInvoke.AssetsListUser),
  /** 读单个 asset 完整 md 文本（含 frontmatter + body）。「查看完整内容」/ 编辑器 mount 用。 */
  getAssetContent: (
    kind: AssetKind,
    name: string,
    source: AssetSource,
  ): Promise<AssetContentResult> =>
    ipcRenderer.invoke(IpcInvoke.AssetsGetContent, kind, name, source),
  /** 保存用户 asset；main 端拼装 frontmatter + 原子写。返回写盘后的 AssetMeta。 */
  saveUserAsset: (input: UserAssetInput): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AssetsSaveUser, input),
  /** 删除用户 asset。skill 子目录递归 rm，agent 单文件 unlink。 */
  deleteUserAsset: (
    kind: AssetKind,
    name: string,
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AssetsDeleteUser, kind, name),
  /** 在 Finder / 资源管理器中显示对应文件，跨平台。 */
  revealAssetInFolder: (
    kind: AssetKind,
    name: string,
    source: AssetSource,
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AssetsRevealInFolder, kind, name, source),

  /**
   * 拉取 summarizer 最近一次失败原因（by sessionId），UI 设置面板诊断用。
   * 空对象表示没有任何会话失败过（CHANGELOG_20 / G）。
   */
  summarizerLastErrors: (): Promise<Record<string, { message: string; ts: number }>> =>
    ipcRenderer.invoke(IpcInvoke.SummarizerLastErrors),
};
