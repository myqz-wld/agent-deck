export interface TurnOutcome {
  text: string;
  icon: 'success' | 'interrupted' | 'cancelled' | 'error';
}

/** Keep the live card and detail feed aligned on provider terminal outcomes. */
export function turnOutcome(payload: Record<string, unknown>): TurnOutcome {
  const subtype = typeof payload.subtype === 'string' ? payload.subtype.trim() : '';
  if (subtype === 'interrupted') return { text: '一轮已中断', icon: 'interrupted' };
  if (['cancelled', 'canceled', 'aborted'].includes(subtype)) {
    return { text: '一轮已取消', icon: 'cancelled' };
  }
  if (payload.ok === false) {
    const reason = payload.failureReason === 'context-window-exceeded' ? '上下文已达到上限'
      : subtype === 'rate_limit' ? '达到速率限制' : subtype;
    return { text: `一轮失败${reason ? ` · ${reason}` : ''}`, icon: 'error' };
  }
  return { text: '一轮完成', icon: 'success' };
}
