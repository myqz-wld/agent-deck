import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '@main/utils/frontmatter';
import { parseCodexAgentToml } from '@shared/codex-agent-toml';
import reviewerClaude from '../../../../resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md?raw';
import reviewerDeepseek from '../../../../resources/claude-config/agent-deck-plugin/agents/reviewer-deepseek.md?raw';
import reviewerCodex from '../../../../resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml?raw';
import codexSimpleReview from '../../../../resources/codex-config/agent-deck-plugin/skills/simple-review/SKILL.md?raw';
import codexDeepReview from '../../../../resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md?raw';
import claudeSimpleReview from '../../../../resources/claude-config/agent-deck-plugin/skills/simple-review/SKILL.md?raw';
import claudeDeepReview from '../../../../resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md?raw';

describe('bundled reviewer runtime contract', () => {
  it('keeps valid trigger metadata on every paired review skill', () => {
    for (const [skill, expectedName] of [
      [codexSimpleReview, 'simple-review'],
      [claudeSimpleReview, 'simple-review'],
      [codexDeepReview, 'deep-review'],
      [claudeDeepReview, 'deep-review'],
    ] as const) {
      const frontmatter = parseFrontmatter(skill);
      expect(frontmatter.name).toBe(expectedName);
      expect(frontmatter.description).toBeTruthy();
    }
  });

  it('keeps the intentional model and effort settings for all actual reviewer assets', () => {
    const claude = parseFrontmatter(reviewerClaude);
    const deepseek = parseFrontmatter(reviewerDeepseek);
    const codex = parseCodexAgentToml(reviewerCodex);

    expect(claude.name).toBe('reviewer-claude');
    expect(claude.model).toBe('opus');
    expect(claude.effort).toBe('xhigh');
    expect(String(claude.tools)).toContain('Read');

    expect(deepseek.name).toBe('reviewer-deepseek');
    expect(deepseek.model).toBe('deepseek-v4-pro[1m]');
    expect(deepseek.effort).toBe('max');
    expect(String(deepseek.tools)).toContain('Bash');

    expect(codex.name).toBe('reviewer-codex');
    expect(codex.model).toBe('gpt-5.6-sol');
    expect(codex.modelReasoningEffort).toBe('xhigh');
    expect(codex.developerInstructions).toContain('Use `shell` to validate issues.');
  });

  it('loads every actual reviewer body with the same evidence and safety contract', () => {
    const codexInstructions = parseCodexAgentToml(reviewerCodex).developerInstructions ?? '';

    for (const reviewer of [reviewerClaude, reviewerDeepseek, codexInstructions]) {
      expect(reviewer).toContain('Coverage: COMPLETE | INCOMPLETE');
      expect(reviewer).toContain('finding_id');
      expect(reviewer).toContain('finding_id_prefix');
      expect(reviewer).toContain('one or more challenged findings');
      expect(reviewer).toContain('one **agree / disagree / uncertain** position for every `finding_id`');
      expect(reviewer).toContain('Concrete example:');
      expect(reviewer).toContain('Decision impact: routine | major');
      expect(reviewer).toContain('OUT-OF-FOCUS BLOCKER');
      expect(reviewer).toContain('baseline: commit:<hash> | working-tree');
      expect(reviewer).toContain('git diff <hash> -- <paths>');
      expect(reviewer).toContain('git diff --cached -- <paths>');
      expect(reviewer).toContain('/tmp/agent-deck-review/<invocation_id>/');
      expect(reviewer).toContain('git status --short');
      expect(reviewer).toContain('Use network access only for public documentation.');
      expect(reviewer).not.toContain('/tmp/<basename>');
      expect(reviewer).not.toContain('one finding from the other selected reviewer');
      expect(reviewer).not.toContain('output an empty finding list');
      expect(reviewer).not.toContain('then list findings from other dimensions');
    }
  });

  it('preserves adapter-specific reviewer identity and execution wording', () => {
    expect(reviewerClaude).toContain("adapter:'claude-code'");
    expect(reviewerClaude).toContain('/reviewer-claude/');
    expect(reviewerDeepseek).toContain("adapter:'deepseek-claude-code'");
    expect(reviewerDeepseek).toContain('/reviewer-deepseek/');

    const codexInstructions = parseCodexAgentToml(reviewerCodex).developerInstructions ?? '';
    expect(codexInstructions).toContain("adapter:'codex-cli'");
    expect(codexInstructions).toContain('/reviewer-codex/');
    expect(codexInstructions).toContain('sandboxMode');
  });

  it('keeps paired review skills aligned on the named Codex reviewer slot', () => {
    expect(codexSimpleReview).toBe(claudeSimpleReview);
    expect(codexDeepReview).toBe(claudeDeepReview);
    expect(codexSimpleReview).toContain("agentName: 'reviewer-codex'");
    expect(codexDeepReview).toContain("agentName: 'reviewer-codex'");
  });

  it('uses one shared ignored cache contract without an acknowledgement bypass', () => {
    for (const skill of [codexSimpleReview, codexDeepReview, claudeSimpleReview, claudeDeepReview]) {
      expect(skill).toContain('.review-cache/');
      expect(skill).not.toContain('.deep-review-cache');
      expect(skill).not.toContain('ack_cache_unignored');
      expect(skill).not.toMatch(/```(?:ts|typescript)\s*\n\s*\{/);
    }
  });

  it('keeps prompt, coverage, and batched rebuttal contracts aligned across review skills', () => {
    for (const skill of [codexSimpleReview, codexDeepReview, claudeSimpleReview, claudeDeepReview]) {
      expect(skill).toContain('invocation_id');
      expect(skill).toContain('stable `finding_id`');
      expect(skill).toContain('finding_id_prefix');
      expect(skill).toContain('Coverage: COMPLETE | INCOMPLETE');
      expect(skill).toContain('baseline: commit:<hash> | working-tree');
      expect(skill).toContain('git diff --cached -- <paths>');
      expect(skill).toContain('Decision impact: routine | major');
    }

    expect(codexSimpleReview).toContain('one verdict per id');
    expect(codexSimpleReview).toContain('INCOMPLETE_REVIEW');
    expect(codexDeepReview).toContain('require one verdict per id');
    expect(codexDeepReview).toContain('both reviewers report `Coverage: COMPLETE`');
  });

  it('keeps the simple and deep review lifecycles intentionally distinct', () => {
    expect(codexSimpleReview).toContain('## One-Pass Workflow');
    expect(codexSimpleReview).toContain('Final decision: USER_DECISION_REQUIRED');
    expect(codexSimpleReview).toContain('Do not apply fixes, start a second review round, or silently escalate.');

    expect(codexDeepReview).toContain('## Multi-Round Workflow');
    expect(codexDeepReview).toContain('## User Review Boundary');
    expect(codexDeepReview).toContain('Do not request intermediate user review for routine in-scope remediation.');
  });
});
