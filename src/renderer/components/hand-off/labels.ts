import type {
  SessionHandOffExecutionFailure,
  SessionHandOffPreparation,
} from '@shared/types';

export function qualityLabel(
  quality: SessionHandOffPreparation['quality'],
): string {
  switch (quality) {
    case 'full':
      return '完整检查点';
    case 'projected':
      return '检查点已按目标容量投影';
    case 'coverage-gap':
      return '部分历史未覆盖';
    case 'raw-only':
      return '仅保留原始用户输入';
    case 'instruction-only':
      return '仅包含下一步指令';
  }
}

export function warningLabel(code: string): string {
  const labels: Record<string, string> = {
    'checkpoint-generation-failed': '续接检查点生成失败，已按可用历史降级。',
    'checkpoint-repair-failed': '续接检查点修复失败，已保留上一个有效结果。',
    'checkpoint-projected': '续接检查点已按目标上下文容量裁剪。',
    'coverage-gap': '部分事件修订未被续接检查点覆盖。',
    'legacy-wrapper-excluded': '已排除无法验证的旧版续接包装内容。',
    'legacy-wrapper-unwrapped': '已从旧版续接内容中仅保留权威用户指令。',
    'raw-boundary-truncated': '最早保留的用户输入已在 UTF-8 边界安全截断。',
    'raw-history-omitted': '部分较早的用户输入未能放入目标上下文预算。',
    'checkpoint-omitted': '续接检查点未能放入目标投影预算。',
    'target-capacity-fallback': '目标模型容量尚未观测，已采用保守容量。',
    'instruction-only': '没有可验证的历史，仅发送下一步指令。',
    'spool-resource-guard': '不可变历史快照达到资源上限，覆盖范围已明确标记。',
  };
  return labels[code] ?? `会话续接上下文已降级（${code}）。`;
}

export function executionFailureLabel(
  failure: SessionHandOffExecutionFailure,
): string {
  const deliveryFailed = failure.cutoverReason === 'late-message-delivery-failed';
  const stageLabel = deliveryFailed
    ? '新增消息转交'
    : failure.stage === 'cutover'
      ? '源会话切换前检查'
      : '必要资源转移';
  const cleanupLabel = failure.successorCleanup === 'failed' ? '自动关闭失败' : '已自动关闭';
  const prefix =
    `续接会话 ${failure.successorSessionId} 已创建，但${stageLabel}失败` +
    `（阶段：${stageLabel}；清理状态：${cleanupLabel}）。`;
  if (failure.successorCleanup === 'failed') {
    return (
      `${prefix}自动关闭该会话也失败，它可能仍在运行。` +
      `请先找到并关闭会话 ${failure.successorSessionId}，确认关闭后再重新生成续接上下文，` +
      '避免产生更多孤儿会话。'
    );
  }
  if (deliveryFailed) {
    return (
      `${prefix}该会话已自动关闭，源会话仍可继续使用。` +
      '请检查目标 adapter 的消息队列容量和附件可读性后再试。'
    );
  }
  return `${prefix}该会话已自动关闭；请重新生成续接上下文后再试。`;
}
