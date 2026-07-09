/**
 * Spike3: 补测 spike1 的盲区 —— 长输出下 message_delta 是否周期性多次发送。
 *
 * spike1 只测短输出（haiku 1441 tok / 11s），message_delta 只来 1 次（末尾）。
 * 但 Anthropic 原生 SSE 对长生成通常周期性发 message_delta 更新累计 usage。
 * 本 spike 用超长输出 prompt，实测 message_delta 次数 / 间隔 / 累计差分。
 *
 * 决策含义：
 *  - 若 message_delta 发多次 → 可用累计 output_tokens 差分算精确实时速率（不用文本估算）
 *  - 若仍只发 1 次 → spike1 结论成立，走文本估算
 *
 * 用法: zsh -i -l -c "cd <spike-dir> && unset ELECTRON_RUN_AS_NODE && SPIKE_MODEL=haiku node runner-long.mjs"
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6, ' ');

// 产生超长输出（目标 ~5000+ token / 40s+），逼出周期性 message_delta（若存在）。
const PROMPT =
  '请逐条详细写出 1 到 100 的中文数字大写（壹/贰/叁/肆/伍…），每个数字单独一行，' +
  '并附一两句话说明这个数字的文化含义、典故或常见用法，务必逐条写完全部 100 个不要省略，不要使用任何工具。';

const MODEL = process.env.SPIKE_MODEL || 'haiku';

let mdCount = 0;
let tdCount = 0;
let thinkCount = 0;
const mdTs = [];      // message_delta 时间戳
const mdOut = [];     // message_delta 累计 output_tokens
const tdTs = [];      // text_delta 时间戳
let prevOut = 0;
let prevMdTs = 0;

console.log(`[${ms()}] spike3-long start, model=${MODEL}, prompt len=${PROMPT.length}`);

const q = query({
  prompt: PROMPT,
  options: {
    includePartialMessages: true,
    permissionMode: 'default',
    settingSources: [],
    model: MODEL,
  },
});

try {
  for await (const m of q) {
    if (m.type === 'stream_event') {
      const ev = m.event;
      const et = ev?.type;
      if (et === 'message_start') {
        const u = ev.message?.usage;
        console.log(`[${ms()}] message_start input=${u?.input_tokens} output=${u?.output_tokens}`);
      } else if (et === 'message_delta') {
        mdCount++;
        const now = Date.now() - t0;
        const out = ev.usage?.output_tokens ?? 0;
        const dOut = out - prevOut;
        const gap = mdCount === 1 ? 0 : now - prevMdTs;
        mdTs.push(now);
        mdOut.push(out);
        console.log(
          `[${ms()}] *** message_delta #${mdCount}  out=${out}  Δout=+${dOut}  gap=${gap}ms  ` +
          `inst=${gap > 0 ? Math.round((dOut / gap) * 1000) : 'n/a'} tok/s  stop=${ev.delta?.stop_reason ?? '-'}`,
        );
        prevOut = out;
        prevMdTs = now;
      } else if (et === 'content_block_delta') {
        const d = ev.delta;
        if (d?.type === 'text_delta') {
          tdCount++;
          tdTs.push(Date.now() - t0);
        } else if (d?.type === 'thinking_delta') {
          thinkCount++;
        }
      }
    } else if (m.type === 'result') {
      const mu = m.modelUsage ?? null;
      console.log(`[${ms()}] RESULT subtype=${m.subtype} modelUsage=${JSON.stringify(mu)}`);
    }
  }
} catch (err) {
  console.error(`[${ms()}] ERROR`, err?.message ?? err);
}

function gaps(arr) {
  const g = [];
  for (let i = 1; i < arr.length; i++) g.push(arr[i] - arr[i - 1]);
  return g;
}
function stats(g) {
  if (!g.length) return 'n/a';
  const sum = g.reduce((a, b) => a + b, 0);
  return `count=${g.length} avg=${Math.round(sum / g.length)}ms min=${Math.min(...g)}ms max=${Math.max(...g)}ms`;
}

console.log('\n══════════ SPIKE3 汇总（长输出）══════════');
console.log('model =', MODEL);
console.log('总耗时 =', Date.now() - t0, 'ms');
console.log('\n>>> message_delta（关键）:');
console.log('  发送次数 =', mdCount);
console.log('  间隔 =', stats(gaps(mdTs)));
console.log('  累计 output_tokens 序列 =', JSON.stringify(mdOut));
console.log('  时间戳序列 =', JSON.stringify(mdTs));
console.log('\n对比 text_delta:');
console.log('  发送次数 =', tdCount, '  间隔 =', stats(gaps(tdTs)));
console.log('  thinking_delta 次数 =', thinkCount);
console.log('\n裁决:');
if (mdCount >= 3) {
  console.log('  ✅ message_delta 长输出下多次发送 → 精确差分实时速率可行！');
} else if (mdCount === 2) {
  console.log('  ⚠️ message_delta 仅 2 次 → 周期性存在但太稀疏，差分粒度粗');
} else {
  console.log('  ❌ message_delta 仍只 1 次 → spike1 结论成立，走文本估算');
}
console.log('═══════════════════════════════════════');
