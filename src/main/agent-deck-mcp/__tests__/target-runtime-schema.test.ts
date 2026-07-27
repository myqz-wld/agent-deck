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
      permissionMode: 'auto',
      claudeCodeSandbox: 'strict',
      extraAllowWrite: ['/repo-2'],
      thinking: 'max',
    }).success).toBe(true);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['claude-code'].safeParse({
      codexSandbox: 'read-only',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['claude-code'].safeParse({
      thinking: 'ultra',
    }).success).toBe(false);
  });

  it('accepts Codex writable roots but not Claude permission or sandbox fields', () => {
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      codexSandbox: 'workspace-write',
      extraAllowWrite: ['/repo-2'],
      thinking: 'ultra',
    }).success).toBe(true);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      permissionMode: 'plan',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      claudeCodeSandbox: 'strict',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['codex-cli'].safeParse({
      extraAllowWrite: ['relative/path'],
    }).success).toBe(false);
  });

  it('keeps Grok on ACP-native mode and rejects provider/sandbox controls', () => {
    expect(MCP_TARGET_RUNTIME_SCHEMAS['grok-build'].safeParse({
      model: 'grok-4.5',
      thinking: 'xhigh',
      sessionMode: 'ask',
    }).success).toBe(true);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['grok-build'].safeParse({
      provider: 'xai',
    }).success).toBe(false);
    expect(MCP_TARGET_RUNTIME_SCHEMAS['grok-build'].safeParse({
      extraAllowWrite: [],
    }).success).toBe(false);
  });
});
