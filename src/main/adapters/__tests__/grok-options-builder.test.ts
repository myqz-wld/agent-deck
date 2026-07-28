import { describe, expect, it } from 'vitest';

import { buildCreateSessionOptions } from '../options-builder';

describe('Grok create-session option narrowing', () => {
  it('passes its native sandbox profile without leaking foreign controls', () => {
    const options = buildCreateSessionOptions('grok-build', {
      cwd: '/repo',
      grokSandbox: 'project-locked',
      codexSandbox: 'read-only',
      claudeCodeSandbox: 'strict',
      extraAllowWrite: ['/outside'],
    });

    expect(options).toMatchObject({
      agentId: 'grok-build',
      cwd: '/repo',
      grokSandbox: 'project-locked',
    });
    expect(options).not.toHaveProperty('codexSandbox');
    expect(options).not.toHaveProperty('claudeCodeSandbox');
    expect(options).not.toHaveProperty('extraAllowWrite');
  });

  it('preserves explicit null so a resumed target can delegate to Grok native config', () => {
    expect(buildCreateSessionOptions('grok-build', {
      cwd: '/repo',
      grokSandbox: null,
    })).toHaveProperty('grokSandbox', null);
  });
});
