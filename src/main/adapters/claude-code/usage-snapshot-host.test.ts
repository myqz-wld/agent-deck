import { afterEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn(() => ({ query: true })));
const loadSdk = vi.hoisted(() => vi.fn(async () => ({ query })));
const getSdkRuntimeOptions = vi.hoisted(() => vi.fn(() => ({
  executable: 'node' as const,
  env: { ELECTRON_RUN_AS_NODE: '1' },
})));
const resolveClaudeBinary = vi.hoisted(() => vi.fn(() => '/opt/claude'));
const getProviderUsageProbeCwd = vi.hoisted(() => vi.fn(() => '/probe'));
const release = vi.hoisted(() => vi.fn());
const expectSdkSession = vi.hoisted(() => vi.fn(() => release));

vi.mock('./sdk-loader', () => ({ loadSdk }));
vi.mock('./sdk-runtime', () => ({ getSdkRuntimeOptions }));
vi.mock('./resolve-claude-binary', () => ({ resolveClaudeBinary }));
vi.mock('@main/paths', () => ({ getProviderUsageProbeCwd }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop Claude usage snapshot host', () => {
  it('owns SDK/runtime/binary/path/claim discovery and wall clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:34:56.000Z'));
    const { createDesktopClaudeUsageSnapshotHost } = await import('./usage-snapshot-host');
    const host = createDesktopClaudeUsageSnapshotHost({ expectSdkSession });

    const sdk = await host.loadSdk();
    const controller = new AbortController();
    const prompt = { async *[Symbol.asyncIterator]() { return; } } as never;
    sdk.query({
      prompt,
      options: {
        cwd: '/probe',
        permissionMode: 'plan',
        settingSources: [],
        abortController: controller,
        executable: 'node',
        env: {},
      },
    });

    expect(loadSdk).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    expect(host.getRuntimeOptions()).toEqual({
      executable: 'node', env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(host.resolveClaudeBinary()).toBe('/opt/claude');
    expect(host.getProbeCwd()).toBe('/probe');
    expect(host.expectSdkSession('/probe', 60_000)).toBe(release);
    expect(host.now()).toBe(new Date('2026-08-05T12:34:56.000Z').getTime());
  });
});
