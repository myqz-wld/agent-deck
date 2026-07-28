import type { JSX } from 'react';

interface Summary {
  badges: Array<{ text: string; title: string }>;
  description: string;
  promptPreview: string;
}

export function describeAgentTool(input: unknown): Summary {
  const value = input && typeof input === 'object'
    ? input as Record<string, unknown>
    : {};
  const badges: Summary['badges'] = [];
  const add = (text: string, title: string): void => {
    if (text) badges.push({ text, title });
  };
  const text = (key: string): string => typeof value[key] === 'string' ? value[key] as string : '';
  const subagentType = text('subagent_type');
  const taskName = text('task_name');
  const agentType = text('agent_type');
  const target = text('target') || text('id');
  const operation = text('collab_tool');
  const model = text('model');
  const reasoning = text('reasoning_effort') || text('model_reasoning_effort');
  const forkTurns = text('fork_turns');
  const serviceTier = text('service_tier');
  const pathPrefix = text('path_prefix');
  const receiverIds = Array.isArray(value.receiver_thread_ids)
    ? value.receiver_thread_ids.filter((item): item is string => typeof item === 'string')
    : [];
  const targets = receiverIds.length > 0
    ? receiverIds
    : Array.isArray(value.targets)
      ? value.targets.filter((item): item is string => typeof item === 'string')
      : [];
  add(subagentType ? `→ ${subagentType}` : '', `协作者类型：${subagentType}`);
  add(taskName ? `任务 ${taskName}` : agentType ? `类型 ${agentType}` : '', taskName || agentType);
  add(target ? `→ ${target}` : '', `目标：${target}`);
  add(operation, `协作操作：${operation}`);
  add(
    model || reasoning ? `${model || '默认模型'}${reasoning ? ` · ${reasoning}` : ''}` : '',
    `模型：${model || '默认'}；推理强度：${reasoning || '默认'}`,
  );
  add(targets.length > 0 ? `${targets.length} 个目标` : '', `目标：${targets.join(', ')}`);
  add(forkTurns ? `fork_turns=${forkTurns}` : '', `fork_turns：${forkTurns}`);
  add(serviceTier ? `service_tier=${serviceTier}` : '', `service_tier：${serviceTier}`);
  add(pathPrefix ? `范围 ${pathPrefix}` : '', `范围：${pathPrefix}`);
  add(value.interrupt === true ? '先中断' : '', '先中断目标');
  if (typeof value.timeout_ms === 'number' && Number.isFinite(value.timeout_ms)) {
    const milliseconds = value.timeout_ms;
    const formatted = milliseconds >= 1000 && milliseconds % 1000 === 0
      ? `${milliseconds / 1000} 秒`
      : `${milliseconds} 毫秒`;
    add(`超时 ${formatted}`, `timeout_ms：${milliseconds}`);
  }
  const prompt = text('prompt');
  return {
    badges,
    description: text('description'),
    promptPreview: prompt.replace(/\s+/g, ' ').trim().slice(0, 80)
      + (prompt.length > 80 ? '…' : ''),
  };
}

export function AgentToolSummary({ input }: { input: unknown }): JSX.Element | null {
  const summary = describeAgentTool(input);
  if (
    summary.badges.length === 0
    && !summary.description
    && !summary.promptPreview
  ) return null;
  return (
    <div className="mt-1 min-w-0 space-y-1 pr-12">
      {summary.badges.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1">
          {summary.badges.map((badge, index) => (
            <span
              key={`${badge.text}-${index}`}
              className="max-w-full truncate rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted"
              title={badge.title}
            >
              {badge.text}
            </span>
          ))}
        </div>
      )}
      {summary.description && (
        <div className="truncate text-[10px] text-deck-muted/85" title={summary.description}>
          {summary.description}
        </div>
      )}
      {summary.promptPreview && (
        <div className="truncate text-[10px] text-deck-muted/70">
          {summary.promptPreview}
        </div>
      )}
    </div>
  );
}
