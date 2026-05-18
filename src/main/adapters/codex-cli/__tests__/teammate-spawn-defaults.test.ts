/**
 * plan codex-handoff-team-alignment-20260518 §P3 Step 3.9 测试矩阵 TC8-10 —
 * options-builder.narrowToCodexOpts agentName-based unsafe default spread 验证（plan §不变量 6 + §D7）。
 *
 * 覆盖：
 * - TC8: agentName='reviewer-codex' → 4 项 unsafe default spread + envOverrideExtra **不**含
 *   AGENT_DECK_CLAUDE_PATH（不是 reviewer-claude wrapper 路径）
 * - TC9: agentName='reviewer-claude' → 4 项 unsafe default spread + envOverrideExtra.AGENT_DECK_CLAUDE_PATH
 *   有值（mock resolveBundledClaudeBinary 返非 null）
 * - TC10: agentName=undefined（普通 codex session 用户起的 lead）→ **不** spread unsafe default
 *   （不变量 6：普通 session 不被污染）
 *
 * 4 项 unsafe default：
 *   - codexSandbox: 'workspace-write'
 *   - approvalPolicy: 'never'
 *   - networkAccessEnabled: true
 *   - additionalDirectories: ['<home>/.claude', '<home>/.codex']
 *
 * 测试策略：直接调 buildCreateSessionOptions('codex-cli', raw) 单测 narrowToCodexOpts 行为
 * （不过 spawn handler 链路，最直接验证 v4 D7 信号源 + 不变量 6 enforce 点 = options-builder 层）。
 * mock resolveBundledClaudeBinary 让 TC9 envOverride.AGENT_DECK_CLAUDE_PATH 可断言;
 * TC11 边角(返 null 不注入 env)单独覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const FAKE_CLAUDE_BIN = '/fake/path/to/claude';

vi.mock('@main/adapters/claude-code/resolve-bundled-claude', () => ({
  resolveBundledClaudeBinary: vi.fn(() => FAKE_CLAUDE_BIN),
}));

import { resolveBundledClaudeBinary } from '@main/adapters/claude-code/resolve-bundled-claude';
import { buildCreateSessionOptions } from '@main/adapters/options-builder';

beforeEach(() => {
  vi.mocked(resolveBundledClaudeBinary).mockReturnValue(FAKE_CLAUDE_BIN);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('options-builder narrowToCodexOpts agentName-based default spread (plan §P3 Step 3.9 TC8-10)', () => {
  it('TC8: agentName="reviewer-codex" → 4 项 unsafe default spread + envOverrideExtra 不含 AGENT_DECK_CLAUDE_PATH', () => {
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
    expect(opts.additionalDirectories).toEqual([
      path.join(os.homedir(), '.claude'),
      path.join(os.homedir(), '.codex'),
    ]);

    // reviewer-codex **不**走 wrapper Bash 路径 → envOverrideExtra 不被注入 AGENT_DECK_CLAUDE_PATH
    expect(opts.envOverrideExtra).toBeUndefined();

    // resolveBundledClaudeBinary 没被调用（仅 reviewer-claude 路径调）
    expect(resolveBundledClaudeBinary).not.toHaveBeenCalled();
  });

  it('TC9: agentName="reviewer-claude" → 4 项 unsafe default spread + envOverrideExtra.AGENT_DECK_CLAUDE_PATH 有值', () => {
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'review task',
      agentName: 'reviewer-claude',
    });

    expect(opts.agentId).toBe('codex-cli');

    // 4 项 unsafe default 强制 spread（与 TC8 同款）
    expect(opts.codexSandbox).toBe('workspace-write');
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.networkAccessEnabled).toBe(true);
    expect(opts.additionalDirectories).toEqual([
      path.join(os.homedir(), '.claude'),
      path.join(os.homedir(), '.codex'),
    ]);

    // reviewer-claude wrapper 路径额外注入 AGENT_DECK_CLAUDE_PATH env var（v4 M7）
    expect(opts.envOverrideExtra).toBeDefined();
    expect(opts.envOverrideExtra?.AGENT_DECK_CLAUDE_PATH).toBe(FAKE_CLAUDE_BIN);

    // resolveBundledClaudeBinary 被调一次
    expect(resolveBundledClaudeBinary).toHaveBeenCalledTimes(1);
  });

  it('TC10: agentName=undefined (普通 codex session lead) → 不 spread unsafe default (不变量 6 enforce — 普通 session 不被污染)', () => {
    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'lead chat',
      // agentName 缺省 → 走普通 codex session 分支
    });

    expect(opts.agentId).toBe('codex-cli');

    // **关键 negative**：4 字段任一被 spread 都是 bug（污染普通 codex session）
    expect(opts.codexSandbox).toBeUndefined();
    expect(opts.approvalPolicy).toBeUndefined();
    expect(opts.networkAccessEnabled).toBeUndefined();
    expect(opts.additionalDirectories).toBeUndefined();
    expect(opts.envOverrideExtra).toBeUndefined();

    // caller 显式传 codexSandbox 仍透传（caller 路径不被 default 覆盖）
    const optsWithCallerSandbox = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'lead chat',
      codexSandbox: 'read-only',
    });
    expect(optsWithCallerSandbox.codexSandbox).toBe('read-only');
    expect(optsWithCallerSandbox.approvalPolicy).toBeUndefined();
    // 其他 3 default 字段仍不 spread（caller 没明确要 reviewer 行为）
    expect(optsWithCallerSandbox.networkAccessEnabled).toBeUndefined();
    expect(optsWithCallerSandbox.additionalDirectories).toBeUndefined();

    // resolveBundledClaudeBinary 没被调用
    expect(resolveBundledClaudeBinary).not.toHaveBeenCalled();
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
    expect(resolveBundledClaudeBinary).not.toHaveBeenCalled();
  });

  it('TC11: agentName="reviewer-claude" + resolveBundledClaudeBinary 返 null → envOverrideExtra 不注入 AGENT_DECK_CLAUDE_PATH (options-builder 不静默替换路径)', () => {
    vi.mocked(resolveBundledClaudeBinary).mockReturnValue(null);

    const opts = buildCreateSessionOptions('codex-cli', {
      cwd: '/repo',
      prompt: 'review task',
      agentName: 'reviewer-claude',
    });

    // 4 字段 default 仍 spread
    expect(opts.codexSandbox).toBe('workspace-write');
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.networkAccessEnabled).toBe(true);
    expect(opts.additionalDirectories).toBeDefined();

    // **关键 negative**：resolveBundledClaudeBinary 返 null → envOverrideExtra 不设
    // （wrapper Bash 模板回退到 PATH 找 `claude`,脚本作者职责处理 fallback;
    //  options-builder 不静默替换;详 options-builder.ts:134-139 注释）
    expect(opts.envOverrideExtra).toBeUndefined();
    expect(resolveBundledClaudeBinary).toHaveBeenCalledTimes(1);
  });

  it('TC11b: claude-code adapter narrow 不消费 agentName 字段 (filter 掉 — narrowToClaudeOpts 不 spread codex default)', () => {
    const opts = buildCreateSessionOptions('claude-code', {
      cwd: '/repo',
      prompt: 'review task',
      agentName: 'reviewer-claude', // claude adapter 不消费此字段
    });

    expect(opts.agentId).toBe('claude-code');

    // claude adapter opts 不含 codex 专属字段 — TS 类型层 ClaudeCreateOpts 字面没这些字段，
    // narrow 后 runtime 也不 spread（避免污染）
    expect('codexSandbox' in opts).toBe(false);
    expect('approvalPolicy' in opts).toBe(false);
    expect('networkAccessEnabled' in opts).toBe(false);
    expect('additionalDirectories' in opts).toBe(false);
    expect('envOverrideExtra' in opts).toBe(false);

    // resolveBundledClaudeBinary 没被调（claude adapter narrow 不进 codex default 分支）
    expect(resolveBundledClaudeBinary).not.toHaveBeenCalled();
  });
});
