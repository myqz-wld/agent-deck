import { describe, expect, it } from 'vitest';
import { firstUnsupportedTargetRuntimeField } from '@main/adapters/runtime-control-contracts';
import {
  parseSessionHandOffPrepareRequest,
  parseSessionHandOffTarget,
} from '../session-hand-off-input';

describe('session hand-off IPC target parsing', () => {
  it('preserves omitted adapter-owned fields instead of manufacturing explicit nulls', () => {
    const codex = parseSessionHandOffTarget({
      adapter: 'codex-cli',
      provider: null,
      model: 'gpt-5.6-sol',
      thinking: 'max',
    });
    expect(codex).not.toHaveProperty('sessionMode');
    expect(firstUnsupportedTargetRuntimeField('codex-cli', codex)).toBeNull();

    const grok = parseSessionHandOffTarget({
      adapter: 'grok-build',
      model: null,
      thinking: null,
      sessionMode: 'default',
    });
    expect(grok).not.toHaveProperty('provider');
    expect(firstUnsupportedTargetRuntimeField('grok-build', grok)).toBeNull();

    const inherited = parseSessionHandOffTarget({ adapter: 'codex-cli' });
    expect(inherited).toEqual({ adapter: 'codex-cli' });
  });

  it('retains an explicitly supplied null so strict ownership validation still applies', () => {
    const codex = parseSessionHandOffTarget({
      adapter: 'codex-cli',
      model: null,
      thinking: null,
      sessionMode: null,
    });
    expect(codex).toHaveProperty('sessionMode', null);
    expect(firstUnsupportedTargetRuntimeField('codex-cli', codex)).toBe('sessionMode');
  });

  it.each([
    'windowTokens',
    'contextWindowTokens',
    'contextWindowSource',
    'runtimeKey',
    'usedLowerBudgetRetry',
  ])('rejects forged trusted target field %s', (field) => {
    expect(() => parseSessionHandOffTarget({
      adapter: 'codex-cli',
      [field]: field === 'usedLowerBudgetRetry' ? true : 'forged',
    })).toThrow(`request.target.${field}`);
  });

  it('rejects forged trusted fields at the outer prepare boundary', () => {
    expect(() => parseSessionHandOffPrepareRequest({
      sourceSessionId: 'source',
      continuationInstruction: 'continue',
      target: { adapter: 'codex-cli' },
      contextCapacity: { status: 'observed', windowTokens: 1_000_000 },
    })).toThrow('request.contextCapacity');
  });
});
