/**
 * plan codex-handoff-team-alignment-20260518 §P3 Step 3.9 测试矩阵 —
 * options-builder.narrowToCodexOpts agentName-based unsafe default spread 验证
 * (plan §不变量 6 + §D7).
 *
 * **plan reviewer-codex-cross-adapter-20260519 Phase 2 Step 2.4 修订**:
 * cross-adapter native 改造后,reviewer-claude 不再走 wrapper 路径(claude SDK 子 + Bash
 * 起外部 codex CLI),改 cross-adapter native (claude-code adapter 直起 claude SDK)。
 * 删除 reviewer-claude wrapper 专用 envOverrideExtra: AGENT_DECK_CLAUDE_PATH 注入分支
 * + 对应测试 case (TC9 / TC11)。reviewer-claude / reviewer-codex 两个 reviewer-* 仍
 * 共享 4 项 unsafe default spread (codexSandbox / approvalPolicy /
 * networkAccessEnabled / additionalDirectories) — 这部分行为 unchanged。
 *
 * 覆盖:
 * - TC8: agentName='reviewer-codex' → 4 项 unsafe default spread
 * - TC10: agentName=undefined (普通 codex session 用户起的 lead) → **不** spread unsafe
 *   default (不变量 6: 普通 session 不被污染)
 * - TC10b: agentName='reviewer-typescript' (非 reviewer-* 两值) → 同款不 spread
 * - TC11b: claude-code adapter narrow 不消费 agentName 字段 (filter 掉 —
 *   narrowToClaudeOpts 不 spread codex default)
 *
 * 4 项 unsafe default:
 *   - codexSandbox: 'workspace-write'
 *   - approvalPolicy: 'never'
 *   - networkAccessEnabled: true
 *   - additionalDirectories: ['<home>/.claude', '<home>/.codex', '/tmp']
 *
 * 测试策略: 直接调 buildCreateSessionOptions('codex-cli', raw) 单测 narrowToCodexOpts
 * 行为(不过 spawn handler 链路,最直接验证 v4 D7 信号源 + 不变量 6 enforce 点 =
 * options-builder 层)。
 */
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { buildCreateSessionOptions } from '@main/adapters/options-builder';

describe('options-builder narrowToCodexOpts agentName-based default spread (plan §P3 Step 3.9)', () => {
  it('TC8: agentName="reviewer-codex" → 4 项 unsafe default spread', () => {
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'review task',
      agentName: 'reviewer-codex',
    });

    // narrow 后 agentId 字段已塞
    expect(opts.agentId).toBe('codex-cli');

    // 4 项 unsafe default 强制 spread
    expect(opts.codexSandbox).toBe('workspace-write');
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.networkAccessEnabled).toBe(true);
    // additionalDirectories 含 /tmp(spike4 实证 reviewer 必需,reviewer-claude /
    // reviewer-codex 两 reviewer-* 同款 spread 保持对偶不分叉)
    expect(opts.additionalDirectories).toEqual([
      path.join(os.homedir(), '.claude'),
      path.join(os.homedir(), '.codex'),
      '/tmp',
    ]);

    // envOverrideExtra 不被注入(reviewer-claude wrapper 路径已删,reviewer-codex 本来
    // 也不走 wrapper Bash 路径 — 字段保留 generic 透传机制供未来 caller 重用)
    expect(opts.envOverrideExtra).toBeUndefined();
  });

  it('TC9: agentName="reviewer-claude" → 4 项 unsafe default spread (cross-adapter native, 不再注入 envOverrideExtra)', () => {
    // **plan reviewer-codex-cross-adapter-20260519 Phase 2 Step 2.4 修订**:
    // 旧 wrapper 路径 (claude-code adapter wrapper Bash 起外部 codex CLI) 删除,
    // reviewer-claude 改 cross-adapter native (claude-code adapter 直起 claude SDK)。
    // 但 codex-cli adapter 仍可能 spawn reviewer-claude(理论上 cross-adapter 反向场景
    // 无,因 lead 起 reviewer-claude 总用 adapter:'claude-code') — 留此 case 验证
    // codex-cli adapter narrow 时 reviewer-claude / reviewer-codex 两值都触发 4 项 default。
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'review task',
      agentName: 'reviewer-claude',
    });

    expect(opts.agentId).toBe('codex-cli');

    // 4 项 unsafe default 强制 spread (与 TC8 同款)
    expect(opts.codexSandbox).toBe('workspace-write');
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.networkAccessEnabled).toBe(true);
    expect(opts.additionalDirectories).toEqual([
      path.join(os.homedir(), '.claude'),
      path.join(os.homedir(), '.codex'),
      '/tmp',
    ]);

    // envOverrideExtra 不再被注入 AGENT_DECK_CLAUDE_PATH (wrapper 删除)
    expect(opts.envOverrideExtra).toBeUndefined();
  });

  it('TC10: agentName=undefined (普通 codex session lead) → 不 spread unsafe default (不变量 6 enforce — 普通 session 不被污染)', () => {
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'lead chat',
      // agentName 缺省 → 走普通 codex session 分支
    });

    expect(opts.agentId).toBe('codex-cli');

    // **关键 negative**: 4 字段任一被 spread 都是 bug(污染普通 codex session)
    expect(opts.codexSandbox).toBeUndefined();
    expect(opts.approvalPolicy).toBeUndefined();
    expect(opts.networkAccessEnabled).toBeUndefined();
    expect(opts.additionalDirectories).toBeUndefined();
    expect(opts.envOverrideExtra).toBeUndefined();

    // caller 显式传 codexSandbox 仍透传(caller 路径不被 default 覆盖)
    const optsWithCallerSandbox = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'lead chat',
      codexSandbox: 'read-only',
    });
    expect(optsWithCallerSandbox.codexSandbox).toBe('read-only');
    expect(optsWithCallerSandbox.approvalPolicy).toBeUndefined();
    // 其他 3 default 字段仍不 spread(caller 没明确要 reviewer 行为)
    expect(optsWithCallerSandbox.networkAccessEnabled).toBeUndefined();
    expect(optsWithCallerSandbox.additionalDirectories).toBeUndefined();
  });

  it('TC10b: agentName="some-other-name" 非 reviewer-* → 同款不 spread (信号源仅认 reviewer-claude / reviewer-codex 两值)', () => {
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'custom agent',
      agentName: 'reviewer-typescript', // 非 reviewer-claude / reviewer-codex
    });

    expect(opts.agentId).toBe('codex-cli');
    expect(opts.codexSandbox).toBeUndefined();
    expect(opts.approvalPolicy).toBeUndefined();
    expect(opts.networkAccessEnabled).toBeUndefined();
    expect(opts.additionalDirectories).toBeUndefined();
    expect(opts.envOverrideExtra).toBeUndefined();
  });

  it('TC11b: claude-code adapter narrow 不消费 agentName 字段 (filter 掉 — narrowToClaudeOpts 不 spread codex default)', () => {
    const opts = buildCreateSessionOptions('claude-code', {
      cwd: '/repo',
      prompt: 'review task',
      agentName: 'reviewer-claude', // claude adapter 不消费此字段
    });

    expect(opts.agentId).toBe('claude-code');

    // claude adapter opts 不含 codex 专属字段 — TS 类型层 ClaudeCreateOpts 字面没这些字段,
    // narrow 后 runtime 也不 spread(避免污染)
    expect('codexSandbox' in opts).toBe(false);
    expect('approvalPolicy' in opts).toBe(false);
    expect('networkAccessEnabled' in opts).toBe(false);
    expect('additionalDirectories' in opts).toBe(false);
    expect('envOverrideExtra' in opts).toBe(false);
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
  it('claude arm: 全 caller-passthrough 字段透传 + codex-only 字段 filter', () => {
    const opts = buildCreateSessionOptions('claude-code', {
      cwd: '/repo',
      prompt: 'p',
      permissionMode: 'acceptEdits',
      resume: 'app-sid',
      teamName: 'team-x',
      attachments: [],
      model: 'opus',
      claudeCodeSandbox: 'workspace-write',
      extraAllowWrite: ['/main-repo'],
      // codex-only 字段(应被 filter)
      codexSandbox: 'read-only',
      agentName: 'reviewer-claude',
    });
    // 全 claude-passthrough 字段透传
    expect(opts.cwd).toBe('/repo');
    expect(opts.prompt).toBe('p');
    expect(opts.permissionMode).toBe('acceptEdits');
    expect(opts.resume).toBe('app-sid');
    expect(opts.teamName).toBe('team-x');
    expect(opts.attachments).toEqual([]);
    expect(opts.model).toBe('opus');
    expect(opts.claudeCodeSandbox).toBe('workspace-write');
    expect(opts.extraAllowWrite).toEqual(['/main-repo']);
    // codex-only 字段被 filter
    expect('codexSandbox' in opts).toBe(false);
    expect('agentName' in opts).toBe(false);
  });

  it('codex arm: 全 caller-passthrough 字段透传 + claude-only 字段 filter', () => {
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'p',
      resume: 'app-sid',
      teamName: 'team-x',
      attachments: [],
      model: 'gpt-5',
      codexSandbox: 'read-only',
      extraAllowWrite: ['/main-repo'],
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
    // 普通 codex session(非 reviewer-*) caller 显式 codexSandbox 透传不被覆盖
    expect(opts.codexSandbox).toBe('read-only');
    expect(opts.extraAllowWrite).toEqual(['/main-repo']);
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
