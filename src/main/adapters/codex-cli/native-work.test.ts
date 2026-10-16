import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexNativeWork } from './native-work';
import type { CodexAppServerClient } from './app-server/client';
import type { InternalSession } from './sdk-bridge/types';
const instances: CodexNativeWork[] = [];
afterEach(() => { for (const work of instances) work.dispose(); instances.length = 0; });
function fixture() {
  let turn = { id: 'turn-1', status: 'inProgress' };
  let terminals: unknown[] = [];
  const client = { generation: 1, isProcessAlive: true, subscribe: vi.fn(() => vi.fn()),
    requestLive: vi.fn(async (method: string) => {
      if (method === 'thread/turns/list') return { data: [turn] };
      if (method === 'thread/items/list') return { data: [], nextCursor: null };
      if (method === 'thread/backgroundTerminals/list') return { data: terminals, nextCursor: null };
      if (method === 'thread/backgroundTerminals/terminate') return { terminated: true };
      return {};
    }) };
  const emit = vi.fn();
  const internal = { applicationSid: 'parent', threadId: 'native-parent', intentionallyClosed: false } as InternalSession;
  const work = new CodexNativeWork(internal, client as unknown as CodexAppServerClient, emit);
  instances.push(work);
  const spawn = () => work.notification({ method: 'item/completed', params: { threadId: 'native-parent', item: {
    type: 'collabAgentToolCall', id: 'spawn', senderThreadId: 'native-parent', tool: 'spawnAgent',
    receiverThreadIds: ['child'], status: 'completed', agentsStates: { child: { status: 'running' } } } } });
  return { work, client, emit, spawn, setTurn: (value: typeof turn) => { turn = value; },
    setTerminals: (value: unknown[]) => { terminals = value; } };
}
describe('Codex native work observer', () => {
  it('keeps child command output paired and records its observed completion', async () => {
    const { work, spawn, emit } = fixture(); spawn(); await work.refresh();
    work.notification({ method: 'item/completed', params: { threadId: 'child', turnId: 'turn-1', item: {
      id: 'command', type: 'commandExecution', command: 'pwd', status: 'completed', exitCode: 0, aggregatedOutput: '/workspace' } } });
    work.notification({ method: 'item/completed', params: { threadId: 'child', turnId: 'turn-1', item: {
      id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'Inspect the project' }] } } });
    const records = emit.mock.calls.map(([event]) => event).filter(event => event.kind === 'native-work-detail').map(event => event.payload);
    const command = records.find(record => record.kind === 'tool-use-start');
    const output = records.find(record => record.kind === 'output');
    expect(output).toMatchObject({ toolUseId: command.toolUseId, toolName: 'Bash', toolStatus: 'completed', exitCode: 0 });
    expect(records.some(record => record.role === 'user' && record.text === 'Inspect the project')).toBe(true);
  });
  it('separates launch/parent completion and does not accept unrelated wait targets', async () => {
    const { work, spawn, emit } = fixture(); spawn();
    expect(work.list()[0].status).toBe('running');
    work.notification({ method: 'turn/completed', params: { threadId: 'native-parent', turn: { id: 'parent-turn', status: 'completed' } } });
    await work.refresh();
    expect(work.list()[0]).toMatchObject({ runId: 'turn-1', status: 'running' });
    work.notification({ method: 'item/completed', params: { threadId: 'unrelated', item: { id: 'tool', type: 'agentMessage', text: 'secret' } } });
    expect(emit.mock.calls.some(([event]) => JSON.stringify(event).includes('secret'))).toBe(false);
    work.notification({ method: 'item/completed', params: { threadId: 'child', turnId: 'turn-1', item: { id: 'tool', type: 'agentMessage', text: 'child result' } } });
    work.notification({ method: 'item/agentMessage/delta', params: { threadId: 'child', turnId: 'turn-1', itemId: 'live-message', delta: 'live child text' } });
    expect(emit.mock.calls.some(([event]) => event.kind === 'native-work-detail')).toBe(true);
    expect(emit.mock.calls.some(([event]) => event.kind === 'native-work-detail' && event.payload.text === 'live child text')).toBe(true);
  });
  it('validates current child turn and runtime without starting a provider process', async () => {
    const { work, spawn, client, setTurn } = fixture(); spawn(); await work.refresh();
    const ref = work.list()[0].native;
    setTurn({ id: 'turn-2', status: 'inProgress' });
    expect(await work.stop(ref)).toEqual({ status: 'stale' });
    expect(client.requestLive.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(false);
    await work.refresh();
    expect(await work.stop(work.list()[0].native)).toEqual({ status: 'accepted' });
    expect(client.requestLive).toHaveBeenCalledWith('turn/interrupt', { threadId: 'child', turnId: 'turn-2' }, 1);
    client.generation = 2;
    expect(await work.stop(ref)).toEqual({ status: 'stale' });
    client.isProcessAlive = false;
    expect(await work.stop(ref)).toEqual({ status: 'stale' });
  });
  it('lists only proven background terminals and rejects process-ID reuse', async () => {
    const { work, client, setTerminals } = fixture();
    work.notification({ method: 'item/completed', params: { threadId: 'native-parent', item: {
      id: 'shell', type: 'commandExecution', command: 'echo hello', processId: 'process', status: 'completed', aggregatedOutput: 'hello' } } });
    expect(work.list()).toEqual([]);
    setTerminals([{ itemId: 'shell', processId: 'process', command: 'echo hello' }]);
    await work.refresh();
    const ref = work.list()[0].native;
    expect(work.list()[0].status).toBe('running');
    setTerminals([{ itemId: 'new-shell', processId: 'process', command: 'other' }]);
    expect(await work.stop(ref)).toEqual({ status: 'stale' });
    expect(client.requestLive.mock.calls.some(([method]) => method.endsWith('/terminate'))).toBe(false);
    setTerminals([{ itemId: 'shell', processId: 'process', command: 'echo hello' }]);
    expect(await work.stop(ref)).toEqual({ status: 'accepted' });
    expect(work.list()[0].status).toBe('stopped');
  });
});
