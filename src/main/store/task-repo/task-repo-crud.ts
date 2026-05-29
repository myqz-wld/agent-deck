/**
 * Task Manager 持久层 CRUD 子模块（plan task-team-id-restore-20260525 v024）。
 *
 * 提供基础 CRUD method:create / get / update。
 *
 * - **get**：单条 SELECT,委托 `_deps.getById` 跨子模块共享同款实现
 * - **create**：subject / ownerSessionId 存在性校验 + 默认值填充 + 单 INSERT
 * - **update**：增量 UPDATE,patch 显式 undefined 视为「不动」,显式 null 视为「清空」;
 *   ownerSessionId 在 patch 里出现主动忽略（tool 层闭包锁设计）;UPDATABLE_KEYS 列白名单
 *
 * 4 子模块 factory pattern:`createCrud(db)` 返回 { create, get, update },由 facade
 * `task-repo.ts` 装配进 createTaskRepo 主 factory。create/update 不依赖其他子模块,
 * delete 子模块通过 `_deps.getById` 拿到同款 SELECT 实现避免重复 SQL。
 */
import type { Database } from 'better-sqlite3';
import type { TaskRecord } from '@shared/types';
import {
  type TaskCreateInput,
  COL_MAP,
  UPDATABLE_KEYS,
  getById,
  toColumnValue,
} from './_deps';

export interface TaskCrudOps {
  create(input: TaskCreateInput): TaskRecord;
  get(id: string): TaskRecord | null;
  update(id: string, patch: Partial<TaskCreateInput>): TaskRecord | null;
}

export function createCrud(db: Database): TaskCrudOps {
  function get(id: string): TaskRecord | null {
    return getById(db, id);
  }

  function create(input: TaskCreateInput): TaskRecord {
    const subject = (input.subject ?? '').toString();
    if (!subject.trim()) {
      // store 层只做存在性校验，长度 / 字符集校验留给 tool 层 zod schema
      throw new Error('subject 不能为空');
    }
    const ownerSessionId = (input.ownerSessionId ?? '').toString();
    if (!ownerSessionId) {
      // v023 plan §不变量 1：task 必有 owner_session_id，repo 层兜底校验
      throw new Error('ownerSessionId 必填');
    }
    const now = new Date().toISOString();
    const rec: TaskRecord = {
      id: crypto.randomUUID(),
      ownerSessionId,
      teamId: input.teamId ?? null, // v024 plan §D1 + D2:不传 = personal task
      subject,
      description: input.description ?? null,
      status: input.status ?? 'pending',
      activeForm: input.activeForm ?? null,
      priority: input.priority ?? 5,
      blocks: input.blocks ?? [],
      blockedBy: input.blockedBy ?? [],
      labels: input.labels ?? [],
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(
      `INSERT INTO tasks
       (id, owner_session_id, team_id, subject, description, status, active_form, priority,
        blocks, blocked_by, labels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.id,
      rec.ownerSessionId,
      rec.teamId,
      rec.subject,
      rec.description,
      rec.status,
      rec.activeForm,
      rec.priority,
      JSON.stringify(rec.blocks),
      JSON.stringify(rec.blockedBy),
      JSON.stringify(rec.labels),
      rec.createdAt,
      rec.updatedAt,
    );
    return rec;
  }

  function update(id: string, patch: Partial<TaskCreateInput>): TaskRecord | null {
    const existing = get(id);
    if (!existing) return null;

    // 用 hasOwn 区分「显式传了 undefined」和「没传」：JSON 序列化场景下两者都是
    // key 不存在，所以本接口约定 undefined === 不动；想清空字段必须显式传 null。
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of UPDATABLE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      // subject 同 create：repo 层只挡 trim 后空字符串，长度等留给 tool 层 zod
      if (key === 'subject' && (!value || !String(value).trim())) {
        throw new Error('subject 不能更新为空');
      }
      sets.push(`${COL_MAP[key]} = ?`);
      params.push(toColumnValue(key, value));
    }
    if (sets.length === 0) {
      // patch 全是 ownerSessionId 或空：直接返回 existing 不改 updated_at
      return existing;
    }
    const updatedAt = new Date().toISOString();
    sets.push('updated_at = ?');
    params.push(updatedAt);
    params.push(id);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return get(id);
  }

  return { create, get, update };
}
