/**
 * D2 type-narrow regression test (p4-d2-impl Step 4.1)：验证 buildCreateSessionOptions
 * builder helper + typed adapter export 的编译期/运行时约束。
 *
 * **编译期约束**（用 `// @ts-expect-error` 注释 — typecheck 命令验证）：
 * - claude-code adapter 误传 codexSandbox → TS 报错
 * - codex-cli adapter 误传 permissionMode → TS 报错
 * - codex-cli adapter 误传 claudeCodeSandbox → TS 报错
 * - PTY adapter 误传 resume / model → TS 报错
 *
 * **运行时约束**（vitest 跑 — 验证 narrow 行为）：
 * - buildCreateSessionOptions 按 agentId narrow → filter 掉不属本 adapter 的字段
 * - invalid agentId → throw
 * - exhaustive switch default 分支不会被命中（TS 编译期 _exhaustive: never 守门）
 */
import { describe, expect, it } from 'vitest';
import { buildCreateSessionOptions } from '../options-builder';
import { claudeCodeAdapter } from '../claude-code';
import { codexCliAdapter } from '../codex-cli';
import { aiderAdapter } from '../aider';
import { genericPtyAdapter } from '../generic-pty';
import type { CreateSessionOptions } from '../types';

describe('buildCreateSessionOptions — D2 builder helper narrow 行为', () => {
  it('claude-code adapter narrow：保留 ClaudeCreateOpts 字段，filter 掉 codexSandbox / genericPtyConfig', () => {
    const opts = buildCreateSessionOptions('claude-code', {
      cwd: '/tmp',
      prompt: 'hello',
      permissionMode: 'acceptEdits',
      claudeCodeSandbox: 'workspace-write',
      // 跨 adapter 字段：传入但应被 filter
      codexSandbox: 'read-only',
      genericPtyConfig: {
        command: '/bin/echo',
        args: [],
        env: {},
        cwd: '',
        idleQuietMs: 3000,
        promptSuffixRegex: '',
      },
    });
    expect(opts).toEqual({
      agentId: 'claude-code',
      cwd: '/tmp',
      prompt: 'hello',
      permissionMode: 'acceptEdits',
      claudeCodeSandbox: 'workspace-write',
    });
    expect('codexSandbox' in opts).toBe(false);
    expect('genericPtyConfig' in opts).toBe(false);
  });

  it('codex-cli adapter narrow：保留 CodexCreateOpts 字段，filter 掉 permissionMode / claudeCodeSandbox / genericPtyConfig', () => {
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/tmp',
      prompt: 'hello',
      codexSandbox: 'read-only',
      // 跨 adapter 字段：传入但应被 filter
      permissionMode: 'acceptEdits',
      claudeCodeSandbox: 'strict',
      genericPtyConfig: {
        command: '/bin/echo',
        args: [],
        env: {},
        cwd: '',
        idleQuietMs: 3000,
        promptSuffixRegex: '',
      },
    });
    expect(opts).toEqual({
      agentId: 'codex-cli',
      cwd: '/tmp',
      prompt: 'hello',
      codexSandbox: 'read-only',
    });
    expect('permissionMode' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
    expect('genericPtyConfig' in opts).toBe(false);
  });

  it('aider adapter narrow：保留 PtyCreateOpts 字段，filter 掉 permissionMode / resume / model / sandbox', () => {
    const opts = buildCreateSessionOptions('aider', {
      cwd: '/tmp',
      prompt: 'hello',
      genericPtyConfig: {
        command: '/usr/local/bin/aider',
        args: ['--no-stream'],
        env: {},
        cwd: '',
        idleQuietMs: 3000,
        promptSuffixRegex: '\\>\\s*$',
      },
      // 跨 adapter 字段：传入但应被 filter
      permissionMode: 'acceptEdits',
      resume: 'old-sid',
      model: 'opus',
      claudeCodeSandbox: 'strict',
      codexSandbox: 'read-only',
    });
    expect(opts).toMatchObject({
      agentId: 'aider',
      cwd: '/tmp',
      prompt: 'hello',
    });
    expect('permissionMode' in opts).toBe(false);
    expect('resume' in opts).toBe(false);
    expect('model' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
    expect('codexSandbox' in opts).toBe(false);
  });

  it('generic-pty adapter narrow：与 aider 同款字段集（共享 PtyCreateOpts）', () => {
    const opts = buildCreateSessionOptions('generic-pty', {
      cwd: '/tmp',
      prompt: 'hello',
      genericPtyConfig: {
        command: '/bin/cat',
        args: [],
        env: {},
        cwd: '',
        idleQuietMs: 3000,
        promptSuffixRegex: '',
      },
      attachments: [],
      teamName: 'my-team',
      // 跨 adapter 字段：传入但应被 filter
      permissionMode: 'plan',
      model: 'sonnet',
    });
    expect(opts.agentId).toBe('generic-pty');
    expect('permissionMode' in opts).toBe(false);
    expect('model' in opts).toBe(false);
  });

  it('invalid agentId → throw（string overload 内部 isAgentId guard）', () => {
    expect(() =>
      buildCreateSessionOptions('unknown-adapter' as string, { cwd: '/tmp' }),
    ).toThrow(/unknown agentId.*unknown-adapter/);
  });

  it('undefined 字段 raw 不写 opts（caller spread 链不污染）', () => {
    const opts = buildCreateSessionOptions('claude-code', {
      cwd: '/tmp',
      prompt: undefined, // explicit undefined
      permissionMode: undefined,
    });
    // narrow 函数 if (raw.X !== undefined) 跳过 undefined 字段 → opts 不含 prompt / permissionMode
    expect(opts).toEqual({
      agentId: 'claude-code',
      cwd: '/tmp',
    });
    expect('prompt' in opts).toBe(false);
    expect('permissionMode' in opts).toBe(false);
  });
});

describe('typed adapter export — D2 编译期约束（@ts-expect-error 由 typecheck 验证）', () => {
  // 用 narrow 类型 annotation 触发 TS excess property check + @ts-expect-error 守门:
  // typecheck 跑时 expected 行 TS 必须真报错否则 typecheck 报 "Unused @ts-expect-error
  // directive"; vitest runtime 这些 _wrongOpts 仅 cwd 字段访问做 sanity check, 不实跑
  // adapter.createSession (避免 init 链复杂)。
  type ClaudeOpts = Extract<CreateSessionOptions, { agentId: 'claude-code' }>;
  type CodexOpts = Extract<CreateSessionOptions, { agentId: 'codex-cli' }>;
  type AiderOpts = Extract<CreateSessionOptions, { agentId: 'aider' }>;
  type GenericPtyOpts = Extract<CreateSessionOptions, { agentId: 'generic-pty' }>;

  it('claude-code adapter createSession 误传 codexSandbox → TS 报错', () => {
    const _wrongOpts: ClaudeOpts = {
      agentId: 'claude-code',
      cwd: '/tmp',
      // @ts-expect-error - codexSandbox 不在 ClaudeCreateOpts 内（D2 强约束）
      codexSandbox: 'read-only',
    };
    expect(_wrongOpts.cwd).toBe('/tmp');
  });

  it('codex-cli adapter createSession 误传 permissionMode → TS 报错', () => {
    const _wrongOpts: CodexOpts = {
      agentId: 'codex-cli',
      cwd: '/tmp',
      // @ts-expect-error - permissionMode 不在 CodexCreateOpts 内（D2 强约束）
      permissionMode: 'acceptEdits',
    };
    expect(_wrongOpts.cwd).toBe('/tmp');
  });

  it('codex-cli adapter createSession 误传 claudeCodeSandbox → TS 报错', () => {
    const _wrongOpts: CodexOpts = {
      agentId: 'codex-cli',
      cwd: '/tmp',
      // @ts-expect-error - claudeCodeSandbox 不在 CodexCreateOpts 内（D2 强约束）
      claudeCodeSandbox: 'strict',
    };
    expect(_wrongOpts.cwd).toBe('/tmp');
  });

  it('aider adapter createSession 误传 resume → TS 报错', () => {
    const _wrongOpts: AiderOpts = {
      agentId: 'aider',
      cwd: '/tmp',
      // @ts-expect-error - resume 不在 PtyCreateOpts 内（PTY 不支持 resume，每次新起 PTY 子进程）
      resume: 'old-sid',
    };
    expect(_wrongOpts.cwd).toBe('/tmp');
  });

  it('aider adapter createSession 误传 model → TS 报错', () => {
    const _wrongOpts: AiderOpts = {
      agentId: 'aider',
      cwd: '/tmp',
      // @ts-expect-error - model 不在 PtyCreateOpts 内（PTY 无 model 概念）
      model: 'opus',
    };
    expect(_wrongOpts.cwd).toBe('/tmp');
  });

  it('generic-pty adapter createSession 误传 permissionMode → TS 报错', () => {
    const _wrongOpts: GenericPtyOpts = {
      agentId: 'generic-pty',
      cwd: '/tmp',
      // @ts-expect-error - permissionMode 不在 PtyCreateOpts 内
      permissionMode: 'plan',
    };
    expect(_wrongOpts.cwd).toBe('/tmp');
  });
});

describe('typed adapter export — runtime 实例 capabilities + agentId 一致', () => {
  it('claudeCodeAdapter.id === "claude-code"', () => {
    expect(claudeCodeAdapter.id).toBe('claude-code');
  });
  it('codexCliAdapter.id === "codex-cli"', () => {
    expect(codexCliAdapter.id).toBe('codex-cli');
  });
  it('aiderAdapter.id === "aider"', () => {
    expect(aiderAdapter.id).toBe('aider');
  });
  it('genericPtyAdapter.id === "generic-pty"', () => {
    expect(genericPtyAdapter.id).toBe('generic-pty');
  });

  it('typed adapter export class type — claude-code 暴露专属方法', () => {
    // typed export 让 caller 直接 import 拿 typed instance,自动暴露 adapter-专属方法。
    // 用 typeof 验证类型而不是 runtime check（TS 编译期窄化 ClaudeCodeAdapter type）。
    expect(typeof claudeCodeAdapter.respondPermission).toBe('function');
    expect(typeof claudeCodeAdapter.restartWithClaudeCodeSandbox).toBe('function');
    expect(typeof claudeCodeAdapter.restartWithPermissionMode).toBe('function');
  });

  it('typed adapter export class type — codex-cli 暴露专属方法', () => {
    expect(typeof codexCliAdapter.restartWithCodexSandbox).toBe('function');
    expect(typeof codexCliAdapter.setCodexCliPath).toBe('function');
  });
});
