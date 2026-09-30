import { describe, expect, it } from 'vitest';
import { defaultFeishuModelPreference, mergeFeishuModelPreference, parseFeishuModelPreference } from './feishu-preferences';

const codex = { ...defaultFeishuModelPreference(), adapterId: 'codex-cli' as const, model: 'chat-model',
  thinking: 'max', approvalPolicy: 'on-request' as const, codexSandbox: 'workspace-write' as const };

describe('adapter-owned Feishu configuration', () => {
  it('reads existing files without runtime fields and preserves omissions in same-adapter edits', () => {
    const previous = { adapterId: 'codex-cli' as const, provider: '', model: 'work-model', thinking: 'medium' };
    expect(parseFeishuModelPreference(previous)).toEqual(previous);
    expect(mergeFeishuModelPreference(codex, { approvalPolicy: 'untrusted' }))
      .toEqual({ ...codex, approvalPolicy: 'untrusted' });
    expect(mergeFeishuModelPreference(codex, { approvalPolicy: null, codexSandbox: null }))
      .toEqual({ ...codex, approvalPolicy: null, codexSandbox: null });
  });
  it('resets incompatible settings on adapter changes and supports that adapter’s own fields', () => {
    expect(mergeFeishuModelPreference(codex, { adapterId: 'claude-code', permissionMode: 'plan', claudeCodeSandbox: 'strict' }))
      .toEqual({ ...defaultFeishuModelPreference(), adapterId: 'claude-code', permissionMode: 'plan', claudeCodeSandbox: 'strict' });
    expect(mergeFeishuModelPreference(codex, { adapterId: 'grok-build', sessionMode: 'ask', grokSandbox: 'workspace' }))
      .toEqual({ ...defaultFeishuModelPreference(), adapterId: 'grok-build', sessionMode: 'ask', grokSandbox: 'workspace' });
  });
  it.each([{ permissionMode: 'default' }, { grokSandbox: null }, { codexSandbox: 'strict' },
    { approvalPolicy: 'on-failure' }, { approvalPolicy: '' }, { extraAllowWrite: ['/private'] },
    { approvalPolicy: undefined }])('rejects incompatible or malformed choices %j', patch => {
    expect(() => parseFeishuModelPreference({ ...codex, ...patch })).toThrow();
  });
});
