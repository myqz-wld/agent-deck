/**
 * Spike 2: 实测 codex SDK `item.updated{agent_message}` 行为，判断 codex 实时 tok/s 可行性。
 *
 * 核心未知（claude spike 已定论文本估算可行，codex 需单独验证数据源）：
 *  Q1. codex SDK 在 turn 进行中到底发不发 item.updated{agent_message}？发几次？间隔多大？
 *  Q2. **AgentMessageItem.text 在 item.updated 阶段是增量(delta)还是全量快照(cumulative)？**
 *      —— 决定实时估算取「Δtext.length」还是「text.length 直接当累计」。这是最关键的一点。
 *  Q3. reasoning(GPT reasoning)有没有 item.updated 增量？(thinking 阶段能否反映活动)
 *  Q4. usage 是否真的只在 turn.completed 出现一次(印证 translate.ts 现状)？
 *
 * 用法: zsh -i -l -c "cd <dir> && unset ELECTRON_RUN_AS_NODE && node codex-runner.mjs 2>&1 | tee codex-case.log"
 * 鉴权: codex SDK spawn 的 codex binary 自读 ~/.codex 登录态，apiKey 不传。
 */
import { Codex } from '@openai/codex-sdk';

const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6, ' ');

const PROMPT =
  '请逐条详细写出 1 到 30 的中文数字大写（壹/贰/叁…），每个数字单独一行并附一句简短说明，不要省略，不要用工具，不要执行任何命令。';

const counts = {
  'thread.started': 0,
  'turn.started': 0,
  'turn.completed': 0,
  'item.started': 0,
  'item.updated': 0,
  'item.completed': 0,
  error: 0,
};
// 按 item.type 细分 item.updated
const updatedByType = {};
// agent_message 的 item.updated：记录 (ts, id, text.length, text 前 20 字)
const agentMsgUpdates = [];
// reasoning 的 item.updated
const reasoningUpdates = [];
let usageEvents = 0;
let firstAgentMsgUpdateMs = null;

console.log(`[${ms()}] codex spike start`);

const codex = new Codex(); // 无 apiKey → 走 ~/.codex 已登录态
const thread = codex.startThread({
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
  skipGitRepoCheck: true,
});

try {
  const { events } = await thread.runStreamed(PROMPT);
  for await (const ev of events) {
    counts[ev.type] = (counts[ev.type] ?? 0) + 1;

    if (ev.type === 'item.updated') {
      const it = ev.item;
      updatedByType[it.type] = (updatedByType[it.type] ?? 0) + 1;
      if (it.type === 'agent_message') {
        const now = Date.now() - t0;
        if (firstAgentMsgUpdateMs === null) firstAgentMsgUpdateMs = now;
        agentMsgUpdates.push({ ts: now, id: it.id, len: (it.text ?? '').length });
        console.log(
          `[${ms()}] item.updated{agent_message} id=${it.id.slice(-6)} text.len=${(it.text ?? '').length} head="${(it.text ?? '').slice(0, 16).replace(/\n/g, '⏎')}"`,
        );
      } else if (it.type === 'reasoning') {
        reasoningUpdates.push({ ts: Date.now() - t0, len: (it.text ?? '').length });
      }
    } else if (ev.type === 'item.started') {
      console.log(`[${ms()}] item.started{${ev.item.type}} id=${ev.item.id.slice(-6)}`);
    } else if (ev.type === 'item.completed') {
      const it = ev.item;
      if (it.type === 'agent_message') {
        console.log(`[${ms()}] item.completed{agent_message} FINAL text.len=${(it.text ?? '').length}`);
      } else {
        console.log(`[${ms()}] item.completed{${it.type}}`);
      }
    } else if (ev.type === 'turn.completed') {
      usageEvents++;
      console.log(`[${ms()}] turn.completed usage=${JSON.stringify(ev.usage)}`);
    } else if (ev.type === 'thread.started') {
      console.log(`[${ms()}] thread.started id=${ev.thread_id}`);
    } else if (ev.type === 'error') {
      console.log(`[${ms()}] ERROR ev: ${ev.message}`);
    }
  }
} catch (err) {
  console.error(`[${ms()}] EXCEPTION`, err?.message ?? err);
  console.error(err?.stack ?? '');
}

// ── 分析 ──
function gaps(arr) {
  const g = [];
  for (let i = 1; i < arr.length; i++) g.push(arr[i].ts - arr[i - 1].ts);
  return g;
}
function stat(g) {
  if (!g.length) return 'n/a';
  const sum = g.reduce((a, b) => a + b, 0);
  return `count=${g.length} avg=${Math.round(sum / g.length)}ms min=${Math.min(...g)}ms max=${Math.max(...g)}ms`;
}

// Q2 判定：text.len 序列是单调递增(累计快照) 还是 跳变/小值(增量)？
const lens = agentMsgUpdates.map((u) => u.len);
let monotonic = true;
for (let i = 1; i < lens.length; i++) if (lens[i] < lens[i - 1]) monotonic = false;

console.log('\n══════════ CODEX SPIKE 汇总 ══════════');
console.log('event 计数:', JSON.stringify(counts));
console.log('item.updated 按 type:', JSON.stringify(updatedByType));
console.log('\nQ1/Q2 agent_message item.updated:');
console.log('  发送次数 =', agentMsgUpdates.length);
console.log('  间隔 =', stat(gaps(agentMsgUpdates)));
console.log('  text.len 序列 =', JSON.stringify(lens));
console.log(
  '  >>> text 语义判定:',
  agentMsgUpdates.length === 0
    ? '无 agent_message 增量帧'
    : monotonic
      ? '单调递增 → 累计快照(cumulative snapshot)，估算取 text.length 直接当累计'
      : '非单调 → 增量(delta)，估算取 Σ Δlen',
);
console.log('\nQ3 reasoning item.updated:');
console.log('  发送次数 =', reasoningUpdates.length, reasoningUpdates.length ? '间隔=' + stat(gaps(reasoningUpdates)) : '');
console.log('\nQ4 usage 出现次数(应为 1，仅 turn.completed) =', usageEvents);
console.log('\nfirstAgentMsgUpdate =', firstAgentMsgUpdateMs, 'ms');
console.log('总耗时 =', Date.now() - t0, 'ms');
console.log('══════════════════════════════════════');
