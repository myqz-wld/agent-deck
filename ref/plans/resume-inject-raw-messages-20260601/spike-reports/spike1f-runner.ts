import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// 变体 F: 纯多条 user message，全不设 shouldQuery（看 AsyncIterable 多条基础行为）
async function* gen(): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: '记住：我叫小明。' }, parent_tool_use_id: null };
  yield { type: 'user', message: { role: 'user', content: '我的名字是什么？直接答。' }, parent_tool_use_id: null };
}
async function main() {
  let t = 0; const texts: string[] = [];
  try {
    const q = query({ prompt: gen(), options: { cwd: process.cwd(), permissionMode: 'bypassPermissions' } });
    for await (const msg of q) {
      const m = msg as any; console.log('EVT ' + m.type + (m.subtype?'/'+m.subtype:''));
      if (m.type === 'assistant') { t++; const c=m.message?.content; const x=Array.isArray(c)?c.map((b:any)=>b.text||'').join(''):String(c); texts.push(x); console.log('  A'+t+': '+x.slice(0,150)); }
      if (m.type === 'result') { console.log('  RES num_turns='+m.num_turns); break; }
    }
  } catch(e) { console.error('ERR: '+(e as Error).message); return; }
  console.log('F: asstTurns='+t+' 小明='+texts.join('').includes('小明'));
}
void main();
