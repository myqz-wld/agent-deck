import { describe, expect, it } from 'vitest';
import { parseCodexAgentToml } from '@shared/codex-agent-toml';
import reviewerCodex from '../../../../resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml?raw';
import codexSimpleReview from '../../../../resources/codex-config/agent-deck-plugin/skills/simple-review/SKILL.md?raw';
import codexDeepReview from '../../../../resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md?raw';
import claudeSimpleReview from '../../../../resources/claude-config/agent-deck-plugin/skills/simple-review/SKILL.md?raw';
import claudeDeepReview from '../../../../resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md?raw';

describe('bundled reviewer runtime contract', () => {
  it('resolves reviewer-codex to gpt-5.6-sol with xhigh reasoning', () => {
    const parsed = parseCodexAgentToml(reviewerCodex);

    expect(parsed.name).toBe('reviewer-codex');
    expect(parsed.model).toBe('gpt-5.6-sol');
    expect(parsed.modelReasoningEffort).toBe('xhigh');
  });

  it('keeps paired review skills aligned on the named Codex reviewer slot', () => {
    expect(codexSimpleReview).toBe(claudeSimpleReview);
    expect(codexDeepReview).toBe(claudeDeepReview);
    expect(codexSimpleReview).toContain("agentName: 'reviewer-codex'");
    expect(codexDeepReview).toContain('agentName: "reviewer-codex"');
  });
});
