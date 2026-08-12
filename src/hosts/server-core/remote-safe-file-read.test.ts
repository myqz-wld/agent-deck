import { describe, expect, it, vi } from 'vitest';

import {
  readRemoteSafeFile,
  type RemoteSafeFileFilesystem,
} from './remote-safe-file-read';

function stat(dev: number, ino: number, size = 4) {
  return { dev, ino, size, isFile: () => true };
}

function fake(overrides: Partial<RemoteSafeFileFilesystem> = {}): RemoteSafeFileFilesystem {
  return {
    close: vi.fn(),
    fstat: vi.fn(() => stat(1, 2)),
    open: vi.fn(() => 7),
    read: vi.fn(() => 'safe'),
    realpath: vi.fn((path) => path),
    stat: vi.fn(() => stat(1, 2)),
    ...overrides,
  };
}

const options = {
  maximumBytes: 64,
  root: '/workspace',
  sensitive: (path: string) => path.includes('secret'),
};

describe('readRemoteSafeFile', () => {
  it('reads the validated file only through the opened descriptor', () => {
    const fs = fake();
    expect(readRemoteSafeFile('/workspace/asset.md', options, fs)).toEqual({
      canonicalPath: '/workspace/asset.md',
      content: 'safe',
    });
    expect(fs.read).toHaveBeenCalledWith(7);
  });

  it('rejects a retargeted path before reading the opened descriptor', () => {
    const realpath = vi.fn()
      .mockReturnValueOnce('/workspace/asset.md')
      .mockReturnValueOnce('/workspace/replaced.md');
    const fs = fake({
      realpath,
      stat: vi.fn(() => stat(9, 9)),
    });
    expect(readRemoteSafeFile('/workspace/asset.md', options, fs)).toBeNull();
    expect(fs.read).not.toHaveBeenCalled();
    expect(fs.close).toHaveBeenCalledWith(7);
  });

  it('rejects sensitive lexical paths before touching the filesystem', () => {
    const fs = fake();
    expect(readRemoteSafeFile('/workspace/secrets/token.md', options, fs)).toBeNull();
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.open).not.toHaveBeenCalled();
  });
});
