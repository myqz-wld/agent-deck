import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, NumberInput } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export function LifecycleSection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="生命周期" storageKey="lifecycle" defaultOpen={true}>
      <NumberInput
        label="活跃 → 休眠 阈值（分钟）"
        value={Math.round(settings.activeWindowMs / 60000)}
        min={1}
        onChange={(v) => void update({ activeWindowMs: v * 60_000 })}
      />
      <NumberInput
        label="休眠 → 关闭 阈值（小时）"
        value={Math.round(settings.closeAfterMs / 3600000)}
        min={1}
        onChange={(v) => void update({ closeAfterMs: v * 3_600_000 })}
      />
      <NumberInput
        label="权限请求超时（秒，0 = 不超时）"
        value={Math.round(settings.permissionTimeoutMs / 1000)}
        min={0}
        onChange={(v) => void update({ permissionTimeoutMs: v * 1000 })}
      />
      <NumberInput
        label="历史会话保留（天，0 = 永久保留）"
        value={settings.historyRetentionDays}
        min={0}
        onChange={(v) => void update({ historyRetentionDays: v })}
      />
      {/* plan resume-inject-raw-messages-20260601 §D5：断连恢复（jsonl 丢失走 fresh CLI/thread）
          时除 LLM 总结外额外注入的最近原始对话消息条数。与 historyRetentionDays 同属「会话历史 /
          恢复」语义，挂同 section 让用户一站式找到。预算式拼接 → 实际注入条数 ≤ 设定值（长会话
          优先保最新对话不撑爆单条上限）。min=1：原始对话段是注入底线，0 会让整段注入退化无意义。 */}
      <NumberInput
        label="断连恢复注入对话条数"
        value={settings.resumeRecentMessagesCount}
        min={1}
        onChange={(v) => void update({ resumeRecentMessagesCount: v })}
      />
      {/* plan issue-tracker-mcp-20260529 §Step 3.9 §D13 GC 阈值：与 historyRetentionDays 同款
          GC 性质,挂同 section 让用户一站式找到所有 GC 阈值（IssueLifecycleScheduler 6h tick） */}
      <NumberInput
        label="Issue 已解决保留（天，0 = 关闭 GC）"
        value={settings.issueResolvedRetentionDays}
        min={0}
        onChange={(v) => void update({ issueResolvedRetentionDays: v })}
      />
      <NumberInput
        label="Issue 已软删保留（天，0 = 关闭 GC）"
        value={settings.issueSoftDeletedRetentionDays}
        min={0}
        onChange={(v) => void update({ issueSoftDeletedRetentionDays: v })}
      />
      {/* plan message-retention-and-index-20260602 §D3：agent_deck_messages retention GC，与
          historyRetentionDays / issue GC 同款性质挂同 section（MessageLifecycleScheduler 6h tick，
          删超期 terminal 消息，pending/delivering 永不删） */}
      <NumberInput
        label="跨会话消息保留（天，0 = 关闭 GC）"
        value={settings.messageRetentionDays}
        min={0}
        onChange={(v) => void update({ messageRetentionDays: v })}
      />
    </Section>
  );
}
