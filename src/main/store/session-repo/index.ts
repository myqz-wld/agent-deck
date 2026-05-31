/**
 * sessionRepo facade —— sessions 表 CRUD + 跨表 rename + spawn 链路反查。
 *
 * 拆分历史（CHANGELOG_83 / plan deep-review-and-split-20260513 H2 Step 2.3）：
 *   原 src/main/store/session-repo.ts (590 行) 拆为：
 *   - index.ts (本文件，~85 行 facade)
 *   - types.ts (~95 行 Row + rowToRecord helper;原 parseGenericPtyConfigJson 已 P1.4 删)
 *   - core-crud.ts (~190 行 11 个 method：upsert / get / listActiveAndDormant /
 *     listHistory / _delete + 5 setter)
 *   - archive.ts (~22 行 setArchived 单独抽出，呼应「lifecycle 与 archived_at 正交」原则)
 *   - lifecycle.ts (~135 行 7 个 method：setLifecycle / setActivity /
 *     batchSetLifecycle / findActiveExpiring / findDormantExpiring /
 *     findHistoryOlderThan / batchDelete)
 *   - rename.ts (~110 行 跨表事务复杂迁移)
 *   - spawn-chain.ts (~70 行 3 个 MCP spawn 链路 method：
 *     getSpawnDepth / setSpawnLink / listChildren；listAncestors 已 REVIEW_88 删 dead code)
 *
 *   外部 caller import 路径不变（'@main/store/session-repo' 自动 resolve 到 index.ts）。
 *   sessionRepo 对象保持原 27 method surface（spread 自所有 sub-module）。
 */

import * as coreCrud from './core-crud';
import { setArchived, SessionRowMissingError } from './archive';
import * as lifecycle from './lifecycle';
import { rename } from './rename';
import * as spawnChain from './spawn-chain';

// 单独取 _delete 重命名为 delete（reserved word workaround）
const { _delete, ...coreRest } = coreCrud;

export const sessionRepo = {
  ...coreRest,
  delete: _delete,
  setArchived,
  ...lifecycle,
  rename,
  ...spawnChain,
};

/**
 * archive-toctou-fix-20260515 plan: re-export SessionRowMissingError from archive submodule
 * 让 caller (baton-cleanup.ts / sessions-hand-off-helper.ts / ipc/sessions.ts SessionArchive
 * handler) 通过 facade `import { SessionRowMissingError } from '@main/store/session-repo'`
 * 判别 setArchived no-op,不需深 import './archive'。
 */
export { SessionRowMissingError };
