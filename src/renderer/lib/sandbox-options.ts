/**
 * 全部 renderer 入口共享的 permission / sandbox 下拉选项。
 * 选项统一按限制从严格到宽松排列；新建会话直接显示解析后的具体值。
 */
import type { CodexApprovalPolicy, SelectablePermissionMode } from '@shared/types';
import type { GrokBuiltinSandboxProfile } from '@shared/grok-sandbox';

export type PermissionModeChoice = SelectablePermissionMode;
export type CodexApprovalPolicyChoice = CodexApprovalPolicy;
export type CodexSandboxChoice = 'workspace-write' | 'read-only' | 'danger-full-access';
export type ClaudeSandboxChoice = 'off' | 'workspace-write' | 'strict';
export type CodexSandboxMode = CodexSandboxChoice;
export type ClaudeSandboxMode = ClaudeSandboxChoice;
/** Empty follows the Agent Deck or Grok Build default; other strings may name custom profiles. */
export type GrokSandboxChoice = string;

export const PERMISSION_OPTIONS: { value: PermissionModeChoice; label: string; title?: string }[] = [
  { value: 'plan', label: '计划模式（只规划）', title: '只生成计划，不执行任何工具调用' },
  { value: 'default', label: '手动确认', title: '每次工具调用前都询问你是否允许' },
  { value: 'acceptEdits', label: '自动接受文件编辑', title: '自动允许文件编辑；其他工具仍需询问' },
  {
    value: 'auto',
    label: '自动判断',
    title: '由 Claude Code 的权限分类器自动允许或拒绝原本需要询问的工具调用',
  },
  {
    value: 'bypassPermissions',
    label: '⚠️ 不再询问（仍在系统沙盒内）',
    title: 'Claude Code 全程不再询问任何工具调用；系统沙盒（若启用）仍生效',
  },
];

export const CODEX_APPROVAL_POLICY_OPTIONS: {
  value: CodexApprovalPolicyChoice;
  label: string;
  title?: string;
}[] = [
  {
    value: 'untrusted',
    label: '非可信命令前询问',
    title: '已知安全的读取操作可直接运行，其他命令先请求批准',
  },
  {
    value: 'on-request',
    label: '按需询问',
    title: '默认在沙盒内执行，需要越过边界或确认副作用时请求批准',
  },
  {
    value: 'never',
    label: '从不询问',
    title: '不暂停请求批准；沙盒仍生效，超出权限的操作会直接失败',
  },
];

export const CODEX_SANDBOX_MODE_OPTIONS: {
  value: CodexSandboxMode;
  label: string;
  title?: string;
}[] = [
  { value: 'read-only', label: '完全只读', title: '所有文件只读，包括工作目录' },
  {
    value: 'workspace-write',
    label: '工作目录可写',
    title: '工作目录可写；网络默认禁用；其他目录只读',
  },
  {
    value: 'danger-full-access',
    label: '⚠️ 完全开放',
    title: '可读写任意文件、访问网络并运行任意命令',
  },
];

export const CLAUDE_SANDBOX_MODE_OPTIONS: {
  value: ClaudeSandboxMode;
  label: string;
  title?: string;
}[] = [
  {
    value: 'strict',
    label: '完全只读',
    title: '工作目录只读；敏感目录禁读；禁止绕过系统沙盒',
  },
  {
    value: 'workspace-write',
    label: '工作目录可写',
    title: '工作目录可写；敏感目录禁读；网络默认禁用',
  },
  {
    value: 'off',
    label: '⚠️ 完全开放',
    title: '关闭系统沙盒；仍受 Claude Code 权限设置约束',
  },
];

export const CODEX_SANDBOX_OPTIONS: {
  value: CodexSandboxChoice;
  label: string;
  title?: string;
}[] = CODEX_SANDBOX_MODE_OPTIONS;

export const CLAUDE_SANDBOX_OPTIONS: {
  value: ClaudeSandboxChoice;
  label: string;
  title?: string;
}[] = CLAUDE_SANDBOX_MODE_OPTIONS;

export const GROK_SANDBOX_MODE_OPTIONS: {
  value: GrokBuiltinSandboxProfile;
  label: string;
  title?: string;
}[] = [
  {
    value: 'read-only',
    label: '广泛只读',
    title: '可读取系统文件，仅 Grok Build 配置和临时目录可写；子进程网络受限',
  },
  {
    value: 'workspace',
    label: '工作目录可写',
    title: '工作目录、Grok Build 配置和临时目录可写；允许子进程联网',
  },
  {
    value: 'off',
    label: '⚠️ 完全开放',
    title: '不启用 Grok Build 系统沙盒；仍受 Grok Build 工具授权规则约束',
  },
];

/** All renderer surfaces share the same simplified built-in choices. */
export const GROK_SETTINGS_SANDBOX_MODE_OPTIONS = GROK_SANDBOX_MODE_OPTIONS;
