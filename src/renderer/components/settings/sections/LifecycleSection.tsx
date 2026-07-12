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
        label="空闲多久后休眠（分钟）"
        value={Math.round(settings.activeWindowMs / 60000)}
        min={1}
        onChange={(v) => void update({ activeWindowMs: v * 60_000 })}
      />
      <NumberInput
        label="休眠多久后关闭（小时）"
        value={Math.round(settings.closeAfterMs / 3600000)}
        min={1}
        onChange={(v) => void update({ closeAfterMs: v * 3_600_000 })}
      />
      <NumberInput
        label="待处理请求超时（分钟，0 = 不超时）"
        value={Math.round(settings.permissionTimeoutMs / 60000)}
        min={0}
        onChange={(v) => void update({ permissionTimeoutMs: v * 60_000 })}
      />
      <NumberInput
        label="历史会话保留天数（0 = 永久）"
        value={settings.historyRetentionDays}
        min={0}
        onChange={(v) => void update({ historyRetentionDays: v })}
      />
      {/* plan issue-tracker-mcp-20260529 §Step 3.9 §D13 GC 阈值：与 historyRetentionDays 同款
          GC 性质,挂同 section 让用户一站式找到所有 GC 阈值（IssueLifecycleScheduler 6h tick） */}
      <NumberInput
        label="已解决 Issue 保留天数（0 = 不清理）"
        value={settings.issueResolvedRetentionDays}
        min={0}
        onChange={(v) => void update({ issueResolvedRetentionDays: v })}
      />
      <NumberInput
        label="已删除 Issue 保留天数（0 = 不清理）"
        value={settings.issueSoftDeletedRetentionDays}
        min={0}
        onChange={(v) => void update({ issueSoftDeletedRetentionDays: v })}
      />
      {/* plan message-retention-and-index-20260602 §D3：agent_deck_messages retention GC，与
          historyRetentionDays / issue GC 同款性质挂同 section（MessageLifecycleScheduler 6h tick，
          删超期 terminal 消息，pending/delivering 永不删） */}
      <NumberInput
        label="跨会话消息保留天数（0 = 不清理）"
        value={settings.messageRetentionDays}
        min={0}
        onChange={(v) => void update({ messageRetentionDays: v })}
      />
    </Section>
  );
}
