import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { eventKey, formatDisplayText, formatToolResult } from './format';

describe('activity-feed format helpers', () => {
  it('formats structured content blocks before React rendering', () => {
    expect(formatDisplayText([{ type: 'text', text: 'hello' }, { type: 'empty' }])).toBe(
      'hello\n{\n  "type": "empty"\n}',
    );
  });

  it('formats bare objects instead of returning them as React children', () => {
    expect(formatDisplayText({ type: 'empty' })).toBe('{\n  "type": "empty"\n}');
  });

  it('uses formatted message text in stable event keys', () => {
    const event = {
      sessionId: 's-1',
      kind: 'message',
      payload: { text: { type: 'empty' } },
      ts: 1,
    } as AgentEvent;

    expect(eventKey(event)).toBe('s-1:message:1:{\n  "type": "empty"\n}');
  });

  it('keeps tool result block formatting intact', () => {
    expect(formatToolResult([{ type: 'text', text: 'tool output' }, { type: 'image' }])).toBe(
      'tool output\n{"type":"image"}',
    );
  });
});
