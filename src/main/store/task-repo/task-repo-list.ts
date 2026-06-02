/**
 * Task Manager 持久层 list 子模块（plan task-team-id-restore-20260525 v024）。
 *
 * 提供 list method 走 caller 可见 scope OR 模式 / ownerSessionIds + teamIdFilter 组合 AND
 * 模式（互斥）+ subject LIKE 模糊匹配 + status 精确匹配 + LIMIT/OFFSET 分页。
 *
 * **三态分流（plan §D5 + Step C5）**:
 * - `visibleScope` 优先（caller 视角一次 SQL OR 拿可见 team task + 自己 personal task）
 * - 不走 visibleScope → `ownerSessionIds` + `teamIdFilter` 组合（v023 兼容路径）
 * - 都不传 → 全部 task（管理员级别）
 *
 * **空集 / 降级 graceful degrade**:
 * - `visibleScope.teamIds=[]` → OR 退化为 `team_id IS NULL AND owner_session_id = callerSid`
 * - `visibleScope.teamIds>500` → 退化为仅 personal task（同 teamIds=[] 分支,保 caller
 *   可见性契约不丢 personal;REVIEW_106 LOW fix,旧实现此分支错误 return [] 连 personal 都丢）
 * - `ownerSessionIds=[]` → 0 行（SQL IN () 在 SQLite 里语法错）
 * - `ownerSessionIds>500` → 短路返 0 行（SQLite IN 999 上限防御;此分支是「显式 owner 过滤」
 *   admin 语义,handler 实际只传 [callerSid] 长度恒 1,>500 不可达,与 visibleScope 不对称合理）
 *
 * **subject LIKE 转义**:`%` `_` `\` 三个 wildcard 字符 escape + 加 ESCAPE '\' 让搜索语义
 * 对齐用户预期（用户输入 `100%` 实际意图是搜「100%」字符,不是「以 100 开头」）。
 * **大小写不敏感仅 ASCII**（REVIEW_106 LOW）:列侧 SQLite `LOWER()` ASCII-only,非 ASCII
 * 大写字符不折叠 → 非 ASCII subject case-insensitive 搜索失效,best-effort 不上 ICU。
 */
import type { Database } from 'better-sqlite3';
import type { TaskRecord } from '@shared/types';
import { type Row, type TaskListOptions, rowToRecord } from './_deps';
import log from '@main/utils/logger';

const logger = log.scope('task-repo-list');

export interface TaskListOps {
  list(opts?: TaskListOptions): TaskRecord[];
}

export function createList(db: Database): TaskListOps {
  function list(opts: TaskListOptions = {}): TaskRecord[] {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      wheres.push('status = ?');
      params.push(opts.status);
    }
    if (opts.subjectKeyword) {
      // REVIEW_61 LOW-β (codex) fix: subject LIKE 把用户输入直接包进 pattern,`%` 与 `_`
      // 会被当 SQL wildcard 解释让搜索语义错误(用户输入 `100%` 实际意图是搜「100%」字符,
      // 旧实现等价 `任意以 100 开头`)。escape `%` `_` `\` 三个 wildcard 字符 + 加 ESCAPE '\'。
      // 不是 SQL injection (param 绑定挡住),只是搜索语义对齐用户预期。
      //
      // REVIEW_106 LOW（reviewer-claude 单方 + lead sqlite3 3.43 实证 `LOWER('Ärger')`='Ärger'）:
      // **大小写不敏感仅对 ASCII A-Z 生效**。param 侧 JS `toLowerCase()` 是 Unicode-aware 折叠
      // （'Ä'→'ä'）,列侧 SQLite 内置 `LOWER()` 是 ASCII-only（'Ä' 不变）→ 非 ASCII subject 的
      // 大写字符永不匹配（param 已折叠成小写,列侧未折叠）。属 best-effort 搜索 gap,不影响数据
      // 正确性,不上 ICU extension（重依赖）。如需全 Unicode case-insensitive 搜索需 LIKE 双侧
      // 一致 fold 或 ICU,当前接受 ASCII-only 限制。
      const escaped = opts.subjectKeyword
        .toLowerCase()
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      wheres.push("LOWER(subject) LIKE ? ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }
    // v024 plan §D5 + Step C5:visibleScope OR 模式优先于 ownerSessionIds + teamIdFilter
    //（task-list handler 三态分流时显式只传一个,visibleScope 与其他两个互斥）。
    if (opts.visibleScope !== undefined) {
      const { teamIds, callerSid } = opts.visibleScope;
      if (teamIds.length === 0) {
        // 空 teamIds → OR 退化为仅 personal task 分支:`team_id IS NULL AND owner_session_id = ?`
        wheres.push('(team_id IS NULL AND owner_session_id = ?)');
        params.push(callerSid);
      } else if (teamIds.length > 500) {
        // REVIEW_106 LOW fix（reviewer-codex 单方 + lead 现场核实 handler 默认走 visibleScope）:
        // visibleScope 契约 = 「caller 可见 team task ∪ caller 自己 personal task」。teamIds > 500
        // （caller 同 active team 数超 SQLite IN 上限,极端病态）旧实现直接 `return []` 连 caller
        // **自己的 personal task 也一并丢失** = 破坏可见性契约（不只是性能降级）。改为退化到
        // personal-only 分支（与 teamIds.length === 0 同款）:放弃 team-bound task 命中（caller
        // 应清理历史 dormant teams / handler 拆批）,但 personal task 仍可见,契约最小保真。
        logger.warn(
          `[task-repo] listTasks: visibleScope.teamIds 长度 ${teamIds.length} 超 SQLite IN 上限 500,` +
            `退化为仅 personal task（team-bound task 本次不返）;caller 应清理历史 dormant teams 或 task-list handler 拆批。`,
        );
        wheres.push('(team_id IS NULL AND owner_session_id = ?)');
        params.push(callerSid);
      } else {
        const placeholders = teamIds.map(() => '?').join(',');
        // 完整 OR 模式:`(team_id IN teamIds) OR (team_id IS NULL AND owner_session_id = callerSid)`
        // 拿 caller 可见 team-bound task + 自己 personal task 一次 SQL 完成。
        wheres.push(`(team_id IN (${placeholders}) OR (team_id IS NULL AND owner_session_id = ?))`);
        params.push(...teamIds, callerSid);
      }
    } else {
      // 不走 visibleScope → 走 ownerSessionIds + teamIdFilter 组合 AND 过滤（v023 兼容路径）
      //
      // v023 plan §D6:owner_session_id IN 过滤。空数组直接短路返 0 行
      //（SQL IN () 在 SQLite 里语法错，且语义上空集合本就 0 命中）。
      if (Array.isArray(opts.ownerSessionIds)) {
        if (opts.ownerSessionIds.length === 0) {
          return [];
        }
        // F2 fix (deep-review-changelog146-20260524 R1 claude MED) — 详见原版本注释,沿用
        if (opts.ownerSessionIds.length > 500) {
          logger.warn(
            `[task-repo] listTasks: ownerSessionIds 长度 ${opts.ownerSessionIds.length} 超 SQLite IN 上限 500,` +
              `返回空集 graceful degrade;caller 应清理历史 dormant session 或拆批查询。`,
          );
          return [];
        }
        const placeholders = opts.ownerSessionIds.map(() => '?').join(',');
        wheres.push(`owner_session_id IN (${placeholders})`);
        params.push(...opts.ownerSessionIds);
      }
      // v024 plan §D5:team_id 三态 filter（visibleScope 模式下忽略 teamIdFilter,仅这里生效）
      if (opts.teamIdFilter !== undefined) {
        if (opts.teamIdFilter === 'null-personal') {
          wheres.push('team_id IS NULL');
        } else {
          // string (team uuid)
          wheres.push('team_id = ?');
          params.push(opts.teamIdFilter);
        }
      }
    }
    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    // REVIEW_106 MED fix（lead 预备 + reviewer-claude + reviewer-codex 三重独立命中,
    // 真 SQLite 3.43 + EXPLAIN QUERY PLAN + 分页 repro 实证）:`updated_at` 用
    // `new Date().toISOString()` 写（crud.ts:47/109），毫秒内连续 create/update 极易撞
    // 同值（plan workflow 批量建/改 task）。仅 `ORDER BY updated_at DESC` 对同毫秒簇无
    // total order — SQLite 实测返回 rowid-ASC（最旧在前）**恰与 jsdoc「newest-first」相反**，
    // 且跨 SQLite 版本 / 索引可用性可变；带 LIMIT/OFFSET 分页时同毫秒边界行可能跨页漏/重。
    // 加 `rowid DESC` 次级排序根除（复发主题第 5 次,REVIEW_84/89/90/91 同款修法）。
    // **必须 rowid 不能 id**:tasks.id 是 crypto.randomUUID() 随机值无插入序单调性,
    // `id DESC` tie 内仍乱序（REVIEW_90 关键陷阱）;tasks 是 `id TEXT PRIMARY KEY` 非
    // WITHOUT ROWID 表 → 有隐式单调 rowid 可用。
    //
    // **rowid DESC vs ASC 取舍**（R2 reviewer-claude INFO,lead EXPLAIN 实证）:复合索引
    // `(updated_at, rowid)` 建不出来（SQLite 拒绝具名 rowid 列）。现有 idx_tasks_updated_at
    // 隐含尾随 rowid ASC → `rowid ASC` 可走索引直出免 TEMP B-TREE,但同毫秒簇变 oldest-first;
    // `rowid DESC`（当前选择）方向与索引相反退化 TEMP B-TREE FOR RIGHT PART,但同毫秒簇是
    // newest-first 与 jsdoc 语义自洽（对齐 REVIEW_90 messages list 先例）。TEMP B-TREE 仅打
    // 裸 list() admin 路径(带 status/visibleScope 的真实 handler 查询本就走 temp),task 表
    // 规模小可忽略 → 语义一致性优先选 rowid DESC。未来表增大且裸 list 成热点可改 rowid ASC。
    const rows = db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    return rows.map(rowToRecord);
  }

  return { list };
}
