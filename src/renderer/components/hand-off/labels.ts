import type {
  SessionHandOffExecutionFailure,
  SessionHandOffPreparation,
} from '@shared/types';

export function qualityLabel(
  quality: SessionHandOffPreparation['quality'],
): string {
  switch (quality) {
    case 'full':
      return '续接内容覆盖完整';
    case 'projected':
      return '续接内容已适配新会话';
    case 'coverage-gap':
      return '部分历史未包含';
    case 'raw-only':
      return '仅包含可用用户消息';
    case 'instruction-only':
      return '仅包含下一步指令';
  }
}

export function warningLabel(code: string): string | null {
  const labels: Record<string, string> = {
    'checkpoint-generation-failed': '续接摘要生成失败，本次将使用可用的会话内容。',
    'checkpoint-repair-failed': '续接摘要更新失败，本次将使用上一个可用摘要。',
    'checkpoint-projected': '续接摘要已缩短，以适应新会话。',
    'coverage-gap': '部分历史内容未包含在本次续接上下文中。',
    'legacy-wrapper-excluded': '部分旧版续接内容无法确认，未包含在本次上下文中。',
    'legacy-wrapper-unwrapped': '旧版续接内容中仅保留了可确认的用户指令。',
    'raw-boundary-truncated': '最早保留的一条用户消息只包含末尾部分。',
    'raw-history-omitted': '较早的部分消息未包含在本次续接上下文中。',
    'checkpoint-omitted': '续接摘要过长，未能包含在本次上下文中。',
    'target-capacity-fallback': '无法确认新会话可容纳的内容量，已按较小范围准备。',
    'instruction-only': '没有可用的历史内容，本次只包含下一步指令。',
    'spool-resource-guard': '历史内容超过处理上限，节选中已标出未覆盖范围。',
  };
  return labels[code] ?? null;
}

export function executionFailureLabel(
  failure: SessionHandOffExecutionFailure,
): string {
  const deliveryFailed = failure.cutoverReason === 'late-message-delivery-failed';
  const failureOutcome = deliveryFailed
    ? '新增消息未能转交'
    : failure.stage === 'cutover'
      ? '源会话切换未完成'
      : '必要内容未能转移';
  if (failure.successorCleanup === 'failed') {
    return (
      `续接会话已创建，但${failureOutcome}，且未能自动关闭。它可能仍在运行。` +
      '请先在会话列表中找到并关闭刚创建的续接会话，确认关闭后再重新生成续接上下文，' +
      '避免产生更多孤儿会话。'
    );
  }
  if (deliveryFailed) {
    return (
      '续接会话已创建，但新增消息未能转交。该会话已自动关闭，源会话仍可继续使用；' +
      '请重新生成续接上下文后再试。'
    );
  }
  return `续接会话已创建，但${failureOutcome}。该会话已自动关闭；请重新生成续接上下文后再试。`;
}
