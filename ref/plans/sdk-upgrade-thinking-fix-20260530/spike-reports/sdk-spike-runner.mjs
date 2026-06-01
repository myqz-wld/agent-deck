/**
 * SDK 行为对比 spike runner（plan sdk-upgrade-thinking-fix-20260530 §Step 0.5）。
 *
 * 复刻 agent-deck 应用真实 query() 调用方式（query-options-builder.ts 关键字段：
 * model 透传 / systemPrompt claude_code preset / settingSources），dump SDK 上行的
 * **原始 SDKMessage stream**——数据库只存 translate *之后* 的 AgentEvent，看不到
 * assistant message content blocks 的原始 type 序列（thinking / text / tool_use）。
 *
 * 参数化（环境变量）：
 *   SPIKE_MODEL      模型 id（默认 thinking-max；case C 传普通 opus 隔离模型特性）
 *   SPIKE_TAG        输出文件前缀 / 日志标签
 *   SPIKE_PROMPT     prompt 文本
 *   SPIKE_WITH_TOOLS '1' → bypassPermissions + allowedTools:[Read]（复现 malformed 需工具调用）
 *   SPIKE_CWD        query cwd（默认 agent-deck 项目根，复刻应用真实 settings 环境）
 *
 * 输出：<TAG>-raw.jsonl（完整原始 message，每行一条）+ stdout 结构化摘要。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));

const MODEL = process.env.SPIKE_MODEL || 'claude-opus-4-8-thinking-max[1m]';
const TAG = process.env.SPIKE_TAG || 'caseA';
const PROMPT =
  process.env.SPIKE_PROMPT ||
  '请判断：一个落后 14 个 patch 版本的 SDK 该不该升级到最新版？给出明确判断和理由。不要调用任何工具，直接回答。';
const WITH_TOOLS = process.env.SPIKE_WITH_TOOLS === '1';
const CWD = process.env.SPIKE_CWD || '/Users/apple/Repository/personal/agent-deck';
const OUT_DIR = process.env.SPIKE_OUT_DIR || __dir;

const rawLog = join(OUT_DIR, `${TAG}-raw.jsonl`);
writeFileSync(rawLog, '');

let sdkVer = 'unknown';
try {
  sdkVer = require('@anthropic-ai/claude-agent-sdk/package.json').version;
} catch {
  /* ignore */
}

console.log(`[${TAG}] sdk=${sdkVer} model=${MODEL} withTools=${WITH_TOOLS} cwd=${CWD}`);
console.log(`[${TAG}] prompt=${PROMPT}`);
console.log(`[${TAG}] === stream ===`);

const stats = { msgs: 0, asstMsgs: 0, thinking: 0, text: 0, toolUse: 0, malformed: 0 };

const REAL_ENV = process.env.SPIKE_REAL_ENV === '1';
const USE_CANUSE = process.env.SPIKE_CANUSE === '1';

// REAL_ENV：append agent-deck CLAUDE.md（复刻 getAgentDeckSystemPromptAppend）
let append = '';
if (REAL_ENV) {
  try {
    append = require('node:fs').readFileSync(
      '/Users/apple/Repository/personal/agent-deck/resources/claude-config/CLAUDE.md',
      'utf8',
    );
  } catch {
    /* ignore */
  }
}

// CANUSE：复刻应用 canUseTool 回调（auto-allow，逼近应用真实权限路径）
const canUseTool = async (_toolName, input) => ({ behavior: 'allow', updatedInput: input });

const options = {
  model: MODEL,
  cwd: CWD,
  systemPrompt: { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) },
  settingSources: REAL_ENV ? ['user', 'project', 'local'] : [],
};
if (USE_CANUSE) {
  options.permissionMode = 'default';
  options.canUseTool = canUseTool;
} else if (WITH_TOOLS) {
  options.permissionMode = 'bypassPermissions';
  options.allowDangerouslySkipPermissions = true;
  options.allowedTools = ['Read', 'Glob', 'Grep'];
} else {
  options.permissionMode = 'default';
}

const clip = (s, n = 70) => (s || '').slice(0, n).replace(/\n/g, ' ');

try {
  const q = query({ prompt: PROMPT, options });
  for await (const msg of q) {
    stats.msgs++;
    appendFileSync(rawLog, JSON.stringify(msg) + '\n');
    if (/malformed|could not be parsed/i.test(JSON.stringify(msg))) {
      stats.malformed++;
      console.log(`  ⚠ [MALFORMED] msg#${stats.msgs} type=${msg.type}`);
    }
    if (msg.type === 'assistant') {
      stats.asstMsgs++;
      const blocks = msg.message?.content ?? [];
      console.log(`  #${stats.msgs} assistant [${blocks.map((b) => b.type).join(', ')}]`);
      for (const b of blocks) {
        if (b.type === 'thinking') {
          stats.thinking++;
          console.log(`      🧠 "${clip(b.thinking)}"`);
        } else if (b.type === 'redacted_thinking') {
          stats.thinking++;
          console.log(`      🧠(redacted)`);
        } else if (b.type === 'text') {
          stats.text++;
          console.log(`      💬 "${clip(b.text)}"`);
        } else if (b.type === 'tool_use') {
          stats.toolUse++;
          console.log(`      🔧 ${b.name} ${clip(JSON.stringify(b.input), 50)}`);
        }
      }
    } else if (msg.type === 'user') {
      const blocks = msg.message?.content ?? [];
      console.log(`  #${stats.msgs} user [${blocks.map((b) => b.type).join(', ')}]`);
      for (const b of blocks) {
        if (b.type === 'tool_result')
          console.log(`      ↩ tool_result is_error=${b.is_error} "${clip(JSON.stringify(b.content), 60)}"`);
      }
    } else if (msg.type === 'result') {
      console.log(`  #${stats.msgs} result subtype=${msg.subtype} is_error=${msg.is_error}`);
    } else if (msg.type === 'system') {
      console.log(`  #${stats.msgs} system subtype=${msg.subtype}`);
    } else {
      console.log(`  #${stats.msgs} ${msg.type}`);
    }
  }
} catch (err) {
  console.log(`[${TAG}] ❌ ERROR: ${err?.message || err}`);
  console.log(err?.stack || '');
}

console.log(`[${TAG}] === summary ===`);
console.log(`  ${JSON.stringify(stats)}`);
console.log(`  raw → ${rawLog}`);
