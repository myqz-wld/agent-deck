import { describe, expect, it, vi } from 'vitest';
import {
  CodexDesktopEphemeralFilter,
  isDesktopHostedCodexAppServer,
  type ProcessSnapshot,
} from '../desktop-ephemeral-filter';

const CHATGPT_CODEX: ProcessSnapshot = {
  pid: 42396,
  parentPid: 42351,
  command:
    '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled',
};

const CHATGPT_APP: ProcessSnapshot = {
  pid: 42351,
  parentPid: 1,
  command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
};

describe('isDesktopHostedCodexAppServer', () => {
  it('recognizes a Codex app-server owned by the same macOS Desktop bundle', () => {
    expect(isDesktopHostedCodexAppServer(CHATGPT_CODEX, CHATGPT_APP, 'darwin')).toBe(true);
  });

  it('does not classify a terminal-owned app-server as Desktop hosted', () => {
    expect(
      isDesktopHostedCodexAppServer(
        { ...CHATGPT_CODEX, parentPid: 100 },
        { pid: 100, parentPid: 1, command: '/bin/zsh -l' },
        'darwin',
      ),
    ).toBe(false);
  });

  it('requires child and parent to belong to the same supported macOS bundle', () => {
    expect(
      isDesktopHostedCodexAppServer(
        CHATGPT_CODEX,
        { ...CHATGPT_APP, command: '/Applications/Codex.app/Contents/MacOS/Codex' },
        'darwin',
      ),
    ).toBe(false);
  });

  it('recognizes the Windows Desktop parent executable', () => {
    expect(
      isDesktopHostedCodexAppServer(
        {
          pid: 20,
          parentPid: 10,
          executable: 'C:\\Program Files\\ChatGPT\\resources\\codex.exe',
          command: '"C:\\Program Files\\ChatGPT\\resources\\codex.exe" app-server',
        },
        {
          pid: 10,
          parentPid: 1,
          executable: 'C:\\Program Files\\ChatGPT\\ChatGPT.exe',
          command: '"C:\\Program Files\\ChatGPT\\ChatGPT.exe"',
        },
        'win32',
      ),
    ).toBe(true);
  });

  it('fails open on platforms without a stable Desktop host contract', () => {
    expect(isDesktopHostedCodexAppServer(CHATGPT_CODEX, CHATGPT_APP, 'linux')).toBe(false);
  });
});

describe('CodexDesktopEphemeralFilter', () => {
  it('filters explicit transcript-null hooks from a verified Desktop process', async () => {
    const snapshots = new Map<number, ProcessSnapshot>([
      [CHATGPT_CODEX.pid, CHATGPT_CODEX],
      [CHATGPT_APP.pid, CHATGPT_APP],
    ]);
    const readProcess = vi.fn(async (pid: number) => snapshots.get(pid) ?? null);
    const filter = new CodexDesktopEphemeralFilter({ platform: 'darwin', readProcess });

    await expect(
      filter.shouldIgnore(
        { session_id: 'ambient-1', transcript_path: null },
        'cli',
        CHATGPT_CODEX.pid,
      ),
    ).resolves.toBe(true);
    await expect(
      filter.shouldIgnore(
        { session_id: 'ambient-1', transcript_path: null },
        'cli',
        CHATGPT_CODEX.pid,
      ),
    ).resolves.toBe(true);
    await expect(
      filter.shouldIgnore(
        { session_id: 'ambient-2', transcript_path: null },
        'cli',
        CHATGPT_CODEX.pid,
      ),
    ).resolves.toBe(true);

    expect(readProcess).toHaveBeenCalledTimes(2);
    expect(readProcess).toHaveBeenNthCalledWith(1, CHATGPT_CODEX.pid);
    expect(readProcess).toHaveBeenNthCalledWith(2, CHATGPT_APP.pid);
  });

  it('preserves a user-launched terminal ephemeral session', async () => {
    const snapshots = new Map<number, ProcessSnapshot>([
      [100, { pid: 100, parentPid: 50, command: '/usr/local/bin/codex app-server' }],
      [50, { pid: 50, parentPid: 1, command: '/bin/zsh -l' }],
    ]);
    const filter = new CodexDesktopEphemeralFilter({
      platform: 'darwin',
      readProcess: async (pid) => snapshots.get(pid) ?? null,
    });

    await expect(
      filter.shouldIgnore({ session_id: 'terminal-ephemeral', transcript_path: null }, 'cli', 100),
    ).resolves.toBe(false);
  });

  it.each([
    {
      label: 'missing transcript field',
      body: { session_id: 'old-client' },
      origin: 'cli' as const,
      pid: CHATGPT_CODEX.pid,
    },
    {
      label: 'persistent transcript',
      body: { session_id: 'persistent', transcript_path: '/tmp/rollout.jsonl' },
      origin: 'cli' as const,
      pid: CHATGPT_CODEX.pid,
    },
    {
      label: 'Agent Deck SDK origin',
      body: { session_id: 'sdk', transcript_path: null },
      origin: 'sdk' as const,
      pid: CHATGPT_CODEX.pid,
    },
    {
      label: 'missing process pid',
      body: { session_id: 'no-pid', transcript_path: null },
      origin: 'cli' as const,
      pid: null,
    },
  ])('preserves $label without inspecting the process', async ({ body, origin, pid }) => {
    const readProcess = vi.fn(async () => CHATGPT_CODEX);
    const filter = new CodexDesktopEphemeralFilter({ platform: 'darwin', readProcess });

    await expect(filter.shouldIgnore(body, origin, pid)).resolves.toBe(false);
    expect(readProcess).not.toHaveBeenCalled();
  });

  it('keeps the first fail-open decision for every later hook in the session', async () => {
    const readProcess = vi.fn(async (pid: number) =>
      pid === CHATGPT_CODEX.pid ? CHATGPT_CODEX : CHATGPT_APP,
    );
    const filter = new CodexDesktopEphemeralFilter({ platform: 'darwin', readProcess });

    await expect(
      filter.shouldIgnore({ session_id: 'mixed-client' }, 'cli', CHATGPT_CODEX.pid),
    ).resolves.toBe(false);
    await expect(
      filter.shouldIgnore(
        { session_id: 'mixed-client', transcript_path: null },
        'cli',
        CHATGPT_CODEX.pid,
      ),
    ).resolves.toBe(false);

    expect(readProcess).not.toHaveBeenCalled();
  });

  it('fails open and caches a process lookup failure for the session', async () => {
    const readProcess = vi.fn(async () => {
      throw new Error('ps unavailable');
    });
    const filter = new CodexDesktopEphemeralFilter({ platform: 'darwin', readProcess });

    await expect(
      filter.shouldIgnore({ session_id: 'lookup-error', transcript_path: null }, 'cli', 999),
    ).resolves.toBe(false);
    await expect(
      filter.shouldIgnore({ session_id: 'lookup-error', transcript_path: null }, 'cli', 999),
    ).resolves.toBe(false);

    expect(readProcess).toHaveBeenCalledTimes(1);
  });

  it('fails open without process inspection on unsupported Desktop platforms', async () => {
    const readProcess = vi.fn(async () => CHATGPT_CODEX);
    const filter = new CodexDesktopEphemeralFilter({ platform: 'linux', readProcess });

    await expect(
      filter.shouldIgnore({ session_id: 'linux-ephemeral', transcript_path: null }, 'cli', 123),
    ).resolves.toBe(false);
    expect(readProcess).not.toHaveBeenCalled();
  });
});
