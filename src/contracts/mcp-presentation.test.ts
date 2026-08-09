import { describe, expect, it } from 'vitest';

import {
  MCP_DIFF_PRESENTATION_SCHEMA,
  MCP_PLAN_PRESENTATION_SCHEMA,
  parseMcpPresentationDisplay,
  parseMcpPresentationFeedback,
} from './mcp-presentation';

describe('MCP presentation display contract', () => {
  it('parses bounded plan and both diff presentation modes', () => {
    expect(parseMcpPresentationDisplay({
      schema: MCP_PLAN_PRESENTATION_SCHEMA,
      title: 'Plan',
      plan: '# Steps',
    })).toMatchObject({ plan: '# Steps' });
    expect(parseMcpPresentationDisplay({
      schema: MCP_DIFF_PRESENTATION_SCHEMA,
      mode: 'pr',
      rationale: 'Review this change',
      filePath: 'src/example.ts',
      pr: { before: 'old', after: 'new' },
      annotations: [{ pane: 'after', line: 1, body: 'New behavior' }],
    })).toMatchObject({ mode: 'pr', filePath: 'src/example.ts' });
    expect(parseMcpPresentationDisplay({
      schema: MCP_DIFF_PRESENTATION_SCHEMA,
      mode: 'merge-conflict',
      rationale: 'Resolve this conflict',
      conflict: { base: 'base', ours: 'ours', theirs: 'theirs', resolution: 'done' },
      annotations: [{ pane: 'base', body: 'Common ancestor' }],
    })).toMatchObject({ mode: 'merge-conflict' });
  });

  it('rejects extra fields, mismatched panes, and host paths', () => {
    expect(() => parseMcpPresentationDisplay({
      schema: MCP_PLAN_PRESENTATION_SCHEMA,
      plan: 'plan',
      secret: true,
    })).toThrow(/invalid/);
    expect(() => parseMcpPresentationDisplay({
      schema: MCP_DIFF_PRESENTATION_SCHEMA,
      mode: 'pr',
      rationale: 'reason',
      filePath: '/Users/operator/repository/file.ts',
      pr: { before: '', after: '' },
    })).toThrow(/filePath/);
    expect(() => parseMcpPresentationDisplay({
      schema: MCP_DIFF_PRESENTATION_SCHEMA,
      mode: 'pr',
      rationale: 'reason',
      pr: { before: '', after: '' },
      annotations: [{ pane: 'ours', body: 'wrong mode' }],
    })).toThrow(/annotations/);
  });

  it('accepts only an exact optional revision-feedback object', () => {
    expect(parseMcpPresentationFeedback(undefined)).toBeUndefined();
    expect(parseMcpPresentationFeedback({ feedback: '  revise this  ' })).toBe('revise this');
    expect(parseMcpPresentationFeedback({})).toBeUndefined();
    expect(() => parseMcpPresentationFeedback({ feedback: 'x', extra: true })).toThrow(/invalid/);
  });
});
