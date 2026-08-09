import { afterEach, describe, expect, it, vi } from 'vitest';

const existsSync = vi.hoisted(() => vi.fn(() => true));
const readFileSync = vi.hoisted(() => vi.fn(() => '{"env":{}}'));
const warn = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync,
  readFileSync,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => '/host-home',
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn, info: vi.fn() }) },
}));
vi.mock('@main/utils/safe-diagnostic', () => ({
  safeDiagnostic: (value: unknown) => value,
}));
vi.mock('@main/utils/run-context', () => ({ getProcessRunId: () => 'host-run' }));

describe('desktop Claude settings environment host', () => {
  const original = process.env.CLAUDE_HOST_TEST;

  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_HOST_TEST;
    else process.env.CLAUDE_HOST_TEST = original;
  });

  it('owns filesystem, home, process environment, and bounded diagnostics', async () => {
    const { desktopClaudeSettingsEnvHost: host } = await import('./settings-env-host');
    const path = host.resolveSettingsPath();

    expect(path).toBe('/host-home/.claude/settings.json');
    expect(host.settingsFileExists(path)).toBe(true);
    expect(host.readSettingsText(path)).toBe('{"env":{}}');
    host.assignEnv('CLAUDE_HOST_TEST', 'value');
    host.observeState('rejected-keys', 1, 2);

    expect(process.env.CLAUDE_HOST_TEST).toBe('value');
    expect(existsSync).toHaveBeenCalledWith(path);
    expect(readFileSync).toHaveBeenCalledWith(path, 'utf8');
    expect(warn).toHaveBeenCalledWith(
      'Claude configuration state degraded',
      expect.objectContaining({ appliedCount: 1, rejectedCount: 2 }),
    );
  });
});
