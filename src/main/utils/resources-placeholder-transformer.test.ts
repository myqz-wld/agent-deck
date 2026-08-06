import { describe, expect, it } from 'vitest';
import {
  RESOURCES_PLACEHOLDER,
  findUnknownResourcesPlaceholders,
  substituteResourcesPlaceholderWithRoot,
} from './resources-placeholder-transformer';

describe('resource placeholder transformer', () => {
  it('replaces every canonical placeholder with the caller-owned resource root', () => {
    expect(
      substituteResourcesPlaceholderWithRoot(
        `${RESOURCES_PLACEHOLDER}/bin:${RESOURCES_PLACEHOLDER}/skills`,
        '/opt/agent-deck/resources',
      ),
    ).toBe('/opt/agent-deck/resources/bin:/opt/agent-deck/resources/skills');
  });

  it('returns text without the canonical placeholder unchanged', () => {
    const text = 'no packaged resource reference';
    expect(substituteResourcesPlaceholderWithRoot(text, '/unused')).toBe(text);
  });

  it('reports unique unknown placeholders in first-seen order', () => {
    expect(
      findUnknownResourcesPlaceholders(
        [
          '{{AGENT_DECK_RES}}',
          RESOURCES_PLACEHOLDER,
          '{{AGENT_DECK_RESOURCE}}',
          '{{AGENT_DECK_RES}}',
        ].join(' '),
      ),
    ).toEqual(['{{AGENT_DECK_RES}}', '{{AGENT_DECK_RESOURCE}}']);
  });

  it('keeps strict bracket matching for whitespace and mixed-case lookalikes', () => {
    expect(
      findUnknownResourcesPlaceholders(
        '{{ AGENT_DECK_RES }} {{Agent_Deck_RES}} {{AGENT_DECK_RES}}',
      ),
    ).toEqual(['{{AGENT_DECK_RES}}']);
  });
});
