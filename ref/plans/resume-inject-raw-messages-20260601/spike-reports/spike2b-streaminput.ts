import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

class MsgQueue {
  private items: SDKUserMessage[] = []; private notify: (() => void) | null = null; private closed = false;
  push(m: SDKUserMessage) { this.items.push(m); this.notify?.(); }
  close() { this.closed = true; this.notify?.(); }
  async *stream(): AsyncIterable<SDKUserMessage> {
    while (true) { while (this.items.length>0) yield this.items.shift()!; if (this.closed) return; await new Promise<void>((r)=>{this.notify=r;}); this.notify=null; }
  }
}
async function main() {
  const qu = new MsgQueue(); let t=0; const texts:string[]=[];
  // 同 spike2 但全不设 shouldQuery — 隔离「是 queue 模式问题还是 shouldQuery:false 毒化」
  qu.push({ type:'user', message:{role:'user', content:'我叫小明，喜欢紫色。我养了狗叫旺财。'}, parent_tool_use_id:null });
  qu.push({ type:'user', message:{role:'user', content:'我的名字、颜色、宠物名是什么？直接答。'}, parent_tool_use_id:null });
  try {
    const q = query({ prompt: qu.stream(), options:{cwd:process.cwd(), permissionMode:'bypassPermissions'} });
    for await (const msg of q) {
      const m = msg as any; console.log('EVT '+m.type+(m.subtype?'/'+m.subtype:''));
      if (m.type==='assistant'){t++;const c=m.message?.content;const x=Array.isArray(c)?c.map((b:any)=>b.text||'').join(''):String(c);texts.push(x);console.log('  A'+t+': '+x.slice(0,200));}
      if (m.type==='result'){console.log('  RES num_turns='+m.num_turns);qu.close();break;}
    }
  } catch(e){console.error('ERR: '+(e as Error).message);qu.close();return;}
  console.log('\n2b(无shouldQuery queue): asstTurns='+t+' 小明='+texts.join('').includes('小明')+' 旺财='+texts.join('').includes('旺财'));
}
void main();
