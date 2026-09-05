import { describe, it, expect } from 'vitest';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { mapFeishuMessageEvent } from '@gateways/feishu/mapper';
import { parseFeishuCommand } from '@gateways/im/commands';
import { setup, credential, messageEvent, select, onlyClient } from '@gateways/im/__tests__/fixture';
import { serverCoreHistoryEntry } from '@hosts/server-core/runtime-history';
import { projectSessionEvents } from '@hosts/server-core/session-event-projection';
import { parseSessionEventListResult, issueRemoteOwnerGrantClaim } from '@contracts/index';
import { createLocalWorkerDaemonFrameChannels } from '@hosts/local-worker/daemon-frame-channels';
import { LocalWorkerFrameBridge } from '@hosts/local-worker/frame-bridge';
import { CURRENT_PROTOCOL_VERSION, encodeJsonFrame, LengthPrefixedJsonDecoder } from '@protocol/index';
import type { RelayRouteFrame } from '@protocol/relay';

const now = 1_710_000_000_000;
function rawEvent(text: string, group = false) {
  return {
    schema: '2.0',
    header: { app_id: credential.appId, tenant_key: credential.tenantKey, event_id: 'evt_mention', event_type: 'im.message.receive_v1', create_time: String(now * 1000), token: 'fixture_token' },
    event: { sender: { sender_id: { open_id: credential.openId }, sender_type: 'user', tenant_key: credential.tenantKey },
      message: { message_id: 'om_message', create_time: String(now), chat_id: 'chat-1', chat_type: group ? 'group' : 'p2p', message_type: 'text', content: JSON.stringify({ text }), ...(group ? { mentions: [{ key: '@_user_1', id: { open_id: 'bot-1' }, name: 'Agent Deck' }] } : {}) } },
  };
}
async function mapViaSdk(text: string, group = false) {
  const dispatcher = new EventDispatcher({ logger: Object.fromEntries(['error','warn','info','debug','trace'].map(k => [k, () => {}])) as any });
  let mapped: any;
  dispatcher.register({ 'im.message.receive_v1': async data => { mapped = mapFeishuMessageEvent(data, { appId: credential.appId, tenantKey: credential.tenantKey, now: () => now }); } });
  await dispatcher.invoke(rawEvent(text, group), { needCheck: false });
  return mapped;
}

describe('remote scan isolated reproductions (assert existing faulty behavior)', () => {
  it('SDK group bot mention turns /unsubscribe into session.send', async () => {
    const mapped = await mapViaSdk('@_user_1 /unsubscribe', true);
    expect(parseFeishuCommand(mapped.event.text)).toEqual({kind:'send',text:'@_user_1 /unsubscribe'});
    const { gateway, clients } = setup();
    try {
      const fresh = await mapViaSdk('@_user_1 /select session-1', true);
      fresh.event.eventId = 'evt_first_group';
      const initial = await gateway.handle(fresh.event);
      expect(initial.code).toBe('session_not_selected');
      await gateway.handle(messageEvent('select_group', '/select session-1', {chatType:'group'}));
      const result = await gateway.handle(mapped.event);
      expect(result.code).toBe('accepted');
      const calls = onlyClient(clients).calls;
      expect(calls.some(call => call.method === 'session.send' && (call.params as any).text === '@_user_1 /unsubscribe')).toBe(true);
      expect(calls.some(call => call.method === 'subscription.set')).toBe(false);
      console.log('MENTION', JSON.stringify({ command: parseFeishuCommand(mapped.event.text), outcome: result.code, actualMethod: 'session.send' }));
    } finally { await gateway.close(); }
  });
  it('one normal multiline history entry rejects Feishu /history', async () => {
    const { gateway, clients, transport } = setup();
    try {
      await select(gateway);
      const entry = serverCoreHistoryEntry({ id: 10, sessionId: 'session-1', kind: 'message', payload: { role: 'assistant', text: 'First line\nSecond line' }, ts: now } as any);
      onlyClient(clients).histories.set('session-1', [entry as any]);
      transport.messages.length = 0;
      const result = await gateway.handle(messageEvent('evt_history', '/history'));
      expect(result.code).toBe('invalid_core_response');
      expect(transport.messages).toHaveLength(0);
      console.log('HISTORY', JSON.stringify({ text: entry.content, outcome: result.code, replyCount: transport.messages.length }));
    } finally { await gateway.close(); }
    await expect(mapViaSdk('First line\nSecond line')).rejects.toMatchObject({code:'invalid_event'});
  });
  it('default Relay transport resets a valid 1 MiB event-list response before credit can return', async () => {
    const events = Array.from({length:100}, (_, i) => ({ id:i+1,sessionId:'session-1',agentId:'codex-cli',kind:'message',payload:{role:'assistant',text:'a'.repeat(10*1024)},ts:now+i }));
    const projection = projectSessionEvents(events as any, {id:'session-1',agentId:'codex-cli'} as any, 100, {workspaceRoot:'/workspace',privateRoots:[]});
    const result = parseSessionEventListResult({...projection,revision:100}, 'session-1', 100);
    const frameBytes = encodeJsonFrame({type:'result',requestId:'events',revision:100,result} as any).byteLength;
    expect(frameBytes).toBeGreaterThan(768*1024);
    expect(frameBytes).toBeLessThan(3*1024*1024);
    const emitted: RelayRouteFrame[] = [];
    const runtime = { supportedMethods:['session.events.list'], start:async()=>{},stop:async()=>{}, currentRevision:()=>100,execute:async()=>({result,revision:100}) };
    const channels = createLocalWorkerDaemonFrameChannels({instanceId:'instance-1',appVersion:'scan',authoritativeCoreId:'core-1',runtime:runtime as any,getWorkerGeneration:()=>1});
    const bridge = new LocalWorkerFrameBridge('instance-1',1,channels,frame => emitted.push(frame));
    const incoming = (kind: RelayRouteFrame['kind'], sequence:number, payload = new Uint8Array()): RelayRouteFrame => ({instanceId:'instance-1',generation:1,streamId:'stream-1',direction:'client-to-worker',sequence,kind,payload,creditBytes:null,resetCode:null,connectionScope:kind==='open'?'scope-1':null,accessSurface:kind==='open'?'desktop':null,accessGrant:kind==='open'?issueRemoteOwnerGrantClaim('desktop'):null});
    try {
      bridge.accept(incoming('open',0));
      bridge.accept(incoming('data',1,encodeJsonFrame({type:'hello',requestId:'hello',hello:{protocolVersion:CURRENT_PROTOCOL_VERSION,appVersion:'scan',requestedTopology:'relay',clientId:'client-1',lastEventRevision:0}} as any)));
      await new Promise(resolve => setImmediate(resolve));
      const decoded = new LengthPrefixedJsonDecoder().push(Buffer.concat(emitted.filter(f=>f.kind==='data').map(f=>Buffer.from(f.payload))));
      expect(decoded[0]).toMatchObject({type:'hello-result'});
      emitted.length=0;
      bridge.accept(incoming('data',2,encodeJsonFrame({type:'request',requestId:'events',method:'session.events.list',params:{sessionId:'session-1',limit:100},idempotencyKey:null,expectedRevision:null,deadlineAt:null} as any)));
      await new Promise(resolve => setImmediate(resolve));
      expect(emitted.some(f=>f.kind==='reset'&&f.resetCode==='backpressure')).toBe(true);
      expect(bridge.streamCount()).toBe(0);
      console.log('RELAY',JSON.stringify({validResponseBytes:frameBytes,eventCount:result.events.length,reset:emitted.find(f=>f.kind==='reset')?.resetCode,dataBytesEmitted:emitted.filter(f=>f.kind==='data').reduce((n,f)=>n+f.payload.byteLength,0),streamCount:bridge.streamCount()}));
    } finally { bridge.dispose(); }
  });
});
