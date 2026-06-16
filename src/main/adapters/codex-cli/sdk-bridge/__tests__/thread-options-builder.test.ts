/**
 * buildCodexThreadOptions 纯函数单测（REVIEW_79 MED 测试缺口修法 — 双方独立 INFO/MED：
 * reviewer-codex INFO「helper 缺直接单测」+ reviewer-claude MED「thread-options-builder.ts 零 test」）。
 *
 * 覆盖 thread-options-builder.ts `buildCodexThreadOptions` 的字段收口逻辑：
 * - approvalPolicy `?? 'never'` fallback（caller 缺省 → 'never'；caller 显式 → 透传）
 * - skipGitRepoCheck 恒 true
 * - model / modelReasoningEffort / developerInstructions / configOverrides / networkAccessEnabled /
 *   additionalDirectories 条件 spread（undefined → 字段不出现）
 * - modelReasoningSummary 默认 auto，让应用内 Codex 会话请求可展示的思路摘要
 * - additionalDirectories 浅拷贝（防 caller 后续 mutate 入参影响 SDK 内部）
 *
 * 纯函数零 mock：直接 import + 断言 return object。
 */
import { describe, expect, it } from 'vitest';
import { buildCodexThreadOptions } from '@main/adapters/codex-cli/sdk-bridge/thread-options-builder';

describe('buildCodexThreadOptions', () => {
  it('approvalPolicy 缺省 → fallback "never"；workingDirectory / sandboxMode / skipGitRepoCheck 必出现', () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
    });
    expect(opts.workingDirectory).toBe('/repo/x');
    expect(opts.sandboxMode).toBe('workspace-write');
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.skipGitRepoCheck).toBe(true);
  });

  it('approvalPolicy 显式传 "on-request" → 透传不被 fallback 覆盖', () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
    });
    expect(opts.approvalPolicy).toBe('on-request');
  });

  it('model / modelReasoningEffort / developerInstructions / configOverrides / networkAccessEnabled / additionalDirectories 全缺省 → 仅 summary 默认出现', () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
    });
    // 条件 spread 语义:undefined optional 字段不应作为 key 存在(让 SDK 走自身默认)
    expect('model' in opts).toBe(false);
    expect('modelReasoningEffort' in opts).toBe(false);
    expect('developerInstructions' in opts).toBe(false);
    expect('configOverrides' in opts).toBe(false);
    expect('networkAccessEnabled' in opts).toBe(false);
    expect('additionalDirectories' in opts).toBe(false);
    expect(opts.modelReasoningSummary).toBe('auto');
  });

  it('model / modelReasoningEffort / developerInstructions / configOverrides / networkAccessEnabled / additionalDirectories 显式传 → 全部出现在 return object', () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      model: 'gpt-5.5-codex',
      modelReasoningEffort: 'xhigh',
      modelReasoningSummary: 'none',
      developerInstructions: '  Use Agent Deck baseline.  ',
      configOverrides: {
        skills: {
          config: [{ name: 'agent-deck:deep-review' }],
        },
      },
      networkAccessEnabled: true,
      additionalDirectories: ['/a', '/b'],
    });
    expect(opts.model).toBe('gpt-5.5-codex');
    expect(opts.modelReasoningEffort).toBe('xhigh');
    expect(opts.modelReasoningSummary).toBe('none');
    expect(opts.developerInstructions).toBe('Use Agent Deck baseline.');
    expect(opts.configOverrides).toEqual({
      skills: {
        config: [{ name: 'agent-deck:deep-review' }],
      },
    });
    expect(opts.networkAccessEnabled).toBe(true);
    expect(opts.additionalDirectories).toEqual(['/a', '/b']);
  });

  it('model=codex-default 是统计占位 → 不传给 Codex SDK', () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      model: 'codex-default',
    });
    expect('model' in opts).toBe(false);
  });

  it('model 首尾空白会 trim；空白 model 不传给 Codex SDK', () => {
    const trimmed = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      model: '  gpt-5.5-codex  ',
    });
    expect(trimmed.model).toBe('gpt-5.5-codex');

    const blank = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      model: '   ',
    });
    expect('model' in blank).toBe(false);
  });

  it('networkAccessEnabled=false 是合法显式值 → 字段出现且为 false（不被 spread 条件误判为缺省）', () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      networkAccessEnabled: false,
    });
    // 条件用 `!== undefined`,false 是合法显式值必须 spread
    expect('networkAccessEnabled' in opts).toBe(true);
    expect(opts.networkAccessEnabled).toBe(false);
  });

  it('additionalDirectories 浅拷贝 → caller 后续 mutate 入参数组不影响已返回的 ThreadOptions', () => {
    const input = ['/a', '/b'];
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      additionalDirectories: input,
    });
    // caller mutate 原数组
    input.push('/c');
    // 已返回的 ThreadOptions 不受影响(浅拷贝 [...arr] 防御)
    expect(opts.additionalDirectories).toEqual(['/a', '/b']);
    expect(opts.additionalDirectories).not.toBe(input);
  });
});
