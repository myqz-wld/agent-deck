/**
 * buildCodexThreadOptions 纯函数单测（REVIEW_79 MED 测试缺口修法 — 双方独立 INFO/MED：
 * reviewer-codex INFO「helper 缺直接单测」+ reviewer-claude MED「thread-options-builder.ts 零 test」）。
 *
 * 覆盖 thread-options-builder.ts `buildCodexThreadOptions` 的字段收口逻辑：
 * - approvalPolicy 缺省时省略（交还 Codex config / provider default）；caller 显式时透传
 * - skipGitRepoCheck 恒 true
 * - modelProvider / model / modelReasoningEffort / developerInstructions / gatewayConfigOverrides /
 *   configOverrides / networkAccessEnabled /
 *   additionalDirectories 条件 spread（undefined → 字段不出现）
 * - modelReasoningSummary 默认 auto，让应用内 Codex 会话请求可展示的思路摘要
 * - additionalDirectories / extraAllowWrite 合并去重并浅拷贝
 *
 * 纯函数零 mock：直接 import + 断言 return object。
 */
import { describe, expect, it } from 'vitest';
import { buildCodexThreadOptions } from '@main/adapters/codex-cli/sdk-bridge/thread-options-builder';

describe('buildCodexThreadOptions', () => {
  it('approvalPolicy 缺省 → 不覆盖 Codex；workingDirectory / sandboxMode / skipGitRepoCheck 必出现', () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
    });
    expect(opts.workingDirectory).toBe('/repo/x');
    expect(opts.sandboxMode).toBe('workspace-write');
    expect('approvalPolicy' in opts).toBe(false);
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

  it('additionalDirectories 与 extraAllowWrite 合并去重并与 caller 数组隔离', () => {
    const additionalDirectories = ['/shared', '/additional'];
    const extraAllowWrite = ['/shared', '/extra'];
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      additionalDirectories,
      extraAllowWrite,
    });

    expect(opts.additionalDirectories).toEqual(['/shared', '/additional', '/extra']);
    additionalDirectories.push('/late-additional');
    extraAllowWrite.push('/late-extra');
    expect(opts.additionalDirectories).toEqual(['/shared', '/additional', '/extra']);
  });

  it('显式空 writable-root 数组仍传空数组，缺省时才省略字段', () => {
    const explicitEmpty = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      extraAllowWrite: [],
    });
    const omitted = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
    });

    expect(explicitEmpty.additionalDirectories).toEqual([]);
    expect('additionalDirectories' in omitted).toBe(false);
  });

  it('model / modelReasoningEffort / developerInstructions / config overrides / networkAccessEnabled / additionalDirectories 全缺省 → 仅 summary 默认出现', () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
    });
    // 条件 spread 语义:undefined optional 字段不应作为 key 存在(让 SDK 走自身默认)
    expect('model' in opts).toBe(false);
    expect('modelReasoningEffort' in opts).toBe(false);
    expect('developerInstructions' in opts).toBe(false);
    expect('configOverrides' in opts).toBe(false);
    expect('gatewayConfigOverrides' in opts).toBe(false);
    expect('networkAccessEnabled' in opts).toBe(false);
    expect('additionalDirectories' in opts).toBe(false);
    expect(opts.modelReasoningSummary).toBe('auto');
  });

  it('model / modelReasoningEffort / developerInstructions / config overrides / networkAccessEnabled / additionalDirectories 显式传 → 全部出现在 return object', () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      modelProvider: '  internal-provider  ',
      model: 'gpt-5.5-codex',
      modelReasoningEffort: 'ultra',
      modelReasoningSummary: 'none',
      developerInstructions: '  Use Agent Deck baseline.  ',
      configOverrides: {
        skills: {
          config: [{ name: 'agent-deck:deep-review' }],
        },
      },
      gatewayConfigOverrides: {
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 900_000,
      },
      networkAccessEnabled: true,
      additionalDirectories: ['/a', '/b'],
    });
    expect(opts.modelProvider).toBe('internal-provider');
    expect(opts.model).toBe('gpt-5.5-codex');
    expect(opts.modelReasoningEffort).toBe('ultra');
    expect(opts.modelReasoningSummary).toBe('none');
    expect(opts.developerInstructions).toBe('Use Agent Deck baseline.');
    expect(opts.configOverrides).toEqual({
      skills: {
        config: [{ name: 'agent-deck:deep-review' }],
      },
    });
    expect(opts.gatewayConfigOverrides).toEqual({
      model_context_window: 1_000_000,
      model_auto_compact_token_limit: 900_000,
    });
    expect(opts.networkAccessEnabled).toBe(true);
    expect(opts.additionalDirectories).toEqual(['/a', '/b']);
  });

  it('preserves custom-agent config without injecting a session model_provider', () => {
    const options = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      configOverrides: { model_provider: 'agent-default' },
    });

    expect(options.configOverrides).toEqual({ model_provider: 'agent-default' });
    expect(options).not.toHaveProperty('modelProvider');
  });

  it('keeps an explicit session model_provider separate from custom config', () => {
    const options = buildCodexThreadOptions({
      workingDirectory: '/repo/x',
      sandboxMode: 'workspace-write',
      modelProvider: 'session-provider',
      configOverrides: { model_provider: 'agent-default' },
    });

    expect(options.modelProvider).toBe('session-provider');
    expect(options.configOverrides).toEqual({ model_provider: 'agent-default' });
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
