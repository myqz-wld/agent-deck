import { describe, expect, it } from 'vitest';
import { beginGrokTurn, createGrokTranslationState, translateGrokUpdate } from './translate';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

describe('Grok content fidelity', () => {
  it('retains tool image content alongside raw output and on progress updates', () => {
    const state = createGrokTranslationState();
    const emit = (update: SessionUpdate) => translateGrokUpdate('session', '/repo', update, state);
    const image = { type: 'image' as const, data: 'image-data', mimeType: 'image/png' };
    const content = [{ type: 'content' as const, content: image }];
    const first = emit({ sessionUpdate: 'tool_call', toolCallId: 'image', title: 'generate_image', content });
    expect(first[0].payload).toMatchObject({ imageInputs: [image] });
    const complete = emit({ sessionUpdate: 'tool_call_update', toolCallId: 'image', status: 'completed', rawOutput: { ok: true }, content });
    expect(complete[0].payload).toMatchObject({ toolResult: { ok: true }, imageInputs: [image] });
  });
  it('retains plan status and priority and scopes updates to the current turn', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'session', 'model', 'turn-1');
    const entries = [{ content: 'Inspect', priority: 'high' as const, status: 'in_progress' as const }];
    const emit = (update: SessionUpdate) => translateGrokUpdate('session', '/repo', update, state);
    const first = emit({ sessionUpdate: 'plan', entries })[0];
    const second = emit({ sessionUpdate: 'plan', entries })[0];
    expect(first.payload).toMatchObject({ plan: true, entries });
    expect((first.payload as { planId: string }).planId).toBe((second.payload as { planId: string }).planId);
    beginGrokTurn(state, 'session', 'model', 'turn-2');
    expect((emit({ sessionUpdate: 'plan', entries })[0].payload as { planId: string }).planId)
      .not.toBe((first.payload as { planId: string }).planId);
  });
  it('keeps independent named ACP plans distinct and removes only the specified plan', () => {
    const state = createGrokTranslationState();
    const entries = [{ content: 'Inspect', priority: 'high' as const, status: 'in_progress' as const }];
    const first = translateGrokUpdate('s', '/repo', { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'one', entries } }, state)[0];
    const second = translateGrokUpdate('s', '/repo', { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'two', entries } }, state)[0];
    const removed = translateGrokUpdate('s', '/repo', { sessionUpdate: 'plan_removed', planId: 'one' }, state)[0];
    expect((first.payload as { planId: string }).planId).not.toBe((second.payload as { planId: string }).planId);
    expect(removed.payload).toMatchObject({ planId: (first.payload as { planId: string }).planId, text: '计划已移除' });
  });
  it('keeps late parameters and progress after the initial tool call', () => {
    const state = createGrokTranslationState();
    const emit = (update: SessionUpdate) => translateGrokUpdate('session', '/repo', update, state);
    emit({ sessionUpdate: 'tool_call', toolCallId: 'call', title: 'read_file', kind: 'read', status: 'pending' });
    const updates = emit({ sessionUpdate: 'tool_call_update', toolCallId: 'call', rawInput: { path: 'src/a.ts' }, status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'reading' } }] });
    expect(updates[0].payload).toMatchObject({ toolName: 'read_file', toolInput: { path: 'src/a.ts' }, aggregatedOutput: 'reading' });
    const complete = emit({ sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed', rawInput: { path: 'src/a.ts', limit: 10 } });
    expect(complete[0].payload).toMatchObject({ toolInput: { path: 'src/a.ts', limit: 10 } });
  });
});
