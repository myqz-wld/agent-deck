/**
 * codex-config/toml-writer 单测（CHANGELOG_<X> A4a）。
 *
 * 覆盖：stringify round-trip、marker 替换、用户段保留、空 servers、quoted key。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readMcpServersFromCodexConfig,
  stringifyMcpServersSection,
  writeMcpServersToCodexConfig,
  type CodexMcpServerConfig,
} from '../toml-writer';

function makeTmp(): string {
  return join(mkdtempSync(join(tmpdir(), 'codex-toml-')), 'config.toml');
}

describe('stringifyMcpServersSection', () => {
  it('emits MARKER_START + MARKER_END even for empty servers', () => {
    const out = stringifyMcpServersSection([]);
    expect(out).toContain('Agent Deck MCP Servers START');
    expect(out).toContain('Agent Deck MCP Servers END');
  });

  it('serializes stdio server with command + args + env', () => {
    const out = stringifyMcpServersSection([
      {
        name: 'foo',
        command: 'node',
        args: ['/path with spaces/foo.js', '--bar'],
        env: { API_KEY: 'sk-xxx', VERBOSE: '1' },
      },
    ]);
    expect(out).toMatch(/\[mcp_servers\.foo\]/);
    expect(out).toMatch(/command = "node"/);
    expect(out).toMatch(/args = \["\/path with spaces\/foo\.js", "--bar"\]/);
    expect(out).toMatch(/\[mcp_servers\.foo\.env\]/);
    expect(out).toMatch(/API_KEY = "sk-xxx"/);
    expect(out).toMatch(/VERBOSE = "1"/);
  });

  it('serializes http server with url + bearer_token_env_var', () => {
    const out = stringifyMcpServersSection([
      {
        name: 'remote',
        url: 'https://api.example.com/mcp',
        bearerTokenEnvVar: 'REMOTE_TOKEN',
      },
    ]);
    expect(out).toMatch(/\[mcp_servers\.remote\]/);
    expect(out).toMatch(/url = "https:\/\/api\.example\.com\/mcp"/);
    expect(out).toMatch(/bearer_token_env_var = "REMOTE_TOKEN"/);
  });

  it('skips invalid server name with comment', () => {
    const out = stringifyMcpServersSection([
      { name: 'has space', command: 'x' },
      { name: 'valid-one', command: 'x' },
    ]);
    expect(out).toMatch(/skipped invalid server name: "has space"/);
    expect(out).toMatch(/\[mcp_servers\.valid-one\]/);
  });

  it('quotes namespaced server name with /', () => {
    // agent-deck 自带 server 用 'agent-deck/<X>' 命名约定（A5 任务）
    const out = stringifyMcpServersSection([
      { name: 'agent-deck/spawn-session', command: 'node' },
    ]);
    expect(out).toMatch(/\[mcp_servers\."agent-deck\/spawn-session"\]/);
  });
});

describe('writeMcpServersToCodexConfig + readMcpServersFromCodexConfig round-trip', () => {
  it('writes to empty path then reads back equivalent config', () => {
    const path = makeTmp();
    const servers: CodexMcpServerConfig[] = [
      { name: 'a', command: 'node', args: ['x'], env: { K: 'v' } },
      { name: 'b', url: 'https://example.com/mcp', bearerTokenEnvVar: 'TOKEN' },
    ];
    writeMcpServersToCodexConfig(servers, path);
    const back = readMcpServersFromCodexConfig(path);
    expect(back).toEqual(servers);
  });

  it('returns [] for nonexistent file', () => {
    const path = join(tmpdir(), `does-not-exist-${Date.now()}.toml`);
    expect(readMcpServersFromCodexConfig(path)).toEqual([]);
  });

  it('returns [] when file has no marker', () => {
    const path = makeTmp();
    writeFileSync(path, 'model = "gpt-5.5"\n\n[some.section]\nfoo = 1\n', 'utf8');
    expect(readMcpServersFromCodexConfig(path)).toEqual([]);
  });
});

describe('writeMcpServersToCodexConfig preserves user content', () => {
  it('preserves user content when marker absent (append section)', () => {
    const path = makeTmp();
    const userContent =
      'model = "gpt-5.5"\nmodel_provider = "xaminim"\n\n' +
      '[model_providers.xaminim]\nname = "OpenRouter"\n';
    writeFileSync(path, userContent, 'utf8');
    writeMcpServersToCodexConfig([{ name: 'foo', command: 'node' }], path);
    const next = readFileSync(path, 'utf8');
    // 用户段应原样保留
    expect(next).toContain('model = "gpt-5.5"');
    expect(next).toContain('[model_providers.xaminim]');
    expect(next).toContain('name = "OpenRouter"');
    // 我们的段在末尾追加
    expect(next).toContain('Agent Deck MCP Servers START');
    expect(next).toContain('[mcp_servers.foo]');
    expect(next).toContain('Agent Deck MCP Servers END');
  });

  it('replaces only the marker section on second write (user content untouched)', () => {
    const path = makeTmp();
    writeFileSync(path, 'model = "gpt-5.5"\n', 'utf8');
    // 第一次写入
    writeMcpServersToCodexConfig([{ name: 'old', command: 'node' }], path);
    // 第二次写入：覆盖
    writeMcpServersToCodexConfig([{ name: 'new', command: 'python' }], path);
    const next = readFileSync(path, 'utf8');
    expect(next).toContain('model = "gpt-5.5"');
    expect(next).not.toContain('[mcp_servers.old]');
    expect(next).toContain('[mcp_servers.new]');
    expect(next).toContain('command = "python"');
  });

  it('preserves user-written [mcp_servers.X] outside marker (user owns those)', () => {
    const path = makeTmp();
    const userContent =
      '[mcp_servers."user-owned"]\ncommand = "user"\n';
    writeFileSync(path, userContent, 'utf8');
    writeMcpServersToCodexConfig([{ name: 'agent-one', command: 'node' }], path);
    const next = readFileSync(path, 'utf8');
    // 用户的 mcp_servers 段（marker 之外）保留
    expect(next).toContain('[mcp_servers."user-owned"]');
    expect(next).toContain('command = "user"');
    // Agent Deck 的段在末尾
    expect(next).toContain('Agent Deck MCP Servers START');
    expect(next).toContain('[mcp_servers.agent-one]');
    // read 只读 marker 内的，看不到 user-owned
    const back = readMcpServersFromCodexConfig(path);
    expect(back.find((s) => s.name === 'user-owned')).toBeUndefined();
    expect(back.find((s) => s.name === 'agent-one')).toBeDefined();
  });
});

describe('TOML escape edge cases', () => {
  it('round-trips strings with quotes and backslashes', () => {
    const path = makeTmp();
    writeMcpServersToCodexConfig(
      [{ name: 'esc', command: 'echo "hi"', args: ['C:\\path\\file'] }],
      path,
    );
    const back = readMcpServersFromCodexConfig(path);
    expect(back).toEqual([
      { name: 'esc', command: 'echo "hi"', args: ['C:\\path\\file'] },
    ]);
  });

  it('round-trips empty args array', () => {
    const path = makeTmp();
    writeMcpServersToCodexConfig([{ name: 'a', command: 'node' }], path);
    const back = readMcpServersFromCodexConfig(path);
    expect(back).toEqual([{ name: 'a', command: 'node' }]);
  });
});
