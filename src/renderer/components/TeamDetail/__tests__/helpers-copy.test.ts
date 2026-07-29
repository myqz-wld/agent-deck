import { describe, expect, it } from 'vitest';

import { agentIdLabel } from '../helpers';

describe('agentIdLabel user-facing copy', () => {
  it.each([
    ['claude-code', 'Claude Code'],
    ['codex-cli', 'Codex CLI'],
    ['grok-build', 'Grok Build'],
  ])('maps %s to %s', (agentId, expected) => {
    expect(agentIdLabel(agentId)).toBe(expected);
  });

  it('preserves unknown adapter ids and the missing-id fallback', () => {
    expect(agentIdLabel('custom-adapter')).toBe('custom-adapter');
    expect(agentIdLabel(null)).toBe('未知');
  });
});
