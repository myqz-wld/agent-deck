import { describe, expect, it } from 'vitest';
import {
  CLAUDE_SANDBOX_MODE_OPTIONS,
  CLAUDE_SANDBOX_OPTIONS,
  CODEX_APPROVAL_POLICY_OPTIONS,
  CODEX_SANDBOX_MODE_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  GROK_SANDBOX_MODE_OPTIONS,
  GROK_SETTINGS_SANDBOX_MODE_OPTIONS,
  PERMISSION_OPTIONS,
} from '../sandbox-options';

describe('sandbox option copy', () => {
  it('uses the same risk order and labels for Claude and Codex', () => {
    const labels = ['完全只读', '工作目录可写', '⚠️ 完全开放'];
    expect(CLAUDE_SANDBOX_MODE_OPTIONS.map((option) => option.label)).toEqual(labels);
    expect(CODEX_SANDBOX_MODE_OPTIONS.map((option) => option.label)).toEqual(labels);
    expect(CLAUDE_SANDBOX_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'strict',
      'workspace-write',
      'off',
    ]);
    expect(CODEX_SANDBOX_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ]);
  });

  it('shows concrete sandbox values in new-session dialogs', () => {
    expect(CLAUDE_SANDBOX_OPTIONS).toEqual(CLAUDE_SANDBOX_MODE_OPTIONS);
    expect(CODEX_SANDBOX_OPTIONS).toEqual(CODEX_SANDBOX_MODE_OPTIONS);
  });

  it('exposes every current Claude Code permission mode from restrictive to permissive', () => {
    expect(PERMISSION_OPTIONS.map((option) => option.value)).toEqual([
      'plan',
      'default',
      'acceptEdits',
      'auto',
      'bypassPermissions',
    ]);
    expect(PERMISSION_OPTIONS[3]?.title).toBe(
      '由 Claude Code 的权限分类器自动允许或拒绝原本需要询问的工具调用',
    );
    expect(PERMISSION_OPTIONS[4]?.title).toBe(
      'Claude Code 全程不再询问任何工具调用；系统沙盒（若启用）仍生效',
    );
  });

  it('orders Codex approval policies from strict interaction to no prompts', () => {
    expect(CODEX_APPROVAL_POLICY_OPTIONS.map((option) => option.value)).toEqual([
      'untrusted',
      'on-request',
      'never',
    ]);
  });

  it('exposes only the simplified Grok UI built-ins in restrictive-to-open order', () => {
    expect(GROK_SANDBOX_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'read-only',
      'workspace',
      'off',
    ]);
    expect(GROK_SANDBOX_MODE_OPTIONS.map((option) => option.title)).toEqual([
      '可读取系统文件，仅 Grok Build 配置和临时目录可写；子进程网络受限',
      '工作目录、Grok Build 配置和临时目录可写；允许子进程联网',
      '不启用 Grok Build 系统沙盒；仍受 Grok Build 工具授权规则约束',
    ]);
  });

  it('uses the same simplified Grok choices in settings', () => {
    expect(GROK_SETTINGS_SANDBOX_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'read-only',
      'workspace',
      'off',
    ]);
  });
});
