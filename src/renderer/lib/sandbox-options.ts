/**
 * 新建会话类对话框共享的 permission / sandbox 下拉选项（NewSessionDialog + ResolveInNewSessionDialog）。
 *
 * 与 composer-sdk/SandboxSelects.tsx 的区别：本组每类多一个 `''` =「跟随设置（默认）」选项 —
 * 新建会话时留空表示「不 per-session 覆盖，走 adapter / settings 全局默认」；composer 那组用于
 * 已存在会话，sandbox 已是具体值故无 `''` 档。两个新建会话对话框共用本模块避免选项数组三处重复。
 */

export type PermissionModeChoice = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
/** `''` = 跟随设置（不 per-session 覆盖） */
export type CodexSandboxChoice = '' | 'workspace-write' | 'read-only' | 'danger-full-access';
/** `''` = 跟随设置（不 per-session 覆盖） */
export type ClaudeSandboxChoice = '' | 'off' | 'workspace-write' | 'strict';

export const PERMISSION_OPTIONS: { value: PermissionModeChoice; label: string; title?: string }[] = [
  { value: 'default', label: '每次询问（默认）', title: '每次工具调用前都询问你是否允许' },
  { value: 'acceptEdits', label: '自动接受文件编辑', title: '自动允许文件编辑；其他工具仍需询问' },
  { value: 'plan', label: '计划模式（只规划）', title: '只生成计划，不执行任何工具调用' },
  {
    value: 'bypassPermissions',
    label: '⚠️ 不再询问（仍在系统沙盒内）',
    title: 'Claude 全程不再询问任何工具调用；系统沙盒（若启用）仍生效',
  },
];

export const CODEX_SANDBOX_OPTIONS: { value: CodexSandboxChoice; label: string; title?: string }[] = [
  { value: '', label: '跟随设置（默认）', title: '使用「实验功能」中的全局设置' },
  { value: 'workspace-write', label: '工作目录可写', title: '工作目录可写；网络默认禁；其他目录只读' },
  { value: 'read-only', label: '完全只读', title: '所有文件只读，包括工作目录' },
  {
    value: 'danger-full-access',
    label: '⚠️ 完全开放（可改任意文件 / 联网 / 运行任意命令）',
    title: '没有任何限制：可以读写任意文件、访问网络、运行任意命令',
  },
];

export const CLAUDE_SANDBOX_OPTIONS: { value: ClaudeSandboxChoice; label: string; title?: string }[] = [
  { value: '', label: '跟随设置（默认）', title: '使用「实验功能」中的全局设置' },
  { value: 'off', label: '⚠️ 关闭（无系统沙盒）', title: '系统不会限制 Claude；仅靠应用内授权弹窗管控' },
  { value: 'workspace-write', label: '工作目录可写', title: '工作目录可写；敏感目录禁读；网络默认禁' },
  { value: 'strict', label: '严格只读', title: '工作目录也只读，最严格' },
];
