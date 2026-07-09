/**
 * 多轮 streaming input spike runner（plan sdk-upgrade-thinking-fix-20260530 §Step 0.5）。
 *
 * 单轮 runner（sdk-spike-runner.mjs）6 case 全健康 0 malformed。应用与 spike 最后一个
 * 关键差异 = 多轮 streaming input（应用 prompt 是 AsyncIterable<SDKUserMessage> 多轮累积，
 * 单轮 runner 是字符串单轮）。本 runner 用可控 InputQueue 模拟真实多轮交互（收到 result
 * 才推下一轮 prompt），累积长上下文 + 每轮工具调用，复现 malformed 触发条件。
 *
 * **重点检测**：API 注入的 malformed 是 user message（content 为 string，非 tool_result
 * block），单轮 runner 的 user 分支只看 tool_result 漏了它——本 runner 显式检测 string
 * content 的 user message。
 *
 * 环境变量：SPIKE_MODEL / SPIKE_TAG / SPIKE_CWD / SPIKE_OUT_DIR（同单轮 runner）。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));

const MODEL = process.env.SPIKE_MODEL || 'claude-opus-4-8-thinking-max[1m]';
const TAG = process.env.SPIKE_TAG || 'multiA';
const CWD = process.env.SPIKE_CWD || '/Users/apple/Repository/personal/agent-deck';
const OUT_DIR = process.env.SPIKE_OUT_DIR || __dir;

let sdkVer = 'unknown';
try {
  sdkVer = require('@anthropic-ai/claude-agent-sdk/package.json').version;
} catch {
  /* ignore */
}

const rawLog = join(OUT_DIR, `${TAG}-raw.jsonl`);
writeFileSync(rawLog, '');

const PROMPTS = [
  '读取 /Users/apple/Repository/personal/agent-deck/package.json，告诉我 version 字段的值。',
  '再读取 /Users/apple/Repository/personal/agent-deck/tsconfig.node.json，告诉我它 extends 什么。',
  '用 Grep 在 /Users/apple/Repository/personal/agent-deck/package.json 里找 electron 出现在哪些行。',
  '基于前面读到的信息，总结这个项目用了哪些核心技术栈，列 3-5 点。',
  '最后评估一下这个项目的依赖管理（pnpm + lockfile）是否规范，给简短结论。',
];

// 可控 input queue：收到 result 才推下一轮，模拟真实多轮交互
class InputQueue {
  constructor() {
    this.q = [];
    this.resolvers = [];
    this.ended = false;
  }
  push(msg) {
    if (this.resolvers.length) this.resolvers.shift()({ value: msg, done: false });
    else this.q.push(msg);
  }
  end() {
    this.ended = true;
    while (this.resolvers.length) this.resolvers.shift()({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.q.length) return Promise.resolve({ value: this.q.shift(), done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.resolvers.push(r));
      },
    };
  }
}

const mkUser = (text) => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  session_id: '',
});

const canUseTool = async (_t, input) => ({ behavior: 'allow', updatedInput: input });
const clip = (s, n = 65) => (s || '').slice(0, n).replace(/\n/g, ' ');

console.log(`[${TAG}] sdk=${sdkVer} model=${MODEL} turns=${PROMPTS.length}`);
console.log(`[${TAG}] === stream ===`);

const stats = { msgs: 0, thinking: 0, text: 0, toolUse: 0, malformed: 0, turns: 0 };

const input = new InputQueue();
input.push(mkUser(PROMPTS[0]));
let turnIdx = 0;

try {
  const q = query({
    prompt: input,
    options: {
      model: MODEL,
      cwd: CWD,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: [],
      permissionMode: 'default',
      canUseTool,
    },
  });
  for await (const msg of q) {
    stats.msgs++;
    appendFileSync(rawLog, JSON.stringify(msg) + '\n');
    const rawStr = JSON.stringify(msg);
    if (/Your tool call was malformed|could not be parsed/i.test(rawStr)) {
      stats.malformed++;
      console.log(`  ⚠⚠ [MALFORMED HIT] msg#${stats.msgs} type=${msg.type} afterTurn=${stats.turns}`);
    }
    if (msg.type === 'assistant') {
      const blocks = msg.message?.content ?? [];
      console.log(`  T${stats.turns + 1} #${stats.msgs} assistant [${blocks.map((b) => b.type).join(', ')}]`);
      for (const b of blocks) {
        if (b.type === 'thinking') {
          stats.thinking++;
          console.log(`      🧠 "${clip(b.thinking)}"`);
        } else if (b.type === 'text') {
          stats.text++;
          console.log(`      💬 "${clip(b.text)}"`);
        } else if (b.type === 'tool_use') {
          stats.toolUse++;
          console.log(`      🔧 ${b.name}`);
        }
      }
    } else if (msg.type === 'user') {
      const content = msg.message?.content;
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content ?? []);
      // 关键：API 注入的 malformed 是 string content 的 user message
      if (typeof content === 'string' && /malformed|could not be parsed|retry/i.test(content)) {
        console.log(`  ⚠ USER-INJECTED(string): "${clip(contentStr, 90)}"`);
      } else {
        const blocks = Array.isArray(content) ? content : [];
        const trCount = blocks.filter((b) => b.type === 'tool_result').length;
        console.log(`  T${stats.turns + 1} #${stats.msgs} user [${typeof content === 'string' ? 'string' : `tool_result×${trCount}`}]`);
      }
    } else if (msg.type === 'result') {
      stats.turns++;
      console.log(`  #${stats.msgs} result T${stats.turns} subtype=${msg.subtype} is_error=${msg.is_error}`);
      turnIdx++;
      if (turnIdx < PROMPTS.length) {
        console.log(`  >>> push turn ${turnIdx + 1}`);
        input.push(mkUser(PROMPTS[turnIdx]));
      } else {
        input.end();
      }
    }
  }
} catch (err) {
  console.log(`[${TAG}] ❌ ERROR: ${err?.message || err}`);
  console.log((err?.stack || '').slice(0, 500));
  input.end();
}

console.log(`[${TAG}] === summary ===`);
console.log(`  ${JSON.stringify(stats)}`);
console.log(`  raw → ${rawLog}`);
