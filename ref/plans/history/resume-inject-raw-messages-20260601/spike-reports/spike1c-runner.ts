import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

async function* buildMessages(): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: '我叫小明，喜欢紫色。' }, parent_tool_use_id: null, shouldQuery: false };
  yield { type: 'user', message: { role: 'user', content: '我养了狗叫旺财。' }, parent_tool_use_id: null, shouldQuery: false };
  // 显式 shouldQuery:true
  yield { type: 'user', message: { role: 'user', content: '我的名字、颜色、宠物名是什么？直接答。' }, parent_tool_use_id: null, shouldQuery: true };
}

async function main() {
  let asstTurns = 0; const texts: string[] = [];
  try {
    const q = query({ prompt: buildMessages(), options: { cwd: process.cwd(), permissionMode: 'bypassPermissions' } });
    for await (const msg of q) {
      const m = msg as any;
      console.log('EVENT type=' + m.type + (m.subtype ? ' subtype=' + m.subtype : ''));
      if (m.type === 'assistant') {
        asstTurns++;
        const c = m.message?.content;
        const t = Array.isArray(c) ? c.map((b: any) => b.text || '['+b.type+']').join('') : String(c);
        texts.push(t); console.log('  ASST[' + asstTurns + ']: ' + t.slice(0, 250));
      }
      if (m.type === 'result') { console.log('  RESULT num_turns=' + m.num_turns + ' result="' + (m.result||'').slice(0,150) + '"'); break; }
    }
  } catch (e) { console.error('ERR: ' + (e as Error).message); return; }
  const full = texts.join(' ');
  console.log('\n=== 结论 === asstTurns=' + asstTurns + ' 小明=' + full.includes('小明') + ' 紫=' + full.includes('紫') + ' 旺财=' + full.includes('旺财'));
}
void main();
