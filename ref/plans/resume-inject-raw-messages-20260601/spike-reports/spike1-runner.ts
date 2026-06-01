/**
 * spike1: 实测 claude-agent-sdk 的 shouldQuery:false 逐条 append 历史机制。
 *
 * 动机：plan resume-inject-raw-messages 原架构把「总结+30条历史」拼进单条首条 prompt，
 * 撞 102_400 上限派生出 cap/降级链/beforeId 一整套复杂度（3 轮 review 都在这上面打磨）。
 * 用户质疑「直接送列表消息不行吗」——查 SDK 类型定义发现 SDKUserMessage 有原生
 * `shouldQuery?: boolean` 字段，注释：「When false, the message is appended to the
 * transcript without triggering an assistant turn. It will be merged into the next
 * user message that does query.」+ MessageParam.role 可为 'assistant'。
 *
 * 假设（待实测验证）：
 * H1: AsyncIterable 送多条 SDKUserMessage，shouldQuery:false 的不触发 assistant turn
 * H2: message.role 可为 'assistant'（assistant 历史用真实 role 送，不用伪装 user）
 * H3: 最后一条 shouldQuery:true（或省略默认 true）触发回应，且能看到前面 append 的历史
 *
 * 若 H1-H3 都成立 → 推翻拼接架构，改逐条 append（无 cap/无降级/无 beforeId）。
 *
 * 跑法：zsh -i -l -c "npx tsx <本文件>"（tsx 直接跑 TS，走 SDK 内部鉴权）
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// 构造历史对话 + 当前问题的 AsyncIterable
async function* buildMessages(): AsyncIterable<SDKUserMessage> {
  // 历史 user 消息（shouldQuery:false，不触发回应）
  yield {
    type: 'user',
    message: { role: 'user', content: '我叫小明，我最喜欢的颜色是紫色。' },
    parent_tool_use_id: null,
    shouldQuery: false,
  };
  // 历史 assistant 消息（关键测试：role:'assistant' + shouldQuery:false）
  yield {
    // @ts-expect-error 实测 assistant role 能否作为 SDKUserMessage 送（类型上 message:MessageParam 支持 assistant）
    type: 'user',
    message: { role: 'assistant', content: '好的小明，我记住了你喜欢紫色。' },
    parent_tool_use_id: null,
    shouldQuery: false,
  };
  // 历史 user 消息2
  yield {
    type: 'user',
    message: { role: 'user', content: '我还养了一只叫旺财的狗。' },
    parent_tool_use_id: null,
    shouldQuery: false,
  };
  // 当前问题（shouldQuery 省略 = 默认 true，触发回应；测能否看到上面历史）
  yield {
    type: 'user',
    message: { role: 'user', content: '我的名字、喜欢的颜色、宠物名字分别是什么？请直接回答。' },
    parent_tool_use_id: null,
  };
}

async function main(): Promise<void> {
  console.log('=== spike1: shouldQuery:false append 历史实测 ===');
  console.log('期望：Claude 回答能说出「小明/紫色/旺财」三个信息（证明历史被 append 看到）');
  console.log('且：前 3 条 shouldQuery:false 不各自触发一轮回应（只有最后当前问题触发一次）\n');

  const turnTexts: string[] = [];
  let assistantTurnCount = 0;

  try {
    const q = query({
      prompt: buildMessages(),
      options: {
        cwd: process.cwd(),
        permissionMode: 'bypassPermissions',
        // 不传 resume — 全新 session，纯测 append 机制
      },
    });

    for await (const msg of q) {
      // 记录每条 SDKMessage 的 type，观察 assistant turn 数量
      const m = msg as { type: string; message?: { content?: unknown } };
      console.log(`[event] type=${m.type}`);
      if (m.type === 'assistant') {
        assistantTurnCount++;
        const content = m.message?.content;
        const text = Array.isArray(content)
          ? content.map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('')
          : String(content);
        turnTexts.push(text);
        console.log(`  [assistant turn ${assistantTurnCount}] ${text.slice(0, 200)}`);
      }
      if (m.type === 'result') {
        console.log('  [result reached, ending]');
        break;
      }
    }
  } catch (err) {
    console.error('=== spike FAILED (可能鉴权/SDK 错误) ===');
    console.error((err as Error).message ?? err);
    console.error('\n如果是鉴权错误，说明独立 runner 起不来，需换主进程内实测');
    process.exit(1);
  }

  console.log('\n=== 实测结论 ===');
  const full = turnTexts.join(' ');
  const sawName = full.includes('小明');
  const sawColor = full.includes('紫');
  const sawPet = full.includes('旺财');
  console.log(`assistant turn 数: ${assistantTurnCount}（期望 1，若 >1 说明 shouldQuery:false 仍触发了回应）`);
  console.log(`H3 历史可见性: 小明=${sawName} 紫色=${sawColor} 旺财=${sawPet}`);
  console.log(`H1 (shouldQuery:false 不触发额外 turn): ${assistantTurnCount === 1 ? '✅ 成立' : '❌ 不成立(turn=' + assistantTurnCount + ')'}`);
  console.log(`H3 (append 历史被看到): ${sawName && sawColor && sawPet ? '✅ 成立' : '⚠️ 部分/不成立'}`);
  console.log('\nH2 (assistant role 能送): 看上面有无因 role:assistant 报错；无报错=类型层接受');
}

void main();
