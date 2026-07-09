import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// streaming input mode: 用外部可控 queue + notify（mirror 现有 createUserMessageStream），
// 流保持开放，受控逐条 push，直到收到 result 才关。
class MsgQueue {
  private items: SDKUserMessage[] = [];
  private notify: (() => void) | null = null;
  private closed = false;
  push(m: SDKUserMessage) { this.items.push(m); this.notify?.(); }
  close() { this.closed = true; this.notify?.(); }
  async *stream(): AsyncIterable<SDKUserMessage> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => { this.notify = r; });
      this.notify = null;
    }
  }
}

async function main() {
  const qu = new MsgQueue();
  let asstTurns = 0; const texts: string[] = [];
  // 先 push 历史（shouldQuery:false）+ 当前问题（shouldQuery:true）
  qu.push({ type: 'user', message: { role: 'user', content: '我叫小明，喜欢紫色。' }, parent_tool_use_id: null, shouldQuery: false });
  qu.push({ type: 'user', message: { role: 'user', content: '我养了狗叫旺财。' }, parent_tool_use_id: null, shouldQuery: false });
  qu.push({ type: 'user', message: { role: 'user', content: '我的名字、颜色、宠物名是什么？直接答。' }, parent_tool_use_id: null, shouldQuery: true });

  try {
    const q = query({ prompt: qu.stream(), options: { cwd: process.cwd(), permissionMode: 'bypassPermissions' } });
    for await (const msg of q) {
      const m = msg as any;
      console.log('EVT ' + m.type + (m.subtype?'/'+m.subtype:''));
      if (m.type === 'assistant') { asstTurns++; const c=m.message?.content; const t=Array.isArray(c)?c.map((b:any)=>b.text||'['+b.type+']').join(''):String(c); texts.push(t); console.log('  ASST['+asstTurns+']: '+t.slice(0,250)); }
      if (m.type === 'result') { console.log('  RESULT num_turns='+m.num_turns+' result="'+(m.result||'').slice(0,150)+'"'); qu.close(); break; }
    }
  } catch (e) { console.error('ERR: '+(e as Error).message); console.error((e as Error).stack?.slice(0,500)); qu.close(); return; }
  const full = texts.join(' ');
  console.log('\n=== 结论 === asstTurns='+asstTurns+'(期望1) 小明='+full.includes('小明')+' 紫='+full.includes('紫')+' 旺财='+full.includes('旺财'));
}
void main();
