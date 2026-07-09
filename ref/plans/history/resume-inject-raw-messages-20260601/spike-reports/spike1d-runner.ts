import { query } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  console.log('--- baseline: 单条 string prompt（不用 AsyncIterable）---');
  let turns = 0; const texts: string[] = [];
  try {
    const q = query({ prompt: '说出"测试成功"四个字', options: { cwd: process.cwd(), permissionMode: 'bypassPermissions' } });
    for await (const msg of q) {
      const m = msg as any;
      console.log('EVENT ' + m.type + (m.subtype ? '/' + m.subtype : ''));
      if (m.type === 'assistant') { turns++; const c = m.message?.content; texts.push(Array.isArray(c)?c.map((b:any)=>b.text||'').join(''):String(c)); }
      if (m.type === 'result') { console.log('RESULT num_turns=' + m.num_turns + ' result="' + (m.result||'').slice(0,100) + '"'); break; }
    }
  } catch (e) { console.error('ERR: ' + (e as Error).message); return; }
  console.log('baseline asstTurns=' + turns + ' text=' + texts.join('').slice(0,100));
}
void main();
