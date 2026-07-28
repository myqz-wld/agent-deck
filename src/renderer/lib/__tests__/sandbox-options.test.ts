import { describe, expect, it } from 'vitest';
import {
  CLAUDE_SANDBOX_MODE_OPTIONS,
  CLAUDE_SANDBOX_OPTIONS,
  CODEX_SANDBOX_MODE_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  GROK_SANDBOX_MODE_OPTIONS,
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

  it('prepends the same follow-settings option in new-session dialogs', () => {
    expect(CLAUDE_SANDBOX_OPTIONS[0]).toEqual(CODEX_SANDBOX_OPTIONS[0]);
    expect(CLAUDE_SANDBOX_OPTIONS.slice(1)).toEqual(CLAUDE_SANDBOX_MODE_OPTIONS);
    expect(CODEX_SANDBOX_OPTIONS.slice(1)).toEqual(CODEX_SANDBOX_MODE_OPTIONS);
  });

  it('exposes every current Claude Code permission mode', () => {
    expect(PERMISSION_OPTIONS.map((option) => option.value)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'bypassPermissions',
    ]);
  });

  it('exposes all Grok built-ins in restrictive-to-open order', () => {
    expect(GROK_SANDBOX_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'strict',
      'read-only',
      'workspace',
      'devbox',
      'off',
    ]);
  });
});
