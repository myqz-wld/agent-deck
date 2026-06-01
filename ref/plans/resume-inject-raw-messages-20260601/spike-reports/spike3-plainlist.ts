import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// 你的真实诉求：历史对话当一串 message 传进去，SDK 看到上下文回答当前问题。
// 不碰 shouldQuery。测两种 content 组织方式。

// 方式 A: 把整段历史塞成 1 条 user message（带角色标注的文本）+ 当前问题 1 条
async function* methodA(): AsyncIterable<SDKUserMessage> {
  yield { type:'user', message:{role:'user', content:
    '[历史对话回顾]\n用户: 我叫小明，喜欢紫色。\n助手: 好的，记住了。\n用户: 我养了狗叫旺财。\n助手: 旺财好名字。\n[历史结束]'
  }, parent_tool_use_id:null };
  yield { type:'user', message:{role:'user', content:'我的名字、颜色、宠物名分别是什么？直接答。'}, parent_tool_use_id:null };
}

async function run(label: string, gen: () => AsyncIterable<SDKUserMessage>) {
  let t=0; const texts:string[]=[];
  try {
    const q = query({ prompt: gen(), options:{cwd:process.cwd(), permissionMode:'bypassPermissions'} });
    for await (const msg of q) {
      const m = msg as any;
      if (m.type==='assistant'){t++;const c=m.message?.content;const x=Array.isArray(c)?c.map((b:any)=>b.text||'').join(''):String(c);if(x.trim())texts.push(x);}
      if (m.type==='result'){const full=texts.join(' ');console.log(label+': num_turns='+m.num_turns+' asstTurns='+t);console.log('  回答: '+texts.join(' ').slice(0,300));console.log('  小明='+full.includes('小明')+' 紫='+full.includes('紫')+' 旺财='+full.includes('旺财'));break;}
    }
  } catch(e){console.error(label+' ERR: '+(e as Error).message);}
}

async function main() {
  console.log('=== spike3: 你的真实诉求 — 传历史列表，SDK 正常回答当前问题 ===\n');
  await run('方式A(历史塞1条user+当前1条)', methodA);
}
void main();
