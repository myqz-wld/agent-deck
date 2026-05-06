import type { JSX } from 'react';
import type { ActivityState, LifecycleState } from '@shared/types';

interface Props {
  activity: ActivityState;
  lifecycle: LifecycleState;
  /** 归档与生命周期正交：传入即覆盖样式为「归档」。 */
  archived?: boolean;
}

/**
 * 状态徽标。颜色 / 动画依据 activity & lifecycle 的组合：
 * - waiting: 红色脉冲 + 闪烁  → 控制权在人手里
 * - working: 绿色脉冲          → agent 在执行
 * - finished: 黄色稳定         → 一轮完成
 * - idle:    灰色               → 已注册但未动作
 * - dormant: 暗灰               → 长时间无事件
 * - closed:  划线灰             → 历史
 * - archived(任意 lifecycle 上的标记): 同 closed 灰
 *
 * 术语约定（CHANGELOG_57 B4，与设置面板对齐）：lifecycle 三态在 UI 层显示
 * 「活跃 / 休眠 / 关闭」，title / aria-label 必须用中文，不直接裸用 closed/dormant。
 */
export function StatusBadge({ activity, lifecycle, archived }: Props): JSX.Element {
  if (archived || lifecycle === 'closed') {
    return (
      <span
        className="inline-block h-2 w-2 rounded-full bg-status-closed"
        title={archived ? '已归档' : '关闭'}
      />
    );
  }
  if (lifecycle === 'dormant') {
    return (
      <span
        className="inline-block h-2 w-2 rounded-full bg-status-dormant"
        title="休眠"
      />
    );
  }
  switch (activity) {
    case 'waiting':
      return (
        <span
          className="inline-block h-2.5 w-2.5 rounded-full bg-status-waiting"
          style={{ animation: 'pulse-red 1.2s ease-in-out infinite' }}
          title="等待你的输入"
        />
      );
    case 'working':
      return (
        <span
          className="inline-block h-2.5 w-2.5 rounded-full bg-status-working"
          style={{ animation: 'pulse-green 1.6s ease-in-out infinite' }}
          title="正在执行"
        />
      );
    case 'finished':
      return (
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-status-finished" title="一轮完成" />
      );
    case 'idle':
    default:
      return (
        <span className="inline-block h-2 w-2 rounded-full bg-status-idle" title="空闲" />
      );
  }
}
