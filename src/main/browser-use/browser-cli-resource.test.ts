import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseBrowserOperationRequest } from './operation-contract';

interface BrowserCliResourceApi {
  parseCliArguments(argv: string[], options?: { cwd?: string }): unknown;
  rootHelp(): string;
}

const require = createRequire(import.meta.url);
const cliPath = resolve(process.cwd(), 'resources/bin/agent-deck-browser.cjs');

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function api(): BrowserCliResourceApi {
  return require(cliPath) as BrowserCliResourceApi;
}

describe('packaged agent-deck-browser CLI parser', () => {
  it('maps every command to the strict v1 semantic contract', () => {
    const cases: Array<[string[], string, Record<string, unknown>]> = [
      [['open', '--url', 'https://example.com', '--new-tab'], 'open', {
        url: 'https://example.com', newTab: true,
      }],
      [['tabs'], 'tabs', {}],
      [['navigate', '--reload', '--tab', '2'], 'navigate', { reload: true, tabId: 2 }],
      [['wait', '--kind', 'selector', '--selector', '#ready'], 'wait', {
        kind: 'selector', selector: '#ready',
      }],
      [['close', '--all'], 'close', { all: true }],
      [['snapshot', '--include-text', '--limit', '40'], 'snapshot', {
        includeText: true, limit: 40,
      }],
      [['screenshot', '--full-page', '--max-width', '900'], 'screenshot', {
        fullPage: true, maxWidth: 900,
      }],
      [['click', '--ref', '1-2'], 'click', { ref: '1-2' }],
      [['type', '--ref', '1-2', '--text', 'hello', '--append', '--submit'], 'type', {
        ref: '1-2', text: 'hello', clear: false, submit: true,
      }],
      [['press', '--key', 'Enter'], 'press', { key: 'Enter' }],
      [['scroll', '--dx', '5', '--dy', '600'], 'scroll', { dx: 5, dy: 600 }],
      [['console', '--limit', '10'], 'console', { limit: 10 }],
      [['network', '--tab', '3'], 'network', { tabId: 3 }],
      [['evaluate', '--expression', 'document.title'], 'evaluate', {
        expression: 'document.title',
      }],
    ];

    for (const [argv, operation, args] of cases) {
      const parsed = api().parseCliArguments(argv);
      expect(parseBrowserOperationRequest(parsed)).toEqual({
        protocolVersion: 1,
        operation,
        args,
      });
    }
  });

  it.each([
    '--session-id', '--owner', '--lease', '--token', '--endpoint', '--cwd', '--provider',
  ])('rejects caller-supplied ambient authority flag %s', (flag) => {
    expect(() => api().parseCliArguments(['tabs', flag, 'spoofed'])).toThrow(/Unknown flag/);
  });

  it('rejects duplicates, leftovers, null-like values, and invalid cross-field modes', () => {
    expect(() => api().parseCliArguments(['click', '--ref', '1-1', '--ref', '1-2']))
      .toThrow(/Duplicate flag/);
    expect(() => api().parseCliArguments(['tabs', 'leftover'])).toThrow(/Unexpected argument/);
    expect(() => api().parseCliArguments(['open', '--url', 'null'])).toThrow(/null-like/);
    expect(() => api().parseCliArguments([
      'navigate', '--url', 'https://example.com', '--reload',
    ])).toThrow();
    expect(() => api().parseCliArguments(['close', '--tab', '1', '--all'])).toThrow();
    expect(() => api().parseCliArguments([
      'scroll', '--ref', '1-1', '--dy', '600',
    ])).toThrow();
  });

  it('reads descriptor-bound text files only from the command cwd and sends no path', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-browser-cli-'));
    tempDirs.push(root);
    const textPath = join(root, 'input.txt');
    writeFileSync(textPath, 'safe text', { mode: 0o600 });

    const parsed = api().parseCliArguments([
      'type', '--ref', '1-1', '--text-file', textPath,
    ], { cwd: root });
    expect(parsed).toMatchObject({ operation: 'type', args: { text: 'safe text' } });
    expect(JSON.stringify(parsed)).not.toContain(textPath);

    const outside = join(tmpdir(), `agent-deck-browser-outside-${process.pid}.txt`);
    writeFileSync(outside, 'outside', { mode: 0o600 });
    try {
      expect(() => api().parseCliArguments([
        'evaluate', '--expression-file', outside,
      ], { cwd: root })).toThrow(/outside/);
      const link = join(root, 'link.txt');
      symlinkSync(outside, link);
      expect(() => api().parseCliArguments([
        'type', '--ref', '1-1', '--text-file', link,
      ], { cwd: root })).toThrow(/regular file|symbolic link/);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('generates syntax-only help without identity flags', () => {
    const help = api().rootHelp();
    expect(help).toContain('agent-deck-browser snapshot');
    expect(help).not.toMatch(/session-id|lease|token|endpoint|provider/);
  });
});
