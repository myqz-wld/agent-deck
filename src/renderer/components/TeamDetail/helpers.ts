/**
 * plan team-cohesion-fix-20260513 Phase C：TeamDetail 子组件共用纯函数。
 * 全部 module-level，无 React state，便于子组件 import。
 */
/** 折叠过长 cwd / 路径:>4 段时只保留最后 3 段。 */
export function shortenPath(p: string | null | undefined): string {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 4) return p;
  return '…/' + parts.slice(-3).join('/');
}

/** 时间戳 → 相对时间(如「3 分钟前」/「刚刚」),用于 events / messages / tasks 列表显示。 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  // REVIEW_107 LOW（防御护栏）：非 finite 输入（典型 TasksSection 走 Date.parse(updatedAt)，
  // 非法 ISO → NaN）会让下方 Math.max(0,NaN)=NaN、所有区间比较 false → 落到末尾 `NaN 天前`。
  // events `e.ts` / messages `msg.sentAt` 是 number 直传安全，Date.parse 是唯一 NaN 注入口；
  // 当前 repo 保证 updatedAt 合法 ISO 不可达，集中在共享 helper 兜底让三个 caller 全受益。
  if (!Number.isFinite(ts)) return '';
  const dt = Math.max(0, now - ts);
  if (dt < 5_000) return '刚刚';
  if (dt < 60_000) return `${Math.floor(dt / 1_000)} 秒前`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)} 分钟前`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)} 小时前`;
  return `${Math.floor(dt / 86_400_000)} 天前`;
}

/** lifecycle 枚举 → 中文标签(active=进行中 / dormant=已休眠 / closed=已结束)。 */
export function lifecycleLabel(lifecycle: string | null | undefined): string {
  switch (lifecycle) {
    case 'active':
      return '进行中';
    case 'dormant':
      return '已休眠';
    case 'closed':
      return '已结束';
    default:
      return lifecycle ?? '?';
  }
}

/** role 枚举 → 中文标签(lead=负责人 / teammate=协作者)。 */
export function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case 'lead':
      return '负责人';
    case 'teammate':
      return '协作者';
    default:
      return role ?? '?';
  }
}

/** agentId → 中文显示标签（claude-code → Claude / codex-cli → Codex / null → 未知）。
 *  统一让会话列表 / 团队成员等所有 user-visible 位置不再露出 raw adapter id。 */
export function agentIdLabel(agentId: string | null | undefined): string {
  switch (agentId) {
    case 'claude-code':
      return 'Claude';
    case 'codex-cli':
      return 'Codex';
    case 'grok-build':
      return 'Grok';
    default:
      return agentId ?? '未知';
  }
}

/** AgentEventKind → 中文事件标签（10+ 枚举翻译,activity-feed/describe.ts 与本 helper 同源
 *  但目的不同 — describe.ts 给单行摘要含 emoji+payload,本 helper 仅给 badge 短词）。 */
export function eventKindLabel(kind: string, agentId?: string | null): string {
  switch (kind) {
    case 'session-start':
      return '会话开始';
    case 'session-end':
      return '会话结束';
    case 'tool-use-start':
      return '调用工具';
    case 'tool-use-end':
      return '工具完成';
    case 'file-changed':
      return '文件改动';
    case 'message':
      return '消息';
    case 'thinking':
      return agentId === 'codex-cli' ? 'REASONING SUMMARY' : 'THINKING';
    case 'waiting-for-user':
      return '等待响应';
    case 'finished':
      return '一轮完成';
    case 'team-task-created':
      return '团队任务创建';
    case 'team-task-completed':
      return '团队任务完成';
    case 'team-teammate-idle':
      return '协作者空闲';
    case 'team-permission-requested':
      return '权限请求';
    case 'team-permission-resolved':
      return '权限处理完成';
    default:
      return kind;
  }
}
