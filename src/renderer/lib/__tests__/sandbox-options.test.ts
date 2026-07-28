import { describe, expect, it } from 'vitest';
import {
  CLAUDE_SANDBOX_MODE_OPTIONS,
  CLAUDE_SANDBOX_OPTIONS,
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

  it('keeps only the simplified strict-to-open Grok settings choices', () => {
    expect(GROK_SETTINGS_SANDBOX_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'read-only',
      'workspace',
      'off',
    ]);
  });
});
