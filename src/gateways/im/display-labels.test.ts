import { describe, expect, it } from 'vitest';
import { feishuCallbackToast } from './display-labels';
import { renderRuntime } from './render';
import { preferenceLabel } from './preferences';
import { defaultFeishuModelPreference } from '@contracts/index';

describe('Chinese Feishu presentation', () => {
  it('labels native controls while preserving executable syntax and redacting private values', () => {
    const view = renderRuntime({ adapterId: 'codex-cli', revision: 7, values: {
      permissionMode: 'auto', codexSandbox: 'workspace-write', model: 'model-synthetic',
      apiKey: 'synthetic-private-value', custom: 'Bearer abcdefghijklmnopqrstuvwxyz',
    } }, 8_000);
    expect(view.text).toContain('权限模式：自动审批');
    expect(view.text).toContain('沙盒：工作区写入');
    expect(view.text).toContain('模型：model-synthetic');
    expect(view.text).toContain('/runtime-set 7 <JSON-patch>');
    expect(view.text).not.toMatch(/synthetic-private-value|abcdefghijklmnopqrstuvwxyz/);
    expect(preferenceLabel({ ...defaultFeishuModelPreference(), adapterId: 'grok-build',
      permissionMode: 'auto', grokSandbox: 'workspace' })).toContain('自动审批 · 沙盒 工作区写入');
  });

  it('never exposes an unknown raw provider error code in the callback toast', () => {
    expect(feishuCallbackToast('unknown-internal-error', false)).toBe('暂时无法完成这次操作，请稍后重试。');
    expect(feishuCallbackToast('invalid_nonce', false)).toContain('审批卡校验未通过');
  });
});
