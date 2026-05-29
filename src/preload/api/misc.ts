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

  // CODEX_AGENTS.md（注入到 ~/.codex/AGENTS.md Agent Deck 段的 codex 视角应用约定）
  /** 读取「当前生效」的 CODEX_AGENTS.md（用户副本优先 → 回落内置）。 */
  getCodexAgentsMd: (): Promise<{ content: string; isCustom: boolean }> =>
    ipcRenderer.invoke(IpcInvoke.CodexAgentsMdGet),
  /** 保存用户副本到 userData/agent-deck-codex-agents.md。save 后**主进程主动 syncAgentDeckSection**
   *  把内容立即同步到 ~/.codex/AGENTS.md(否则 user 改了 但 codex SDK 仍读旧 cache);返回写盘后
   *  实际读回的内容(同 saveClaudeMd 模式)。 */
  saveCodexAgentsMd: (content: string): Promise<{ content: string; isCustom: true }> =>
    ipcRenderer.invoke(IpcInvoke.CodexAgentsMdSave, content),
  /** 删除用户副本回落内置 + 同步 ~/.codex/AGENTS.md 段;返回新的内置内容供 UI 同步刷新。 */
  resetCodexAgentsMd: (): Promise<{ ok: boolean; content: string }> =>
    ipcRenderer.invoke(IpcInvoke.CodexAgentsMdReset),

  // ─────────── Assets Library (CHANGELOG_57 / plan assets-codex-user-and-ui-unify-20260521 §D7) ───────────
  /** 列内置 plugin agents+skills（main 启动时一次性扫 frontmatter，缓存读）。 */
  listBundledAssets: (): Promise<BundledAssetsSnapshot> =>
    ipcRenderer.invoke(IpcInvoke.AssetsListBundled),
  /** 列用户自定义资产（双 root scan：~/.claude/{agents,skills}/ + ~/.codex/skills/）；每次现扫现读。 */
  listUserAssets: (): Promise<UserAssetsSnapshot> =>
    ipcRenderer.invoke(IpcInvoke.AssetsListUser),
  /**
   * 读单个 asset 完整 md 文本（含 frontmatter + body）。「查看完整内容」/ 编辑器 mount 用。
   *
   * **plan assets-codex-user-and-ui-unify-20260521 §D7 升级**：第 4 参数 `adapter` user 也必传：
   * - bundled 资产：传 `asset.adapter`（'claude-code' / 'codex-cli'，narrow 到 plugin root）
   * - user 资产：传 `asset.adapter`（'claude-code' / 'codex-cli'，narrow 到 ~/.claude/ 或 ~/.codex/ root）
   * - renderer 直接透传 `AssetMeta.adapter` 字段值即可（null 类型已删除）
   */
  getAssetContent: (
    kind: AssetKind,
    name: string,
    source: AssetSource,
    adapter: 'claude-code' | 'codex-cli',
  ): Promise<AssetContentResult> =>
    ipcRenderer.invoke(IpcInvoke.AssetsGetContent, kind, name, source, adapter),
  /** 保存用户 asset；main 端拼装 frontmatter + 原子写。返回写盘后的 AssetMeta。
   *  input 含 `adapter` 字段（plan §D5 sub-tab 锁定），codex+agent 组合 IPC 层硬拒。 */
  saveUserAsset: (input: UserAssetInput): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AssetsSaveUser, input),
  /** 删除用户 asset。skill 子目录递归 rm，agent 单文件 unlink。
   *  **plan §D7 升级**：第 3 参数 `adapter` 必传（同名跨 adapter 独立资产不变量 #5，只删当前 adapter root）。 */
  deleteUserAsset: (
    kind: AssetKind,
    name: string,
    adapter: 'claude-code' | 'codex-cli',
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AssetsDeleteUser, kind, name, adapter),
  /**
   * 在 Finder / 资源管理器中显示对应文件，跨平台。
   *
   * **plan §D7 升级**：第 4 参数 `adapter` user 也必传（同 getAssetContent 语义）。
   */
  revealAssetInFolder: (
    kind: AssetKind,
    name: string,
    source: AssetSource,
    adapter: 'claude-code' | 'codex-cli',
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcInvoke.AssetsRevealInFolder, kind, name, source, adapter),

  /**
   * 拉取 summarizer 最近一次失败原因（by sessionId），UI 设置面板诊断用。
   * 空对象表示没有任何会话失败过（CHANGELOG_20 / G）。
   */
  summarizerLastErrors: (): Promise<Record<string, { message: string; ts: number }>> =>
    ipcRenderer.invoke(IpcInvoke.SummarizerLastErrors),

  // ─── Runtime Logging (Plan runtime-logging-electron-log-20260529 §D9 §Step 3.2.3) ───
  /** Settings LogsSection 「打开日志目录」 — main 端调 shell.openPath(app.getPath('logs')). */
  logsOpenDirectory: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcInvoke.LogsOpenDirectory),
  /**
   * Settings LogsSection 「在 Finder 中显示当前日志」 — main 端调 shell.showItemInFolder
   * 选中今天 main-YYYY-MM-DD.log; 文件不存在 fallback 退化为 openPath LOG_DIR (UI 透明无感).
   */
  logsShowCurrentInFinder: (): Promise<{ ok: boolean; fallback?: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcInvoke.LogsShowCurrentInFinder),
  /**
   * Settings LogsSection 「清空今天日志」 — main 端 fs.truncate 当天 log 文件; 文件不存在返
   * `{ ok: true, existed: false }` 让 UI 弹「今天还没有日志可清空」toast.
   */
  logsTruncateToday: (): Promise<{ ok: boolean; existed: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcInvoke.LogsTruncateToday),
};
