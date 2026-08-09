import { describe, expect, it, vi } from 'vitest';

import {
  getPathToClaudeCodeExecutableCore,
  getSdkRuntimeOptionsCore,
  unpackClaudeSdkBinaryPathCore,
  type ClaudeSdkRuntimeHost,
} from './sdk-runtime-core';

function host(overrides: Partial<ClaudeSdkRuntimeHost> = {}): ClaudeSdkRuntimeHost {
  return {
    environment: () => ({}),
    executablePath: () => '/Applications/Agent Deck.app/Contents/MacOS/Agent Deck',
    platform: () => 'darwin',
    architecture: () => 'arm64',
    resolveModule: vi.fn(() => '/dev/node_modules/claude'),
    ...overrides,
  };
}

describe('getSdkRuntimeOptionsCore', () => {
  it('copies only string environment values and forces Electron Node mode', () => {
    expect(getSdkRuntimeOptionsCore(host({
      environment: () => ({ KEEP: 'value', OMIT: undefined, ELECTRON_RUN_AS_NODE: '0' }),
      executablePath: () => '/private/electron',
    }))).toEqual({
      executable: '/private/electron',
      env: { KEEP: 'value', ELECTRON_RUN_AS_NODE: '1' },
    });
  });
});

describe('getPathToClaudeCodeExecutableCore', () => {
  it('tries the Linux musl package before the glibc fallback', () => {
    const resolveModule = vi.fn((specifier: string) => {
      if (specifier.includes('-musl/')) throw new Error('not installed');
      return '/opt/app.asar/node_modules/@anthropic/claude';
    });

    expect(getPathToClaudeCodeExecutableCore(host({
      platform: () => 'linux',
      architecture: () => 'x64',
      resolveModule,
    }))).toBe('/opt/app.asar.unpacked/node_modules/@anthropic/claude');
    expect(resolveModule.mock.calls.map(([specifier]) => specifier)).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
      '@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    ]);
  });

  it('uses the executable suffix for Windows', () => {
    const resolveModule = vi.fn(() => 'C:\\app.asar\\node_modules\\claude.exe');

    expect(getPathToClaudeCodeExecutableCore(host({
      platform: () => 'win32',
      architecture: () => 'x64',
      resolveModule,
    }))).toBe('C:\\app.asar.unpacked\\node_modules\\claude.exe');
    expect(resolveModule).toHaveBeenCalledWith(
      '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
    );
  });

  it('returns undefined when no platform package resolves', () => {
    expect(getPathToClaudeCodeExecutableCore(host({
      resolveModule: () => {
        throw new Error('not installed');
      },
    }))).toBeUndefined();
  });
});

describe('unpackClaudeSdkBinaryPathCore', () => {
  it.each([
    ['/dev/node_modules/app.asar-tools/claude', '/dev/node_modules/app.asar-tools/claude'],
    ['/dev/app.asar.unpacked/node_modules/claude', '/dev/app.asar.unpacked/node_modules/claude'],
    ['/dev/app.asar/node_modules/claude', '/dev/app.asar.unpacked/node_modules/claude'],
  ])('rewrites only a complete packed path segment: %s', (input, expected) => {
    expect(unpackClaudeSdkBinaryPathCore(input)).toBe(expected);
  });
});
