import { describe, expect, it } from 'vitest';
import { defaultFeishuModelPreference, mergeFeishuModelPreference, parseFeishuModelPreference } from './feishu-preferences';

const codex = { ...defaultFeishuModelPreference(), adapterId: 'codex-cli' as const, model: 'chat-model',
  thinking: 'max', permissionMode: 'auto' as const, codexSandbox: 'workspace-write' as const };

describe('adapter-owned Feishu configuration', () => {
  it('preserves omitted values and explicitly cleared permissions on same-adapter edits', () => {
    const previous = { adapterId: 'codex-cli' as const, provider: '', model: 'work-model', thinking: 'medium' };
    expect(parseFeishuModelPreference(previous)).toEqual(previous);
    expect(mergeFeishuModelPreference(codex, { permissionMode: 'bypassPermissions' }))
      .toEqual({ ...codex, permissionMode: 'bypassPermissions' });
    expect(mergeFeishuModelPreference(codex, { permissionMode: null, codexSandbox: null }))
      .toEqual({ ...codex, permissionMode: null, codexSandbox: null });
  });

  it('normalizes persisted native policies without retaining a hidden work-mode override', () => {
    const { permissionMode: _mode, ...legacy } = codex;
    expect(parseFeishuModelPreference({ ...legacy, approvalPolicy: 'on-request' })).toEqual(codex);
    expect(parseFeishuModelPreference({ ...legacy, approvalPolicy: 'never' }))
      .toEqual({ ...codex, permissionMode: 'bypassPermissions' });
    expect(parseFeishuModelPreference({ ...defaultFeishuModelPreference(), adapterId: 'grok-build', sessionMode: 'plan' }))
      .toEqual({ ...defaultFeishuModelPreference(), adapterId: 'grok-build', permissionMode: 'auto' });
  });

  it('shares permission choices while resetting adapter-specific sandbox fields', () => {
    expect(mergeFeishuModelPreference(codex, { adapterId: 'claude-code', permissionMode: 'auto', claudeCodeSandbox: 'strict' }))
      .toEqual({ ...defaultFeishuModelPreference(), adapterId: 'claude-code', permissionMode: 'auto', claudeCodeSandbox: 'strict' });
    expect(mergeFeishuModelPreference(codex, { adapterId: 'grok-build', permissionMode: 'auto', grokSandbox: 'workspace' }))
      .toEqual({ ...defaultFeishuModelPreference(), adapterId: 'grok-build', permissionMode: 'auto', grokSandbox: 'workspace' });
  });

  it.each([{ permissionMode: 'unknown' }, { grokSandbox: null }, { codexSandbox: 'strict' },
    { approvalPolicy: 'on-failure' }, { approvalPolicy: '' }, { extraAllowWrite: ['/private'] },
    { approvalPolicy: undefined }])('rejects incompatible or malformed choices %j', patch => {
    expect(() => parseFeishuModelPreference({ ...codex, ...patch })).toThrow();
  });
});
