import { describe, expect, it, vi } from 'vitest';

async function loadDefaultsModule() {
  vi.resetModules();
  return import('../useLastSessionDefaults');
}

describe('useLastSessionDefaults', () => {
  it('claude-code 冷启动默认权限模式为不再询问', async () => {
    const { getLastDefaults } = await loadDefaultsModule();

    expect(getLastDefaults('claude-code')).toEqual({ permissionMode: 'bypassPermissions' });
  });

  it('用户选择会覆盖 claude-code 默认,且不串到 codex-cli', async () => {
    const { getLastDefaults, setLastDefaults } = await loadDefaultsModule();

    setLastDefaults('claude-code', { permissionMode: 'plan', claudeCodeSandbox: 'strict' });
    setLastDefaults('codex-cli', { codexSandbox: 'read-only' });

    expect(getLastDefaults('claude-code')).toEqual({
      permissionMode: 'plan',
      claudeCodeSandbox: 'strict',
    });
    expect(getLastDefaults('codex-cli')).toEqual({ codexSandbox: 'read-only' });
  });
});
