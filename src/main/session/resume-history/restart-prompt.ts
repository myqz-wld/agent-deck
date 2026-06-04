import type { AgentEvent } from '@shared/types';
import type { AgentName } from '@main/session/oneshot-llm';
import { settingsStore } from '@main/store/settings-store';
import { injectResumeHistory } from './inject-history';

const RESTART_SUMMARY_HEADER =
  '===== 历史会话摘要（由应用 DB 历史自动生成，用于重启后恢复上下文）=====';
const RESTART_CURRENT_HEADER = '===== 应用内部重启指令 =====';

export interface BuildRestartResumePromptOptions {
  sessionId: string;
  originalText: string;
  cwd: string;
  maxLength: number;
  agentName: AgentName;
  summariseFn: (cwd: string, events: AgentEvent[]) => Promise<string | null>;
  listEventsFn: (sessionId: string) => AgentEvent[];
  listMessagesFn: (
    sessionId: string,
    limit: number,
    beforeIdInclusive?: number,
  ) => (AgentEvent & { id: number })[];
}

export async function buildRestartResumePrompt(
  opts: BuildRestartResumePromptOptions,
): Promise<string> {
  const result = await injectResumeHistory({
    sessionId: opts.sessionId,
    originalText: opts.originalText,
    cwd: opts.cwd,
    recentMessagesCount: settingsStore.get('resumeRecentMessagesCount'),
    maxLength: opts.maxLength,
    agentName: opts.agentName,
    maxEventIdFn: () => null,
    summariseFn: opts.summariseFn,
    listEventsFn: opts.listEventsFn,
    listMessagesFn: opts.listMessagesFn,
    summaryHeader: RESTART_SUMMARY_HEADER,
    currentHeader: RESTART_CURRENT_HEADER,
  });

  if (result.failReason === 'original-over-length') {
    throw new Error(
      `单条消息 ${opts.originalText.length.toLocaleString()} 字符超过 ${opts.maxLength.toLocaleString()} 字符上限，无法作为 restart 首条 prompt。请精简或拆分发送。`,
    );
  }

  return result.prompt;
}
