/**
 * 跨进程共享：Issue Tracker 类型（plan issue-tracker-mcp-20260529 §D9 / D7 / D15 / D16 / D17）。
 *
 * agent 上报问题机制（report_issue + append_issue_context + update_issue_status 三个 mcp write
 * tool）+ UI 顶层 Issues tab 看板的统一类型 SSOT。设计要点（详 plan §不变量 + §D 决策表）:
 *
 * - **DB column SSOT snake_case**（sessions / agent_deck_teams 表惯例）；TS 内部 / mcp tool
 *   args 全 camelCase（§D18 + CHANGELOG_177 32 字段全栈同步收口）。repo / handler 层做映射
 * - **timestamp 用 INTEGER epoch ms**（与 sessions / agent_deck_teams 一致；不与 tasks 表
 *   TEXT ISO8601 对齐）— §D9 决策。created_at / updated_at / resolved_at / deleted_at /
 *   appended_at / logsRef.tsRange.{start,end} 全 epoch ms
 * - **status 严格 3 态**（§D7）：open（默认）/ in-progress / resolved；status 写入受限 ——
 *   issue 的源会话 / 解决会话可通过 update_issue_status mcp tool 自助推进，UI 端 IPC IssuesUpdate
 *   也可改（zod 严格 enum reject 其他值）；其余字段仍仅 UI admin。
 * - **kind 软枚举 + free-form fallback**（§D6）：2 个推荐值（follow-up / app-bug）+ 任意其他
 *   string 原样落库；UI 端按字符串完全匹配分组，不在枚举内 → 'other' 分组（**不**自动 normalize）
 * - **severity 严格 enum**（§D9）：low / medium / high
 * - **logsRef 是定位指针不是日志体**（§不变量 4 / §D2 / §D17）：UI 端按 logsRef.date 拼
 *   日志文件路径自助读（runtime-logging-electron-log-20260529 plan §D2 / §D3 SSOT）
 */

/**
 * §D7：status 严格 3 态。写入受限：源 / 解决会话经 update_issue_status mcp tool 自助推进，
 * 或 UI 端 IPC IssuesUpdate（两路都经 zod 严格 enum reject 其他值）。
 */
export type IssueStatus = 'open' | 'in-progress' | 'resolved';

/** §D9：severity 严格 enum。 */
export type IssueSeverity = 'low' | 'medium' | 'high';

/**
 * §D6：kind 软枚举（2 个推荐值）+ free-form fallback。
 * - `follow-up` — agent 自己留的后续事项
 * - `app-bug` — agent-deck 应用缺陷
 *
 * 类型上是 `string`，args.kind 不严格 enum 校验；非枚举值原样落库（**不**自动 normalize）。
 * 历史 issue 可能含其他 kind（如 external-tooling-bug / convention-gap / enhancement），
 * UI 端按字符串原样渲染，不受推荐值收敛影响。
 */
export type IssueKind =
  | 'follow-up'
  | 'app-bug'
  | string;

/**
 * §D2 / §D17：logsRef 严格 schema。
 * - `date` 必填 YYYY-MM-DD ISO 格式（zod 校验）
 * - `tsRange` 可选 epoch ms 区间，`start <= end`
 * - `scopes` 可选 string[]，max 32 项 / 单项 max 64 char
 * - `note` 可选 string，max 2000 char
 *
 * **D17 整 obj 全字段 null/undefined → mcp args zod reject**（caller 没意图传应该不传 args.logsRef）。
 */
export interface LogsRef {
  date: string;
  tsRange?: { start: number; end: number };
  scopes?: string[];
  note?: string;
}

/**
 * §D16：append 子表行。append_issue_context（源会话补现场）或 update_issue_status（源 / 解决
 * 会话改 status 时的可选 note）调用都会 INSERT 一行；UI detail 视图按 appendedAt asc 渲染
 * （read-only — agent 写的现场用户不改）。
 */
export interface IssueAppendix {
  id: number;
  issueId: string;
  body: string;
  logsRef: LogsRef | null;
  /**
   * 写入时 caller sid 快照；session GC 后 SET NULL。多数是 sourceSessionId（append_issue_context
   * 严格 source-bound），但 update_issue_status 的 note 可能由 resolutionSessionId 写入。
   */
  appendedSessionId: string | null;
  appendedAt: number;
}

/**
 * §D9：issue 主记录。in-process MCP `report_issue` / `append_issue_context` write tool 与
 * UI IPC 读 / 改 / 软删通道的统一返回形状。
 */
export interface IssueRecord {
  id: string;
  title: string;
  description: string;
  repro: string | null;
  kind: string;
  status: IssueStatus;
  severity: IssueSeverity;
  /** 上报 session id；FK SET NULL 让 issue 独立生命周期 §不变量 2 */
  sourceSessionId: string | null;
  /** 上报时 caller cwd 快照 */
  cwd: string | null;
  logsRef: LogsRef | null;
  /** UI「Resolve in new session」起独立 SDK session 后回写；FK SET NULL */
  resolutionSessionId: string | null;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  /** §D15 状态机：进 resolved 写 now / 离开保留 / 再次进刷新；非 resolved 时 null */
  resolvedAt: number | null;
  /** 软删时间戳；非 null = UI 列表默认隐藏，IssueLifecycleScheduler 超期硬删 §D13 */
  deletedAt: number | null;
  /**
   * 可选 appendices 列表（detail 视图带 / list 视图不带）。
   * IPC IssuesGet handler 拼上；mcp report_issue / append_issue_context handler 也带（让 UI
   * 端 emit 'issue-changed' kind='appended' 时直接拿到 全 record + 最新 appendices §D19）。
   */
  appendices?: IssueAppendix[];
}

/**
 * §Step 3.4.1：issue 写操作事件（main 进程 eventBus 'issue-changed' → IPC IssueChanged →
 * renderer issues-store 实时更新）。
 *
 * **顶级 `sourceSessionId` 字段**（§D7 R3 LOW F7 加 — 与 TaskChangedEvent.ownerSessionId 完全
 * 对称）：让 renderer 在 hardDeleted issue:null 时仍能拿到 sourceSessionId 决定 invalidate
 * 哪个 session 的 issues view（典型 SessionDetail tab 关联视图未来加）。
 *
 * **hardDeleted issue:null + 删前 snapshot 的 sourceSessionId**：record 已不存在，但事件载体
 * 必须告诉 renderer 是哪条 issue 哪个 source session 的 — 由 IssueLifecycleScheduler tick
 * 内 snapshot before delete 拿到（plan §Step 3.7.1）。
 */
export interface IssueChangedEvent {
  kind: 'created' | 'updated' | 'appended' | 'softDeleted' | 'undeleted' | 'hardDeleted';
  issueId: string;
  /** hardDeleted 时是 null；其他 kind 是新状态（含 appendices for created/appended） */
  issue: IssueRecord | null;
  /** 删前 snapshot.sourceSessionId 给 renderer 精细 invalidate（与 TaskChangedEvent.ownerSessionId 对称） */
  sourceSessionId: string | null;
  ts: number;
}
