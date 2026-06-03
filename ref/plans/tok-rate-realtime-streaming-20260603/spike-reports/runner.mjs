/**
 * Spike: 实测 Claude Agent SDK `includePartialMessages` 行为，为 tok/s 实时化方案定型。
 *
 * 验证三个未知：
 *  Q1. 开 includePartialMessages 后，turn 进行中能否拿到连续的 message_delta（带累计 output_tokens）？
 *      —— 决定方案 1 走「精确 delta」是否可行。
 *  Q2. message_delta 的发送频率（一条消息发几次？间隔多大？）
 *      —— 频率太低则精确 delta 收益打折，需 fallback 文本估算。
 *  Q3. 开 partial 后，完整的 type:'assistant' 帧 + type:'result' 帧是否照常来（不被替代）？
 *      —— 决定现有统计逻辑能否原样不动、partial 仅作展示旁路。
 *  附. content_block_delta（text_delta）的频率，作为 message_delta 稀疏时的兜底数据源。
 *
 * 用法: zsh -i -l -c "node runner.mjs 2>&1 | tee trace.log"
 * 鉴权: SDK spawn 的 CLI 子进程自动读 keychain (service 'Claude Code-credentials')，无需手动注入。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6, ' ');

// 让模型产出一段足够长的流式输出，turn 内才有多个 delta 可观测。
const PROMPT =
  '请逐条详细写出 1 到 30 的中文数字大写（壹/贰/叁…），每个数字单独一行并附一句简短说明，不要省略，不要用工具。';

const counts = {
  stream_event: 0,
  message_start: 0,
  message_delta: 0,
  content_block_delta: 0,
  text_delta: 0,
  other_stream: 0,
  assistant: 0,
  result: 0,
};

// 原始 stream_event.event.type 直方图 + content_block_delta.delta.type 直方图
const rawEventTypes = {};
const rawDeltaTypes = {};
const MODEL = process.env.SPIKE_MODEL || undefined; // 'haiku' / 'sonnet' / 'opus' / undefined(默认)

// message_delta 时间戳序列 → 算频率/间隔
const deltaTs = [];
// content_block_delta(text) 时间戳序列
const textTs = [];
// message_delta 里观测到的 output_tokens 累计序列
const outSeq = [];
let lastFullAssistantOutput = null;
let resultModelUsage = null;
let firstTokenMs = null;

console.log(`[${ms()}] spike start, prompt len=${PROMPT.length}`);

const q = query({
  prompt: PROMPT,
  options: {
    includePartialMessages: true,
    permissionMode: 'default',
    // 不挂任何 mcp / plugin / 自定义 systemPrompt，最小化噪声。
    settingSources: [],
    ...(MODEL ? { model: MODEL } : {}),
  },
});

console.log(`[${ms()}] model=${MODEL ?? '(default)'}`);

try {
  for await (const m of q) {
    if (m.type === 'stream_event') {
      counts.stream_event++;
      const ev = m.event;
      const et = ev?.type;
      rawEventTypes[et] = (rawEventTypes[et] ?? 0) + 1;
      if (et === 'message_start') {
        counts.message_start++;
        const u = ev.message?.usage;
        console.log(
          `[${ms()}] message_start usage.input=${u?.input_tokens} output=${u?.output_tokens}`,
        );
      } else if (et === 'message_delta') {
        counts.message_delta++;
        deltaTs.push(Date.now() - t0);
        const out = ev.usage?.output_tokens;
        if (typeof out === 'number') outSeq.push(out);
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        console.log(
          `[${ms()}] message_delta #${counts.message_delta} usage.output_tokens=${out} stop=${ev.delta?.stop_reason ?? '-'}`,
        );
      } else if (et === 'content_block_delta') {
        counts.content_block_delta++;
        const d = ev.delta;
        rawDeltaTypes[d?.type ?? 'undefined'] = (rawDeltaTypes[d?.type ?? 'undefined'] ?? 0) + 1;
        if (d?.type === 'text_delta') {
          counts.text_delta++;
          textTs.push(Date.now() - t0);
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        }
      } else {
        counts.other_stream++;
      }
    } else if (m.type === 'assistant') {
      counts.assistant++;
      const u = m.message?.usage;
      lastFullAssistantOutput = u?.output_tokens ?? null;
      console.log(
        `[${ms()}] FULL assistant frame: usage.output_tokens=${u?.output_tokens} input=${u?.input_tokens}`,
      );
    } else if (m.type === 'result') {
      counts.result++;
      resultModelUsage = m.modelUsage ?? m.result?.modelUsage ?? null;
      console.log(
        `[${ms()}] RESULT frame: subtype=${m.subtype} modelUsage=${JSON.stringify(resultModelUsage)}`,
      );
    }
  }
} catch (err) {
  console.error(`[${ms()}] ERROR`, err?.message ?? err);
}

// ── 统计汇总 ──
function gaps(arr) {
  const g = [];
  for (let i = 1; i < arr.length; i++) g.push(arr[i] - arr[i - 1]);
  return g;
}
function stats(g) {
  if (!g.length) return 'n/a';
  const sum = g.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / g.length);
  const min = Math.min(...g);
  const max = Math.max(...g);
  return `count=${g.length} avg=${avg}ms min=${min}ms max=${max}ms`;
}

console.log('\n══════════ SPIKE 汇总 ══════════');
console.log('model =', MODEL ?? '(default)');
console.log('frame 计数:', JSON.stringify(counts, null, 2));
console.log('原始 stream_event.event.type 直方图:', JSON.stringify(rawEventTypes));
console.log('原始 content_block_delta.delta.type 直方图:', JSON.stringify(rawDeltaTypes));
console.log('\nQ1/Q2 message_delta:');
console.log('  发送次数 =', counts.message_delta);
console.log('  间隔 =', stats(gaps(deltaTs)));
console.log('  output_tokens 累计序列 =', JSON.stringify(outSeq));
console.log('\n附 content_block_delta(text_delta):');
console.log('  发送次数 =', counts.text_delta);
console.log('  间隔 =', stats(gaps(textTs)));
console.log('\nQ3 完整帧是否照常来:');
console.log('  type:assistant 帧数 =', counts.assistant, '(最后 output_tokens=', lastFullAssistantOutput, ')');
console.log('  type:result 帧数 =', counts.result, '(modelUsage=', JSON.stringify(resultModelUsage), ')');
console.log('\nfirstToken(ttft 观测) =', firstTokenMs, 'ms');
console.log('总耗时 =', Date.now() - t0, 'ms');
console.log('══════════════════════════════');
