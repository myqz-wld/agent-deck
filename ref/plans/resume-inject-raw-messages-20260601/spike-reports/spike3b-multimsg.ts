import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// 方式B: 历史每条独立成 message（真·多条列表），最后当前问题。不碰 shouldQuery。
// 验证: 多条传入 SDK 是否都看到 + 是否只在最后正常回答一次。
async function* methodB(): AsyncIterable<SDKUserMessage> {
  // 模拟 DB 历史: user/assistant 交替，每条独立 message
  yield { type:'user', message:{role:'user', content:'我叫小明，喜欢紫色。'}, parent_tool_use_id:null };
  yield { type:'user', message:{role:'user', content:'[这是我上一轮的话] 我养了狗叫旺财。'}, parent_tool_use_id:null };
  yield { type:'user', message:{role:'user', content:'我的名字、颜色、宠物名分别是什么？直接答。'}, parent_tool_use_id:null };
}
async function main() {
  let t=0; const texts:string[]=[];
  console.log('=== spike3b: 真·多条独立 message 传入 ===');
  try {
    const q = query({ prompt: methodB(), options:{cwd:process.cwd(), permissionMode:'bypassPermissions'} });
    for await (const msg of q) {
      const m = msg as any;
      if (m.type==='assistant'){t++;const c=m.message?.content;const x=Array.isArray(c)?c.map((b:any)=>b.text||'').join(''):String(c);if(x.trim())texts.push(x);console.log('  ASST['+t+']: '+x.slice(0,200));}
      if (m.type==='result'){const f=texts.join(' ');console.log('num_turns='+m.num_turns+' asstTurns='+t+' 小明='+f.includes('小明')+' 紫='+f.includes('紫')+' 旺财='+f.includes('旺财'));break;}
    }
  } catch(e){console.error('ERR: '+(e as Error).message);}
}
void main();
