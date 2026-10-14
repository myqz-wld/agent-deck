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
    const labels = ['完全只读', '工作目录可写', '完全开放'];
    expect(CLAUDE_SANDBOX_MODE_OPTIONS.map((option) => option.label)).toEqual(labels);
    expect(CODEX_SANDBOX_MODE_OPTIONS.map((option) => option.label)).toEqual(labels);
    expect(CODEX_SANDBOX_MODE_OPTIONS.map((option) => Boolean(option.warning))).toEqual([false, false, true]);
    expect(CLAUDE_SANDBOX_MODE_OPTIONS.map((option) => Boolean(option.warning))).toEqual([false, false, true]);
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

  it('offers only the two shared permission presets', () => {
    expect(PERMISSION_OPTIONS.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: 'auto', label: '自动审批' },
      { value: 'bypassPermissions', label: '不再询问' },
    ]);
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
