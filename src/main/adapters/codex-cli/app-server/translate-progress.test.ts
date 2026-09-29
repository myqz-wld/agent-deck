import { describe, expect, it, vi } from 'vitest';
import { translateCodexAppServerNotification } from './translate';
import { nextActivityState } from '@main/session/manager-helpers';
describe('Codex plan and tool progress', () => {
  it('keeps provider plan identity and exact step states', () => {
    const emit = vi.fn();
    translateCodexAppServerNotification({ method: 'turn/plan/updated', params: {
      threadId: 'thread', turnId: 'turn', explanation: 'Investigating',
      plan: [{ step: 'Inspect', status: 'inProgress' }],
    } }, emit);
    expect(emit).toHaveBeenCalledWith('thinking', expect.objectContaining({ plan: true,
      planId: 'codex:thread:turn', explanation: 'Investigating', entries: [{ content: 'Inspect', status: 'inProgress' }] }));
  });
  it('updates MCP progress without replacing the original tool name or parameters', () => {
    const emit = vi.fn();
    translateCodexAppServerNotification({ method: 'item/mcpToolCall/progress', params: { itemId: 'call', message: 'Processing' } }, emit);
    expect(emit).toHaveBeenCalledWith('tool-use-start', { toolUseId: 'call', progressMessage: 'Processing', status: 'inProgress' });
  });
  it('shows config warnings without marking an idle/waiting session as working', () => {
    const emit = vi.fn();
    translateCodexAppServerNotification({ method: 'configWarning', params: { summary: 'Unknown option', details: 'Check configuration' } }, emit);
    const [kind, payload] = emit.mock.calls[0];
    expect(payload.text).toContain('Check configuration');
    expect(nextActivityState('idle', kind, payload)).toBe('idle');
    expect(nextActivityState('waiting', kind, payload)).toBe('waiting');
  });
});
