import { describe, expect, it } from 'vitest';
import {
  MCP_TARGET_RUNTIME_SCHEMAS,
  targetRuntimeSchemaFields,
} from '../tools/schemas/target-runtime';
import { targetRuntimeFieldsForAdapter } from '@main/adapters/runtime-control-contracts';

describe('MCP target runtime schemas', () => {
  it.each(['claude-code', 'codex-cli', 'grok-build'] as const)(
    'keeps %s schema fields aligned with the adapter contract',
    (adapter) => {
      expect(targetRuntimeSchemaFields(adapter)).toEqual(
        targetRuntimeFieldsForAdapter(adapter),
      );
    },
  );

  it('accepts only Claude controls in the Claude schema', () => {
    expect(MCP_TARGET_RUNTIME_SCHEMAS['claude-code'].safeParse({
      gateway: 'deepseek',
      permissionMode: 'auto',
      claudeCodeSandbox: 'strict',
      extraAllowWrite: ['/repo-2'],
      thinking: 'max',
    }).success).toBe(true);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['claude-code'].safeParse({
      provider: 'deepseek',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['claude-code'].safeParse({
      codexSandbox: 'read-only',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['claude-code'].safeParse({
      thinking: 'ultra',
    }).success).toBe(false);
  });

  it('accepts Codex approval and writable roots but not Claude controls', () => {
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      provider: 'openrouter',
      approvalPolicy: 'on-request',
      codexSandbox: 'workspace-write',
      extraAllowWrite: ['/repo-2'],
      thinking: 'ultra',
    }).success).toBe(true);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      gateway: 'deepseek',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      approvalPolicy: 'always',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      permissionMode: 'plan',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      claudeCodeSandbox: 'strict',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      extraAllowWrite: ['relative/path'],
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      provider: 'native/provider',
    }).success).toBe(false);
  });

  it('accepts only Grok-owned mode and native sandbox controls', () => {
    expect(MCP_TARGET_RUNTIME_SCHEMAS['grok-build'].safeParse({
      model: 'grok-4.5',
      thinking: 'xhigh',
      sessionMode: 'ask',
      grokSandbox: 'strict',
    }).success).toBe(true);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['grok-build'].parse({
      grokSandbox: ' project-locked ',
    })).toMatchObject({ grokSandbox: 'project-locked' });
    expect(MCP_TARGET_RUNTIME_SCHEMAS['grok-build'].safeParse({
      gateway: 'xai',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['grok-build'].safeParse({
      codexSandbox: 'read-only',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['grok-build'].safeParse({
      approvalPolicy: 'never',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['grok-build'].safeParse({
      extraAllowWrite: [],
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['grok-build'].safeParse({
      grokSandbox: 'strict\nworkspace',
    }).success).toBe(false);
  });
});
