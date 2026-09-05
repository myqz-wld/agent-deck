import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '@main/utils/frontmatter';
import { parseCodexAgentToml } from '@shared/codex-agent-toml';
import reviewerClaude from '../../../../resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md?raw';
import reviewerCodex from '../../../../resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml?raw';
import reviewerGrok from '../../../../resources/grok-config/agent-deck-plugin/agents/reviewer-grok.md?raw';
import claudeRuntime from '../../../../resources/claude-config/CLAUDE.md?raw';
import codexRuntime from '../../../../resources/codex-config/CODEX_AGENTS.md?raw';
import grokRuntime from '../../../../resources/grok-config/GROK_AGENTS.md?raw';
import claudeSimpleReview from '../../../../resources/claude-config/agent-deck-plugin/skills/simple-review/SKILL.md?raw';
import claudeDeepReview from '../../../../resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md?raw';
import codexSimpleReview from '../../../../resources/codex-config/agent-deck-plugin/skills/simple-review/SKILL.md?raw';
import codexDeepReview from '../../../../resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md?raw';
import grokSimpleReview from '../../../../resources/grok-config/agent-deck-plugin/skills/simple-review/SKILL.md?raw';
import grokDeepReview from '../../../../resources/grok-config/agent-deck-plugin/skills/deep-review/SKILL.md?raw';
import claudeHello from '../../../../resources/claude-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md?raw';
import codexHello from '../../../../resources/codex-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md?raw';
import grokHello from '../../../../resources/grok-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md?raw';

const codexReviewerBody = parseCodexAgentToml(reviewerCodex).developerInstructions ?? '';
const reviewerBodies = [reviewerClaude, codexReviewerBody, reviewerGrok];
const allReviewSkills = [
  claudeSimpleReview,
  claudeDeepReview,
  codexSimpleReview,
  codexDeepReview,
  grokSimpleReview,
  grokDeepReview,
];

function expectHeadingsInOrder(source: string, headings: string[]): void {
  let previous = -1;
  for (const heading of headings) {
    const current = source.indexOf(`## ${heading}`);
    expect(current, `missing or reordered heading: ${heading}`).toBeGreaterThan(previous);
    previous = current;
  }
}

describe('bundled reviewer runtime contract', () => {
  it('keeps valid metadata and intentional reviewer runtimes', () => {
    for (const [skill, expectedName] of [
      [claudeSimpleReview, 'simple-review'],
      [claudeDeepReview, 'deep-review'],
      [codexSimpleReview, 'simple-review'],
      [codexDeepReview, 'deep-review'],
      [grokSimpleReview, 'simple-review'],
      [grokDeepReview, 'deep-review'],
    ] as const) {
      const frontmatter = parseFrontmatter(skill);
      expect(frontmatter.name).toBe(expectedName);
      expect(frontmatter.description).toBeTruthy();
    }

    const claude = parseFrontmatter(reviewerClaude);
    expect(claude).toMatchObject({ name: 'reviewer-claude', model: 'opus', effort: 'xhigh' });
    expect(String(claude.tools)).toContain('Read');

    const codex = parseCodexAgentToml(reviewerCodex);
    expect(codex.name).toBe('reviewer-codex');
    expect(codex.model).toBe('gpt-6-astra');
    expect(codex.modelReasoningEffort).toBe('xhigh');

    const grok = parseFrontmatter(reviewerGrok);
    expect(grok).toMatchObject({ name: 'reviewer-grok', model: 'grok-4.6', effort: 'high' });
    expect(String(grok.tools)).toContain('Bash');
  });

  it('keeps each skill identical across adapters and structurally aligned', () => {
    expect(claudeSimpleReview).toBe(codexSimpleReview);
    expect(claudeSimpleReview).toBe(grokSimpleReview);
    expect(claudeDeepReview).toBe(codexDeepReview);
    expect(claudeDeepReview).toBe(grokDeepReview);

    for (const skill of [claudeSimpleReview, claudeDeepReview]) {
      expectHeadingsInOrder(skill, ['Role', 'Setup', 'Evidence', 'Lifecycle', 'Failure', 'Report']);
      expect(skill).toContain('coordinator and adjudicator, not a third artifact reviewer');
      expect(skill).toContain('Reviewer agents own independent artifact inspection');
    }
  });

  it('keeps the paired batching, isolation, and recovery protocol in both skills', () => {
    for (const skill of allReviewSkills) {
      expect(skill).toContain('exactly two user-confirmed, distinct reviewer types');
      expect(skill).toContain("adapter: 'claude-code', agentName: 'reviewer-claude'");
      expect(skill).toContain("adapter: 'codex-cli', agentName: 'reviewer-codex'");
      expect(skill).toContain("adapter: 'grok-build', agentName: 'reviewer-grok'");
      expect(skill).toContain('same complete scope and focus');
      expect(skill).toContain('integration batch');
      expect(skill).toContain('spawnLimits');
      expect(skill).toContain("displayName: '<reviewer> · <batch_id>'");
      expect(skill).toContain('.review-cache/');
      expect(skill).toContain('/tmp/agent-deck-review/<invocation_id>/<batch_id>/<reviewer>/');
      expect(skill).toContain('return control instead of polling');
      expect(skill).toContain('⚠ FRESH SESSION');
      expect(skill).toContain('⚠ SCOPE PATH MISMATCH');
      expect(skill).toContain('retry the same batch, adapter, provider/runtime selector');
      expect(skill).toContain('Never substitute an unselected reviewer');
      expect(skill).not.toContain('.deep-review-cache');
    }
  });

  it('keeps simple review bounded and deep review severity-driven', () => {
    expect(claudeSimpleReview).toContain('exactly one independent review pass');
    expect(claudeSimpleReview).toContain('at most one material-finding rebuttal pass');
    expect(claudeSimpleReview).toContain('Do not start a fix-and-re-review loop');
    expect(claudeSimpleReview).toContain('LOW/INFO never enter rebuttal');
    expect(claudeSimpleReview).toContain('Final decision: USER_DECISION_REQUIRED');

    expect(claudeDeepReview).toContain('Use severity-driven depth');
    expect(claudeDeepReview).toContain('| Evidence follow-up |');
    expect(claudeDeepReview).toContain('| Post-fix |');
    expect(claudeDeepReview).toContain('A clean initial pass needs no ceremonial second pass');
    expect(claudeDeepReview).toContain('After the last material boundary-affecting fix');
    expect(claudeDeepReview).toContain('ESCALATED_TO_USER');
  });

  it('keeps severity depth rules consistent with opportunistic LOW and INFO fixes', () => {
    for (const skill of [claudeSimpleReview, claudeDeepReview]) {
      expect(skill).toMatch(/MEDIUM[\s\S]{0,300}(impact|materiality)[\s\S]{0,300}(likelihood|normal-scenario)/);
      expect(skill).toContain('LOW/INFO may be fixed opportunistically');
      expect(skill).toMatch(/LOW\/INFO[\s\S]{0,400}never[\s\S]{0,200}(rebuttal|new pass|reviewer round)/);
      expect(skill).toContain('focused lead-side validation');
    }
  });

  it('keeps reviewer roles and section order aligned across adapters', () => {
    for (const reviewer of reviewerBodies) {
      expectHeadingsInOrder(reviewer, [
        'Role',
        'Input',
        'Review Standard',
        'Validation',
        'Output',
        'Delivery',
      ]);
      expect(reviewer).toContain('You are a review worker, not a fix worker');
      expect(reviewer).toContain('The lead skill owns scope normalization');
      expect(reviewer).toContain('You own artifact inspection');
      expect(reviewer).toContain('Do not choose `simple-review` versus `deep-review`');
    }
  });

  it('admits only reproducible normal-path findings and preserves the requested plan/code lenses', () => {
    for (const reviewer of reviewerBodies) {
      expect(reviewer).toContain('supported, normal scenario');
      expect(reviewer).toContain('unsupported versions or configuration');
      expect(reviewer).toContain('Do not search for a severity quota');
      expect(reviewer).toContain('cohesive responsibility and state ownership');
      expect(reviewer).toContain('loose directional coupling');
      expect(reviewer).toContain('overdesign');
      expect(reviewer).toContain('future extensibility');
      expect(reviewer).toContain('over-defensive programming');
      expect(reviewer).toContain('dead, unreachable, unused, duplicated, or no-effect code');
      expect(reviewer).toContain('compatibility or fallback code');
      expect(reviewer).toContain('For MEDIUM, state impact and likelihood');
      expect(reviewer).toMatch(/LOW\/INFO[\s\S]{0,250}must not broaden scope/);
    }
  });

  it('keeps reviewer input, validation, output, and delivery safety complete', () => {
    for (const reviewer of reviewerBodies) {
      for (const token of [
        'invocation_id',
        'batch_id',
        'batch_kind: primary | integration',
        'batch_scope',
        'finding_id_prefix',
        'baseline: commit:<hash> | working-tree',
        'Coverage: COMPLETE | INCOMPLETE',
        'Decision impact: routine | major',
      ]) {
        expect(reviewer).toContain(token);
      }
      expect(reviewer).toContain('git diff --cached -- <paths>');
      expect(reviewer).toContain('git status --short');
      expect(reviewer).toContain('/tmp/agent-deck-review/<invocation_id>/<batch_id>/');
      expect(reviewer).toContain('Focused tests, builds, package validation scripts, and isolated spikes are allowed');
      expect(reviewer).toContain('Batch: <batch_id> (<primary | integration>)');
      expect(reviewer).toContain('Generate stable ids as `<finding_id_prefix>-001`');
      expect(reviewer).toContain('Use CRITICAL for stable catastrophic');
      expect(reviewer).toContain('Use network access only for public documentation');
      expect(reviewer).toContain('Never transmit scoped source, diffs, logs, secrets, tokens, local paths, customer data');
      expect(reviewer).toContain('⚠ FRESH SESSION');
      expect(reviewer).toContain('⚠ SCOPE PATH MISMATCH');
      expect(reviewer).toContain('⚠ NO MSG ANCHOR');
      expect(reviewer).toContain('exactly one verdict per supplied id');
    }
  });

  it('preserves adapter-specific execution and delivery wording', () => {
    expect(reviewerClaude).toContain('Claude Code-side artifact inspection');
    expect(reviewerClaude).toContain('independent Claude Code SDK session');
    expect(reviewerClaude).toContain('/reviewer-claude/');
    expect(reviewerClaude).toContain('mcp__agent-deck__send_message');

    expect(codexReviewerBody).toContain('Use `shell` to validate issues');
    expect(codexReviewerBody).toContain('independent Codex CLI app-server session');
    expect(codexReviewerBody).toContain('approvalPolicy: never');
    expect(codexReviewerBody).toContain('configured Codex sandbox default');
    expect(codexReviewerBody).toContain('/reviewer-codex/');

    expect(reviewerGrok).toContain('independent Grok Build artifact reviewer');
    expect(reviewerGrok).toContain('/reviewer-grok/');
    expect(reviewerGrok).toContain('send_message({ sessionId, teamId, text, replyToMessageId })');
  });

  it('keeps the runtime batch-worker and delegation baseline aligned', () => {
    const batchedScope =
      'For a batched review, each batch gets one worker session of each selected type over the same complete batch scope';

    for (const runtime of [claudeRuntime, codexRuntime, grokRuntime]) {
      expect(runtime).toContain(batchedScope);
      expect(runtime).toContain('one bounded, independently executable subtask');
      expect(runtime).toContain('exact scope and non-overlapping write set');
      expect(runtime).toContain('A null `spawnPromptMessageId` is not a reply anchor');
      expect(runtime).toContain('`spawn_session` non-idempotently starts one parallel target');
      expect(runtime).toContain('Omitted `contextMode` is `fresh`');
      expect(runtime).toContain('count the surviving worker as complete batch coverage');
    }
  });

  it('keeps hello-from-deck adapter wording specific and its response fixed', () => {
    for (const hello of [claudeHello, codexHello, grokHello]) {
      expect(hello).toContain('Agent Deck bundled skill is ready: hello-from-deck');
      expect(hello).toContain('current session cwd');
      expect(hello).toContain('ISO timestamp');
    }
    expect(claudeHello).toContain('In Claude Code, use Bash `pwd` + `date`');
    expect(codexHello).toContain('In Codex CLI, use shell `pwd` + `date`');
    expect(grokHello).toContain("Grok Build's non-mutating shell tools");
  });
});
