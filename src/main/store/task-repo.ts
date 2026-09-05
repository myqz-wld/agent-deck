/** SQLite task repository facade with injected and lazy default instances. */
import type { Database } from 'better-sqlite3';
import { getDb } from './db';
import {
  type TaskCreateInput,
  type TaskRepo,
} from './task-repo/_deps';
import { createCrud } from './task-repo/task-repo-crud';
import { createList } from './task-repo/task-repo-list';
import { createDelete } from './task-repo/task-repo-delete';
import { createHandoff } from './task-repo/task-repo-handoff';

// Types used by facade consumers.
export type {
  TaskCreateInput,
  TaskRepo,
};

/**
 * 主 factory:把 4 子模块组装成对外 TaskRepo 接口。
 *
 * 子模块共享 db: Database,各 createX(db) 返回独立 ops 对象,facade 这里 spread
 * 合并 + 把 createDelete 的 `delete` method 显式 wire 进 TaskRepo（避免与 JS 关键字冲突）。
 */
export function createTaskRepo(db: Database): TaskRepo {
  const crud = createCrud(db);
  const list = createList(db);
  const del = createDelete(db);
  const handoff = createHandoff(db);
  return {
    create: crud.create,
    get: crud.get,
    update: crud.update,
    list: list.list,
    delete: del.delete,
    reassignOwner: handoff.reassignOwner,
  };
}

/**
 * 默认 repo：每次方法调用懒拿 getDb()。模块加载时 getDb() 还没 init，
 * 所以不能 eager 构造；缓存到模块 closure，避免每次方法调用重建。
 */
let _defaultRepo: TaskRepo | null = null;
function defaultRepo(): TaskRepo {
  if (!_defaultRepo) _defaultRepo = createTaskRepo(getDb());
  return _defaultRepo;
}

export const taskRepo: TaskRepo = {
  create: (input) => defaultRepo().create(input),
  get: (id) => defaultRepo().get(id),
  list: (opts) => defaultRepo().list(opts),
  update: (id, patch) => defaultRepo().update(id, patch),
  delete: (id, opts) => defaultRepo().delete(id, opts),
  reassignOwner: (oldSid, newSid) => defaultRepo().reassignOwner(oldSid, newSid),
};
