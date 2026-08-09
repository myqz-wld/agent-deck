import { describe, expect, it } from 'vitest';

import {
  parseSessionConsoleCapabilitiesParams,
  parseSessionConsoleCapabilitiesResult,
  parseSessionConsoleCreateOptions,
} from './session-console-capabilities';
import {
  sessionConsoleCapabilitiesFixture,
  sessionConsoleCreateOptionsFixture,
} from './session-console-capabilities.fixture';

describe('session-console capability contract', () => {
  it.each(['claude-code', 'codex-cli', 'grok-build'] as const)(
    'round-trips one exact %s descriptor through structured clone',
    (adapterId) => {
      const request = { adapterId, provider: '', workingDirectory: 'repo/subdir' };
      const cloned = structuredClone(sessionConsoleCapabilitiesFixture(
        adapterId,
        request.workingDirectory,
      ));
      expect(parseSessionConsoleCapabilitiesResult(cloned, request)).toEqual(cloned);
      expect(JSON.stringify(cloned)).not.toMatch(/\/Users\/|\/home\/|workspaceRoot|privateRoot/);
    },
  );

  it('binds the descriptor to adapter, provider and Workspace-relative directory', () => {
    const descriptor = sessionConsoleCapabilitiesFixture('codex-cli', 'repo');
    expect(() => parseSessionConsoleCapabilitiesResult(descriptor, {
      adapterId: 'claude-code',
      provider: '',
      workingDirectory: 'repo',
    })).toThrow('requestBinding');
    expect(() => parseSessionConsoleCapabilitiesResult(descriptor, {
      adapterId: 'codex-cli',
      provider: 'other',
      workingDirectory: 'repo',
    })).toThrow('requestBinding');
    expect(() => parseSessionConsoleCapabilitiesResult(descriptor, {
      adapterId: 'codex-cli',
      provider: '',
      workingDirectory: 'other',
    })).toThrow('requestBinding');
  });

  it('rejects absolute, escaping, incomplete, and widened capability requests', () => {
    expect(parseSessionConsoleCapabilitiesParams({
      adapterId: null,
      provider: '',
      workingDirectory: '.',
    })).toEqual({ adapterId: null, provider: '', workingDirectory: '.' });
    for (const workingDirectory of ['/tmp/repo', '../repo', 'repo/../other', 'repo\\child']) {
      expect(() => parseSessionConsoleCapabilitiesParams({
        adapterId: null,
        provider: '',
        workingDirectory,
      })).toThrow('workingDirectory');
    }
    expect(() => parseSessionConsoleCapabilitiesParams({
      adapterId: null,
      provider: '',
      workingDirectory: '.',
      topology: 'relay',
    })).toThrow('capabilities.params');
  });

  it('requires the complete create option set and rejects unknown or malformed values', () => {
    const valid = sessionConsoleCreateOptionsFixture();
    expect(parseSessionConsoleCreateOptions(valid)).toEqual(valid);
    const { thinking: _thinking, ...missing } = valid;
    expect(() => parseSessionConsoleCreateOptions(missing)).toThrow('create.options');
    expect(() => parseSessionConsoleCreateOptions({ ...valid, cwd: '/escape' }))
      .toThrow('create.options');
    expect(() => parseSessionConsoleCreateOptions({ ...valid, model: 'bad\u0000model' }))
      .toThrow('options.model');
  });

  it('rejects inconsistent adapter summaries and sandbox schemas', () => {
    const summaryMismatch = structuredClone(sessionConsoleCapabilitiesFixture());
    summaryMismatch.create.displayName = 'Different';
    expect(() => parseSessionConsoleCapabilitiesResult(summaryMismatch))
      .toThrow('selectedAdapterId');

    const sandboxMismatch = structuredClone(sessionConsoleCapabilitiesFixture());
    sandboxMismatch.create.sandbox.choices[0]!.value = 'danger-full-access';
    expect(() => parseSessionConsoleCapabilitiesResult(sandboxMismatch))
      .toThrow('create.sandbox');

    const emptyReason = structuredClone(sessionConsoleCapabilitiesFixture());
    emptyReason.create.attachments.disabledReason = '';
    expect(() => parseSessionConsoleCapabilitiesResult(emptyReason))
      .toThrow('disabledReason');
  });

  it('admits a fully disabled sandbox only when the selected adapter is unavailable', () => {
    const disabled = structuredClone(sessionConsoleCapabilitiesFixture());
    const reason = '安全边界尚未满足。';
    disabled.adapters[1] = { ...disabled.adapters[1]!, enabled: false, disabledReason: reason };
    disabled.create.enabled = false;
    disabled.create.disabledReason = reason;
    disabled.create.options.codexSandbox = {
      allowedValues: [], allowCustom: false, allowEmpty: false,
      defaultValue: null, disabledReason: reason, enabled: false,
    };
    disabled.create.sandbox.choices = disabled.create.sandbox.choices.map((choice) => ({
      ...choice, disabledReason: reason, enabled: false,
    }));
    expect(parseSessionConsoleCapabilitiesResult(disabled)).toEqual(disabled);

    disabled.adapters[1] = { ...disabled.adapters[1]!, enabled: true, disabledReason: null };
    disabled.create.enabled = true;
    disabled.create.disabledReason = null;
    expect(() => parseSessionConsoleCapabilitiesResult(disabled))
      .toThrow('create.sandbox');
  });

  it('rejects malformed revisions, duplicate catalogs, and extra response fields', () => {
    const malformed = structuredClone(sessionConsoleCapabilitiesFixture()) as
      ReturnType<typeof sessionConsoleCapabilitiesFixture> & { leakedPath?: string };
    malformed.capabilityRevision = 'revision-1';
    expect(() => parseSessionConsoleCapabilitiesResult(malformed)).toThrow('capabilityRevision');

    const duplicate = structuredClone(sessionConsoleCapabilitiesFixture());
    duplicate.adapters.push({ ...duplicate.adapters[0]! });
    expect(() => parseSessionConsoleCapabilitiesResult(duplicate)).toThrow('adapters');

    const widened = structuredClone(sessionConsoleCapabilitiesFixture()) as
      ReturnType<typeof sessionConsoleCapabilitiesFixture> & { leakedPath?: string };
    widened.leakedPath = '/private/provider-home';
    expect(() => parseSessionConsoleCapabilitiesResult(widened)).toThrow('capabilities.result');
  });
});
