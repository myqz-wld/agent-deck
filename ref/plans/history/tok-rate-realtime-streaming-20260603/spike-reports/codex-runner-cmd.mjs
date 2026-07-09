import { Codex } from '@openai/codex-sdk';
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6, ' ');
const PROMPT = '请执行这个 shell 命令（用你的命令执行工具）：for i in $(seq 1 8); do echo "line $i"; sleep 0.5; done — 执行完把输出告诉我即可。';
const counts = {};
const updatedByType = {};
const cmdUpdates = [];
console.log(`[${ms()}] codex cmd spike start`);
const codex = new Codex();
const thread = codex.startThread({ sandboxMode: 'workspace-write', approvalPolicy: 'never', skipGitRepoCheck: true });
try {
  const { events } = await thread.runStreamed(PROMPT);
  for await (const ev of events) {
    counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    if (ev.type === 'item.updated') {
      const it = ev.item;
      updatedByType[it.type] = (updatedByType[it.type] ?? 0) + 1;
      if (it.type === 'command_execution') {
        cmdUpdates.push(Date.now() - t0);
        console.log(`[${ms()}] item.updated{command_execution} status=${it.status} out.len=${(it.aggregated_output??'').length}`);
      } else {
        console.log(`[${ms()}] item.updated{${it.type}} len=${(it.text??'').length}`);
      }
    } else if (ev.type === 'item.started') {
      console.log(`[${ms()}] item.started{${ev.item.type}}`);
    } else if (ev.type === 'item.completed') {
      console.log(`[${ms()}] item.completed{${ev.item.type}}`);
    } else if (ev.type === 'turn.completed') {
      console.log(`[${ms()}] turn.completed usage=${JSON.stringify(ev.usage)}`);
    }
  }
} catch (e) { console.error('EXC', e?.message); }
console.log('\n汇总 counts:', JSON.stringify(counts));
console.log('item.updated byType:', JSON.stringify(updatedByType));
console.log('command_execution updated 次数:', cmdUpdates.length);
console.log('总耗时:', Date.now()-t0, 'ms');
