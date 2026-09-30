import { assertFeishuMethod } from './client-pool';
import { validateSessionConsoleGetResult } from './core-output';
import { truncateUtf8 } from './redaction';
import type { ConnectedFeishuClient, FeishuGatewayLimits } from './types';

/** Cosmetic reads cannot prevent a provider reply or consume an approval callback's final budget. */
export async function readFeishuSessionTitle(connected: ConnectedFeishuClient, sessionId: string,
  limits: FeishuGatewayLimits, remaining: () => number): Promise<string | null> {
  try {
    const budget = Math.min(500, remaining() - 200);
    if (budget <= 0) return null;
    assertFeishuMethod(connected.hello, 'session.console.get');
    const raw = await connected.client.request('session.console.get', { sessionId }, { deadlineMs: budget });
    return validateSessionConsoleGetResult(raw, sessionId, limits).session?.title?.trim() || null;
  } catch { return null; }
}

export function feishuWorkName(title: string | null | undefined): string {
  return `工作会话 · ${truncateUtf8(title?.trim() || '未命名会话', 160)}`;
}

export function feishuSessionFooter(sessionId: string): string {
  return `会话 ID：${sessionId}`;
}
