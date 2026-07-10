import { describe, expect, it } from 'vitest';
import { selectCodexForkBoundary } from './source-boundary';
import {
  buildForkedFirstTurnInput,
  buildForkInstructionReset,
} from './instruction-reset';

describe('Codex native-fork boundary', () => {
  it('replays only current UserInput content and selects the preceding terminal turn', () => {
    const result = selectCodexForkBoundary({
      thread: {
        id: 'source',
        turns: [
          { id: 'terminal', status: 'completed', items: [{ type: 'agentMessage', text: 'old' }] },
          {
            id: 'active',
            status: 'inProgress',
            items: [
              {
                type: 'userMessage',
                content: [
                  { type: 'text', text: 'current', text_elements: [] },
                  { type: 'skill', name: 'review', path: 'skill://review' },
                ],
              },
              { type: 'reasoning', content: ['secret'] },
              { type: 'agentMessage', text: 'unfinished' },
              { type: 'mcpToolCall', tool: 'spawn_session' },
            ],
          },
        ],
      },
    });

    expect(result.lastTerminalTurnId).toBe('terminal');
    expect(result.currentUserInputs).toEqual([
      { type: 'text', text: 'current', text_elements: [] },
      { type: 'skill', name: 'review', path: 'skill://review' },
    ]);
  });

  it('marks a first-turn source as an explicit zero-prefix boundary', () => {
    const result = selectCodexForkBoundary({
      thread: {
        id: 'source',
        turns: [{
          id: 'active',
          status: 'inProgress',
          items: [{
            type: 'userMessage',
            content: [{ type: 'text', text: 'first', text_elements: [] }],
          }],
        }],
      },
    });
    expect(result.lastTerminalTurnId).toBeNull();
    expect(result.currentUserInputs).toHaveLength(1);
  });

  it('rejects a source without an in-progress turn or replayable user inputs', () => {
    expect(() => selectCodexForkBoundary({
      thread: {
        id: 'source',
        turns: [{ id: 'done', status: 'completed', items: [] }],
      },
    })).toThrow(/in-progress turn/);
    expect(() => selectCodexForkBoundary({
      thread: {
        id: 'source',
        turns: [{ id: 'active', status: 'inProgress', items: [{ type: 'reasoning' }] }],
      },
    })).toThrow(/no replayable UserInput/);
  });
});

describe('Codex fork instruction reset', () => {
  it('supersedes inherited instructions and appends the complete target instructions', () => {
    const item = buildForkInstructionReset('Target baseline\n\nTarget custom agent');
    expect(item).toMatchObject({ type: 'message', role: 'developer' });
    const text = JSON.stringify(item);
    expect(text).toContain('historical context only');
    expect(text).toContain('superseded for this child');
    expect(text).toContain('Target baseline');
    expect(text).toContain('Target custom agent');
  });

  it('uses an explicit empty-target reset and a clear delegation boundary', () => {
    expect(JSON.stringify(buildForkInstructionReset(undefined))).toContain(
      'no effective target developer instructions',
    );
    const firstInput = buildForkedFirstTurnInput(
      [{ type: 'text', text: 'source request', text_elements: [] }],
      'delegated prompt',
    );
    expect(firstInput.map((item) => item.type)).toEqual(['text', 'text', 'text']);
    expect(firstInput[1]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('child delegation boundary'),
    });
    expect(firstInput[2]).toMatchObject({ type: 'text', text: 'delegated prompt' });
  });
});
