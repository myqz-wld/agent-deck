import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  file: '',
  execFile: vi.fn(() => ({ once: vi.fn(), kill: vi.fn() })),
}));

vi.mock('node:child_process', () => ({ execFile: fixtures.execFile }));
vi.mock('node:fs', () => ({ existsSync: (file: string) => file === fixtures.file }));
vi.mock('@main/platform', () => ({ IS_DARWIN: false, IS_LINUX: false, IS_WIN: true }));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: { getAll: () => ({ waitingSoundPath: fixtures.file, finishedSoundPath: null }) },
}));

import { playSoundOnce, stopAllSounds } from '../sound';

beforeEach(() => {
  vi.useFakeTimers();
  fixtures.execFile.mockClear();
});

afterEach(() => {
  stopAllSounds();
  vi.useRealTimers();
});

describe('Windows custom sound data boundary', () => {
  it.each([
    'C:\\Sounds\\normal.wav',
    'C:\\Sounds\\$(Write-Output SCAN_MARKER).wav',
    'C:\\Sounds\\$name`with space.wav',
    "C:\\Sounds\\single'quote.wav",
    'C:\\Sounds\\中文 #%.wav',
    '\\\\server\\share\\notification.wav',
  ])('passes %s as environment data to a fixed script', (file) => {
    fixtures.file = file;
    playSoundOnce('waiting');
    expect(fixtures.execFile).toHaveBeenCalledOnce();
    const [executable, args, options] = fixtures.execFile.mock.calls[0] as unknown as
      [string, string[], { env: Record<string, string> }];
    expect(executable).toBe('powershell');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toContain('[Uri]::new($env:AGENT_DECK_NOTIFICATION_SOUND_PATH)');
    expect(args.join(' ')).not.toContain(file);
    expect(args[3]).not.toContain('SCAN_MARKER');
    expect(args[3]).not.toContain('$(');
    expect(options.env.AGENT_DECK_NOTIFICATION_SOUND_PATH).toBe(file);
  });
});
