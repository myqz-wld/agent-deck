/**
 * Codex option narrowing must be independent of `agentName`. The public builder provides the
 * ordinary `never` target default, preserves explicit approval/sandbox values, and never
 * injects reviewer network or path access. Same-adapter inheritance is resolved by spawn/handoff
 * before this boundary.
 */
import { describe, expect, it } from 'vitest';

import { buildCreateSessionOptions } from '@main/adapters/options-builder';

describe('options-builder Codex runtime defaults', () => {
  it('does not infer runtime access from a historical reviewer agentName field', () => {
    const raw = {
      cwd: '/repo',
      prompt: 'review task',
      agentName: 'reviewer-codex',
    } as Parameters<typeof buildCreateSessionOptions>[1];
    const opts = buildCreateSessionOptions('codex-cli', raw);

    expect(opts.agentId).toBe('codex-cli');
    expect(opts.codexSandbox).toBeUndefined();
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.networkAccessEnabled).toBeUndefined();
    expect(opts.additionalDirectories).toBeUndefined();
    expect('agentName' in opts).toBe(false);
  });

  it('preserves explicit approval and sandbox values without adding reviewer access', () => {
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'review task',
      approvalPolicy: 'never',
      codexSandbox: 'danger-full-access',
    });

    expect(opts.codexSandbox).toBe('danger-full-access');
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.networkAccessEnabled).toBeUndefined();
    expect(opts.additionalDirectories).toBeUndefined();
  });

  it('defaults ordinary Codex targets to never without hidden access', () => {
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'lead chat',
    });

    expect(opts.codexSandbox).toBeUndefined();
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.networkAccessEnabled).toBeUndefined();
    expect(opts.additionalDirectories).toBeUndefined();

    const optsWithCallerSandbox = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'lead chat',
      codexSandbox: 'read-only',
    });
    expect(optsWithCallerSandbox.codexSandbox).toBe('read-only');
    expect(optsWithCallerSandbox.approvalPolicy).toBe('never');
    expect(optsWithCallerSandbox.networkAccessEnabled).toBeUndefined();
    expect(optsWithCallerSandbox.additionalDirectories).toBeUndefined();
  });

  it('filters Codex approval fields from a Claude target', () => {
    const opts = buildCreateSessionOptions('claude-code', {
      cwd: '/repo',
      prompt: 'review task',
      approvalPolicy: 'never',
    });

    expect('codexSandbox' in opts).toBe(false);
    expect('approvalPolicy' in opts).toBe(false);
    expect('networkAccessEnabled' in opts).toBe(false);
    expect('additionalDirectories' in opts).toBe(false);
  });
});

/**
 * **REVIEW_105 MED-1 (deep-review Batch 7 双 reviewer + lead 三重独立命中) 回归矩阵**:
 *
 * field 级 narrow 完整性 —— 修前 narrowToClaudeOpts / narrowToCodexOpts 双双漏挑 resumeCliSid /
 * resumeMode(facade type 误声明的死字段 + Raw jsdoc「都消费」契约矛盾)。修法: 从 facade
 * ClaudeCreateOpts / CodexCreateOpts / CreateSessionOptionsRaw 删这两字段(归位 bridge 内部
 * CreateSessionOpts), 并加 field 级 TS 守门(_assertClaudePassthroughCoversArm /
 * _assertCodexPassthroughCoversArm)。本矩阵是运行时配套: 验证每个 caller-passthrough 字段确实
 * 被 narrow 透传, 且 internal 字段(若 caller 误塞 raw)不出现在 narrow 输出。
 */
describe('options-builder field-level narrow coverage (REVIEW_105 MED-1 回归)', () => {
  // REVIEW_105 R2 INFO-1 (reviewer-codex): handOff 在 _CLAUDE/CODEX_PASSTHROUGH_KEYS 清单内,
  // 但 R1 矩阵漏构造 handOff fixture → 若 narrow 删 `out.handOff = raw.handOff` 赋值, typecheck +
  // 测试都不挂(运行时盲区)。最小 HandOffMetadata fixture cast 补断言。
  const HANDOFF_FIXTURE = {
    mode: 'session',
    fromCallerSid: 'caller-sid',
  } as Parameters<typeof buildCreateSessionOptions>[1]['handOff'];

  it('claude arm: 全 caller-passthrough 字段透传 + codex-only 字段 filter', () => {
    const opts = buildCreateSessionOptions('claude-code', {
      cwd: '/repo',
      prompt: 'p',
      permissionMode: 'acceptEdits',
      resume: 'app-sid',
      teamName: 'team-x',
      attachments: [],
      model: 'opus',
      claudeCodeEffortLevel: 'max',
      claudeCodeSandbox: 'workspace-write',
      extraAllowWrite: ['/main-repo'],
      handOff: HANDOFF_FIXTURE,
      // codex-only 字段(应被 filter)
      codexSandbox: 'read-only',
      approvalPolicy: 'never',
    });
    // 全 claude-passthrough 字段透传
    expect(opts.cwd).toBe('/repo');
    expect(opts.prompt).toBe('p');
    expect(opts.permissionMode).toBe('acceptEdits');
    expect(opts.resume).toBe('app-sid');
    expect(opts.teamName).toBe('team-x');
    expect(opts.attachments).toEqual([]);
    expect(opts.model).toBe('opus');
    expect(opts.claudeCodeEffortLevel).toBe('max');
    expect(opts.claudeCodeSandbox).toBe('workspace-write');
    expect(opts.extraAllowWrite).toEqual(['/main-repo']);
    expect(opts.handOff).toBe(HANDOFF_FIXTURE); // INFO-1: 防 narrow 漏 handOff 赋值
    // codex-only 字段被 filter
    expect('codexSandbox' in opts).toBe(false);
    expect('approvalPolicy' in opts).toBe(false);
  });

  it('codex arm: 全 caller-passthrough 字段透传 + claude-only 字段 filter', () => {
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'p',
      resume: 'app-sid',
      teamName: 'team-x',
      attachments: [],
      model: 'gpt-5',
      modelReasoningEffort: 'xhigh',
      codexSandbox: 'read-only',
      approvalPolicy: 'untrusted',
      extraAllowWrite: ['/main-repo'],
      handOff: HANDOFF_FIXTURE,
      // claude-only 字段(应被 filter)
      permissionMode: 'plan',
      claudeCodeSandbox: 'strict',
    });
    expect(opts.cwd).toBe('/repo');
    expect(opts.prompt).toBe('p');
    expect(opts.resume).toBe('app-sid');
    expect(opts.teamName).toBe('team-x');
    expect(opts.attachments).toEqual([]);
    expect(opts.model).toBe('gpt-5');
    expect(opts.modelReasoningEffort).toBe('xhigh');
    // 普通 codex session(非 reviewer-*) caller 显式 codexSandbox 透传不被覆盖
    expect(opts.codexSandbox).toBe('read-only');
    expect(opts.approvalPolicy).toBe('untrusted');
    expect(opts.extraAllowWrite).toEqual(['/main-repo']);
    expect(opts.handOff).toBe(HANDOFF_FIXTURE); // INFO-1: 防 narrow 漏 handOff 赋值
    // claude-only 字段被 filter
    expect('permissionMode' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
  });

  it('MED-1 核心回归: resumeCliSid / resumeMode 已从 facade type 删除 → 即便 caller 误塞(类型层已拦)运行时 narrow 也不输出', () => {
    // 类型层: Raw 已删 resumeCliSid / resumeMode, 下面 cast 模拟「历史 caller 误塞」绕过 TS
    // (真实 caller 已无法传 —— 编译期报错), 验证 runtime narrow 不会把 internal 字段漏到 facade 输出。
    const rawWithInternal = {
      cwd: '/repo',
      prompt: 'p',
      resume: 'app-sid',
      resumeCliSid: 'cli-sid-leak',
      resumeMode: 'fresh-cli-reuse-app',
    } as Parameters<typeof buildCreateSessionOptions>[1];

    const claudeOpts = buildCreateSessionOptions('claude-code', rawWithInternal);
    expect('resumeCliSid' in claudeOpts).toBe(false);
    expect('resumeMode' in claudeOpts).toBe(false);

    const codexOpts = buildCreateSessionOptions('codex-cli', rawWithInternal);
    expect('resumeCliSid' in codexOpts).toBe(false);
    expect('resumeMode' in codexOpts).toBe(false);
  });
});
