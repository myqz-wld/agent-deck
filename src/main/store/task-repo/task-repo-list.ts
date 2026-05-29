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
 * **空集 graceful degrade**:
 * - `visibleScope.teamIds=[]` → OR 退化为 `team_id IS NULL AND owner_session_id = callerSid`
 * - `ownerSessionIds=[]` → 0 行（SQL IN () 在 SQLite 里语法错）
 * - 任一 IN 子句长度 > 500 → 短路返 0 行（SQLite IN 999 上限防御）
 *
 * **subject LIKE 转义**:`%` `_` `\` 三个 wildcard 字符 escape + 加 ESCAPE '\' 让搜索语义
 * 对齐用户预期（用户输入 `100%` 实际意图是搜「100%」字符,不是「以 100 开头」）。
 */
import type { Database } from 'better-sqlite3';
import type { TaskRecord } from '@shared/types';
import { type Row, type TaskListOptions, rowToRecord } from './_deps';

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
        // F2 同款 SQLite IN 999 上限防御 — caller 同 active team 数 > 500 极端病态场景
        console.warn(
          `[task-repo] listTasks: visibleScope.teamIds 长度 ${teamIds.length} 超 SQLite IN 上限 500,` +
            `返回空集 graceful degrade;caller 应清理历史 dormant teams 或 task-list handler 拆批。`,
        );
        return [];
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
          console.warn(
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
    const rows = db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    return rows.map(rowToRecord);
  }

  return { list };
}
